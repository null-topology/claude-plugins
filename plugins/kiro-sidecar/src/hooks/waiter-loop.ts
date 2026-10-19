/**
 * Step 4 of the waiter: polls the turn it found until the turn can be
 * delivered, and decides how the hook exits.
 *
 * Every poll, in order:
 *
 * 1. Refreshes `turns/<n>.armed`; its mtime is the heartbeat `status` reads.
 * 2. The owner (the Claude process of `meta.ownerKey`) is dead: exit 0. A
 *    push to a gone Claude would mark the turn delivered without delivering
 *    it, so no `.pushed` is written.
 * 3. Reads `turns/<n>.json`. Absent, the turn can no longer come when the
 *    call record it was found in has been rewritten failed, when the run is
 *    gone (`stop {purge}`) or when its state is `failed`: exit 0, without a
 *    wake. A record or `meta.json` that cannot be read does not end the loop.
 *    Absent while the driver is dead on this host: a turn the run never opened
 *    (`meta.currentTurn` below it) exits 0 without a result or a wake; else
 *    creates it once with outcome `lost`; an existing result wins. A driver
 *    on another host never makes `lost`. `meta.json` is never written.
 * 4. A result: unreadable or invalid, or with `endedBy`: exit 0. With
 *    `.claimed`: keep polling (the claiming call returns the result or
 *    removes the claim). Then with `.returned`: exit 0; `.claimed` is looked
 *    at first because a call writes `.returned` before it removes its claim.
 *    Else the wake message is built, then `.pushed` is created once (another
 *    waiter that created it first has pushed: exit 0) and the message is the
 *    outcome, exit 2. A message that cannot be built is `internal`, exit 0,
 *    without `.pushed`.
 * 5. The deadline, counted from the waiter's start, has passed: the expired
 *    notice, exit 2, without `.pushed`, also while `.claimed` exists (the
 *    claiming call can still end without the result).
 *
 * Each outcome is logged as one `hooks.log` line; so are a `lost` result the
 * waiter created, the first heartbeat that failed and secrets that could not
 * be built (the wake text is then redacted with none). The loop never throws:
 * an unexpected error is logged as `internal` with its code only, exit 0.
 */

import { stat, utimes, writeFile } from 'node:fs/promises';
import { TOKEN_VARIABLE } from '../docker/cli.ts';
import { isoSeconds } from '../session/claims.ts';
import { LOST_ERROR, endedWithoutResult, parseTurnResult } from '../session/turn-result.ts';
import type { TurnResult } from '../session/types.ts';
import { envName } from '../settings.ts';
import type { Environment } from '../settings.ts';
import { FILE_MODE, createJsonOnce, errorCode } from '../store/files.ts';
import { liveness as processLiveness, parseOwnerKey } from '../store/identity.ts';
import type { Liveness, ProcessIdentity } from '../store/identity.ts';
import { runPaths, turnPaths } from '../store/paths.ts';
import { createTurnResult, readCall, readMeta, readTurnResult } from '../store/runs.ts';
import type { RunMeta } from '../store/runs.ts';
import { stderrTail } from '../text/read.ts';
import { SecretSet, buildSecretSet } from '../text/redact.ts';
import { appendHookLog } from './log.ts';
import type { HookLogIds, HookStep } from './log.ts';
import { SYSTEM_CLOCK } from './turn.ts';
import type { PollClock } from './turn.ts';
import type { WaiterTurn } from './waiter-setup.ts';
import { buildExpiredNotice, buildWakeMessage } from './wake.ts';
import type { Redactor } from './wake.ts';

/** How often the waiter looks at the turn. */
export const WAITER_POLL_INTERVAL_MS = 2_000;

/** The `error` of a `lost` result the waiter creates. */
export { LOST_ERROR };

/** Why the waiter exits, as logged. */
export type WaiterExitReason =
  | 'pushed'
  | 'expired'
  | 'owner-gone'
  | 'owner-key-invalid'
  | 'ended-by'
  | 'returned'
  | 'pushed-elsewhere'
  | 'result-unreadable'
  | 'result-invalid'
  /** The call record the turn was found in was rewritten failed: the turn was never opened. */
  | 'call-failed'
  /** The run directory is gone (`stop {purge}`). */
  | 'run-gone'
  /** The run's state is `failed` and the turn has no result. */
  | 'run-failed'
  /** The driver is dead and the run never opened the turn: no `lost` result. */
  | 'never-opened'
  | 'internal'
  /** Stopped by a signal before the push began; the signal is logged by whoever stopped it. */
  | 'stopped';

export interface WaiterOutcome {
  readonly exitCode: 0 | 2;
  readonly reason: WaiterExitReason;
  /** The text for stderr: the wake message or the expired notice; null with exit 0. */
  readonly wake: string | null;
}

export interface WaiterLoopOptions {
  /** How long the waiter may wait, counted from `startedAt`. */
  readonly deadlineMs: number;
  readonly clock?: PollClock;
  /** When the waiter started, by `clock`; the time of the call by default. */
  readonly startedAt?: number;
  readonly liveness?: (identity: ProcessIdentity) => Promise<Liveness>;
  /** The secrets the wake text is redacted with; built from `env` by default. */
  readonly secrets?: () => Redactor;
  /** The waiter's environment; default `process.env`. */
  readonly env?: Environment;
  /**
   * Asked right before `.pushed` is created, after the wake message is built.
   * False (the waiter is stopping) ends the loop without a push and without
   * a log line: exit 0, `stopped`. True commits the waiter to the push.
   */
  readonly beginPush?: () => boolean;
}

/** The api key option as Claude Code exports it to hook processes. */
const HOOK_API_KEY_VARIABLE = 'CLAUDE_PLUGIN_OPTION_API_KEY';

/**
 * The secrets of a hook's environment, built as the server builds the
 * secrets of its replies: the api key option a hook gets, the api key
 * setting and `KIRO_API_KEY` as given, the messaging token, the proxy URLs
 * and the proxy setting option a hook gets. The keys are not checked as Kiro tokens: a short one is still a
 * secret, and building the set never fails on one.
 */
export function waiterSecrets(env: Environment): SecretSet {
  return buildSecretSet({
    env,
    kiroKeys: [env[HOOK_API_KEY_VARIABLE] ?? '', env[envName('api_key')] ?? '', env[TOKEN_VARIABLE] ?? ''],
  });
}

/**
 * True when redacting any of `ids` with `secrets` would change it; null ids
 * are left out. A hook input id it would change is never written.
 */
export function redactionChanges(secrets: Redactor, ids: readonly (string | null)[]): boolean {
  return ids.some((id) => id !== null && secrets.redact(id) !== id);
}

/** The ids of the turn's `hooks.log` lines, as step 1 logged them. */
export function turnLogIds(turn: WaiterTurn): HookLogIds {
  return {
    sessionId: turn.sessionId,
    ...(turn.agentId === null ? {} : { agentId: turn.agentId }),
    ...(turn.toolUseId === null ? {} : { toolUseId: turn.toolUseId }),
    launchId: turn.launchId,
    turn: turn.turn,
  };
}

const DEADLINE_ARG = '--deadline-s';
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

/** The deadline in seconds from the waiter's arguments, `--deadline-s <n>`; null when invalid. */
export function parseDeadlineArg(args: readonly string[]): number | null {
  if (args.length !== 2 || args[0] !== DEADLINE_ARG) {
    return null;
  }
  const value = args[1] ?? '';
  if (!POSITIVE_INTEGER_PATTERN.test(value)) {
    return null;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds * 1000) ? seconds : null;
}

/** A `lost` result for a turn whose driver is gone, in the `TurnResult` shape. */
export function lostResult(
  run: RunMeta,
  turn: number,
  startedAt: Date,
  endedAt: Date,
  tail: string | null,
): TurnResult {
  return endedWithoutResult(run, turn, { outcome: 'lost', error: LOST_ERROR, startedAt, endedAt, stderrTail: tail });
}

async function markerExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** Polls the turn until it is delivered, ended elsewhere or out of time; see the module comment. */
export async function pollTurn(turn: WaiterTurn, options: WaiterLoopOptions): Promise<WaiterOutcome> {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const startedAt = options.startedAt ?? clock.now();
  const liveness = options.liveness ?? processLiveness;
  const { stateDir, launchId, run } = turn;
  const paths = turnPaths(stateDir, launchId, turn.turn);
  const ids = turnLogIds(turn);
  let armedFailed = false;

  const log = (step: HookStep, reason: string, error?: unknown): Promise<void> =>
    appendHookLog(
      stateDir,
      { hook: 'waiter', step, reason, ...ids, ...(error === undefined ? {} : { error }) },
      new Date(clock.now()),
    );
  const exit = async (
    step: HookStep,
    reason: WaiterExitReason,
    error?: unknown,
  ): Promise<WaiterOutcome> => {
    await log(step, reason, error);
    return { exitCode: 0, reason, wake: null };
  };
  const wake = async (reason: 'pushed' | 'expired', text: string): Promise<WaiterOutcome> => {
    await log('turn', reason);
    return { exitCode: 2, reason, wake: text };
  };

  const refreshArmed = async (): Promise<void> => {
    const at = new Date(clock.now());
    try {
      await writeFile(paths.armed, '', { mode: FILE_MODE });
      await utimes(paths.armed, at, at);
    } catch (error) {
      // A missing heartbeat only makes `status` report the turn as not armed.
      if (!armedFailed) {
        armedFailed = true;
        await log('turn', 'armed-failed', error);
      }
    }
  };

  // The freshest label and Kiro id; the meta step 2 read when it cannot be read again.
  const freshRun = async (): Promise<RunMeta> => {
    try {
      const meta = await readMeta(stateDir, launchId);
      return meta !== undefined && meta.launchId === launchId ? meta : run;
    } catch {
      return run;
    }
  };

  const secrets = async (): Promise<Redactor> => {
    try {
      return (options.secrets ?? (() => waiterSecrets(options.env ?? process.env)))();
    } catch (error) {
      // The stored text was redacted by the server already.
      await log('turn', 'secrets-invalid', error);
      return new SecretSet();
    }
  };

  /** Creates the `lost` result once; null when another writer created a result first. */
  const createLost = async (): Promise<TurnResult | null> => {
    let tail: string | null;
    try {
      tail = stderrTail(runPaths(stateDir, launchId).stderrLog);
    } catch {
      tail = null;
    }
    const lost = lostResult(run, turn.turn, new Date(startedAt), new Date(clock.now()), tail);
    if (!(await createTurnResult(stateDir, launchId, turn.turn, lost))) {
      return null;
    }
    await log('turn', 'lost-created');
    return lost;
  };

  const readStored = async (): Promise<{ readonly value: unknown } | { readonly error: unknown }> => {
    try {
      return { value: await readTurnResult(stateDir, launchId, turn.turn) };
    } catch (error) {
      return { error };
    }
  };

  /** Why a turn without a result can no longer come; null while it still can. */
  const cannotCome = async (): Promise<'call-failed' | 'run-gone' | 'run-failed' | null> => {
    if (turn.source === 'call' && turn.toolUseId !== null) {
      try {
        const call = await readCall(stateDir, turn.toolUseId);
        if (call !== undefined && 'failed' in call) {
          return 'call-failed';
        }
      } catch {
        // An unreadable record says nothing about the turn.
      }
    }
    let meta: RunMeta | undefined;
    try {
      meta = await readMeta(stateDir, launchId);
    } catch {
      return null;
    }
    if (meta === undefined) {
      return 'run-gone';
    }
    return meta.launchId === launchId && meta.state === 'failed' ? 'run-failed' : null;
  };

  /**
   * Whether a dead driver left the turn unopened. Read after the liveness
   * check, so the meta is the driver's last; unreadable says no.
   */
  const neverOpened = async (): Promise<boolean> => {
    try {
      const meta = await readMeta(stateDir, launchId);
      return meta !== undefined && meta.launchId === launchId && meta.currentTurn < turn.turn;
    } catch {
      return false;
    }
  };

  const push = async (result: TurnResult): Promise<WaiterOutcome> => {
    // Built before `.pushed`: a text that cannot be built must not mark the turn delivered.
    const text = buildWakeMessage({
      run: await freshRun(),
      result,
      agentType: turn.agentType,
      secrets: await secrets(),
    });
    if (options.beginPush?.() === false) {
      return { exitCode: 0, reason: 'stopped', wake: null };
    }
    const marked = await createJsonOnce(paths.pushed, {
      sessionId: turn.sessionId,
      at: isoSeconds(new Date(clock.now())),
    });
    if (!marked) {
      return exit('turn', 'pushed-elsewhere');
    }
    return wake('pushed', text);
  };

  try {
    const owner = parseOwnerKey(run.ownerKey);
    if (owner === null) {
      return await exit('owner', 'owner-key-invalid');
    }
    for (;;) {
      await refreshArmed();
      if ((await liveness(owner)) === 'dead') {
        return await exit('owner', 'owner-gone');
      }

      let read = await readStored();
      if ('value' in read && read.value === undefined) {
        // Looked at before `lost`: a turn that was never opened, or a purged run, gets no result.
        const ended = await cannotCome();
        if (ended !== null) {
          return await exit('turn', ended);
        }
        if ((await liveness(run.driver)) === 'dead') {
          if (await neverOpened()) {
            return await exit('turn', 'never-opened');
          }
          const lost = await createLost();
          read = lost === null ? await readStored() : { value: lost };
        }
      }
      if ('error' in read) {
        return await exit('turn', 'result-unreadable', read.error);
      }
      const stored = read.value;
      if (stored !== undefined) {
        let result: TurnResult;
        try {
          result = parseTurnResult(stored, launchId, turn.turn);
        } catch {
          return await exit('turn', 'result-invalid');
        }
        if (result.endedBy !== null) {
          return await exit('turn', 'ended-by');
        }
        // `.claimed` first: a call writes `.returned` before it drops its
        // claim, so once the claim is gone a returned result shows.
        if (!(await markerExists(paths.claimed))) {
          if (await markerExists(paths.returned)) {
            return await exit('turn', 'returned');
          }
          return await push(result);
        }
      }

      const remaining = startedAt + options.deadlineMs - clock.now();
      if (remaining <= 0) {
        const text = buildExpiredNotice({
          run: await freshRun(),
          turn: turn.turn,
          agentType: turn.agentType,
          secrets: await secrets(),
        });
        return await wake('expired', text);
      }
      await clock.sleep(Math.min(WAITER_POLL_INTERVAL_MS, remaining));
    }
  } catch (error) {
    return exit('turn', 'internal', error);
  }
}
