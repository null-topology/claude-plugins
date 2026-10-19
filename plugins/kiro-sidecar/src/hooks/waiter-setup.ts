/**
 * The first steps of the waiter, run once when a start or send call ends:
 *
 * 1. read the PostToolUse input and find the turn the call opened (`turn.ts`);
 *    an input whose session id, agent id, agent type or tool use id the
 *    hook's secret set would redact is a skip, before anything is written;
 * 2. check the run's owner against the key of this hook's parent process: a
 *    hook in exec form is a direct child of the Claude process, which is the
 *    owner of every run its server starts;
 * 3. append the Claude session id, with the agent type of a subagent, to the
 *    run's `claude-sessions.jsonl`.
 *
 * Every way out other than a found turn is a skip with its step and reason,
 * logged as one line in `$STATE/hooks.log`; nothing here throws. Every path
 * comes from `paths.ts`, built from ids that passed their patterns.
 */

import type { Readable } from 'node:stream';
import { isoSeconds } from '../session/claims.ts';
import type { Environment } from '../settings.ts';
import { currentOwner, ownerKey } from '../store/identity.ts';
import type { ProcessIdentity } from '../store/identity.ts';
import { isValidToolUseId, resolveStateDir } from '../store/paths.ts';
import { appendClaudeSession, readMeta } from '../store/runs.ts';
import type { RunMeta } from '../store/runs.ts';
import { parsePostToolUseInput, readHookInput } from './input.ts';
import type { InputSkipReason } from './input.ts';
import { appendHookLog } from './log.ts';
import type { HookLogIds, HookStep } from './log.ts';
import { SYSTEM_CLOCK, findTurn } from './turn.ts';
import type { CallWaitOptions, PollClock, TurnSkipReason } from './turn.ts';
import { redactionChanges, waiterSecrets } from './waiter-loop.ts';

export type WaiterSkipReason =
  | InputSkipReason
  /** An id of the input holds a secret; the line carries no ids. */
  | 'input-secret'
  | TurnSkipReason
  | 'run-not-found'
  | 'meta-unreadable'
  | 'owner-unknown'
  | 'owner-mismatch'
  | 'error';

/** A turn of an own run, with the Claude session already recorded on it. */
export interface WaiterTurn {
  readonly kind: 'turn';
  readonly stateDir: string;
  readonly launchId: string;
  readonly turn: number;
  /** Where the turn was found: the reply's trailer or the `calls/` record. */
  readonly source: 'trailer' | 'call';
  readonly run: RunMeta;
  /** The hook's `session_id`; for a subagent's call, the main conversation's. */
  readonly sessionId: string;
  readonly agentType: string | null;
  readonly agentId: string | null;
  /** The hook's `tool_use_id` when it matched the id pattern, else null. */
  readonly toolUseId: string | null;
}

export interface WaiterSkip {
  readonly kind: 'skip';
  readonly step: HookStep;
  readonly reason: WaiterSkipReason;
}

export type WaiterSetup = WaiterTurn | WaiterSkip;

export interface WaiterSetupOptions {
  /** The hook input; stdin by default. */
  readonly stdin?: Readable;
  /** Read for the secret set, and for the state directory when none is given; `process.env` by default. */
  readonly env?: Environment;
  /** Resolved from `env` as the server resolves it by default. */
  readonly stateDir?: string;
  /** The process that owns this hook's runs; the parent process by default. */
  readonly owner?: () => Promise<ProcessIdentity>;
  readonly clock?: PollClock;
  readonly maxInputBytes?: number;
  readonly callWait?: CallWaitOptions;
}

const TOOL_EVENT_PATTERN = /__(start|send)$/;

/** The event of a session line: `start` or `send` after the tool's name, else `post_tool_use`. */
export function sessionEvent(toolName: string | null): string {
  return (toolName === null ? undefined : TOOL_EVENT_PATTERN.exec(toolName)?.[1]) ?? 'post_tool_use';
}

/** Runs steps 1 to 3; see the module comment. */
export async function setUpWaiter(options: WaiterSetupOptions = {}): Promise<WaiterSetup> {
  const clock = options.clock ?? SYSTEM_CLOCK;
  let stateDir: string;
  try {
    stateDir = options.stateDir ?? resolveStateDir(options.env ?? process.env);
  } catch {
    // Without a state directory there is nowhere to log.
    return { kind: 'skip', step: 'input', reason: 'error' };
  }

  let ids: HookLogIds = {};
  let step: HookStep = 'input';
  const log = (logStep: HookStep, reason: string, error?: unknown): Promise<void> =>
    appendHookLog(
      stateDir,
      { hook: 'waiter', step: logStep, reason, ...ids, ...(error === undefined ? {} : { error }) },
      new Date(clock.now()),
    );
  const skip = async (
    skipStep: HookStep,
    reason: WaiterSkipReason,
    error?: unknown,
  ): Promise<WaiterSkip> => {
    await log(skipStep, reason, error);
    return { kind: 'skip', step: skipStep, reason };
  };

  try {
    // Built before anything is written, as the ids are checked against it.
    const secrets = waiterSecrets(options.env ?? process.env);
    const read = await readHookInput(options.stdin ?? process.stdin, options.maxInputBytes);
    if (read.kind === 'skip') {
      return await skip('input', read.reason, read.error);
    }
    const parsed = parsePostToolUseInput(read.value);
    if (parsed.kind === 'skip') {
      return await skip('input', parsed.reason);
    }
    const { input } = parsed;
    if (redactionChanges(secrets, [input.sessionId, input.agentId, input.agentType, input.toolUseId])) {
      return await skip('input', 'input-secret');
    }
    const toolUseId =
      input.toolUseId !== null && isValidToolUseId(input.toolUseId) ? input.toolUseId : null;
    ids = {
      sessionId: input.sessionId,
      ...(input.agentId === null ? {} : { agentId: input.agentId }),
      ...(toolUseId === null ? {} : { toolUseId }),
    };
    if (input.agentTypeDropped) {
      await log('input', 'agent-type-invalid');
    }

    step = 'turn';
    const found = await findTurn(stateDir, input.responseText, input.toolUseId, clock, options.callWait);
    if (found.kind === 'skip') {
      return await skip('turn', found.reason, found.error);
    }
    const { launchId, turn } = found.ref;
    ids = { ...ids, launchId, turn };

    step = 'owner';
    let run: RunMeta | undefined;
    try {
      run = await readMeta(stateDir, launchId);
    } catch (error) {
      return await skip('owner', 'meta-unreadable', error);
    }
    if (run === undefined) {
      return await skip('owner', 'run-not-found');
    }
    if (run.launchId !== launchId) {
      return await skip('owner', 'meta-unreadable');
    }
    let key: string;
    try {
      key = ownerKey(await (options.owner ?? currentOwner)());
    } catch (error) {
      return await skip('owner', 'owner-unknown', error);
    }
    if (key !== run.ownerKey) {
      return await skip('owner', 'owner-mismatch');
    }

    step = 'session';
    try {
      await appendClaudeSession(stateDir, launchId, {
        id: input.sessionId,
        event: sessionEvent(input.toolName),
        at: isoSeconds(new Date(clock.now())),
        ...(input.agentType === null ? {} : { agentType: input.agentType }),
      });
    } catch (error) {
      // The turn can still be delivered without this line.
      await log('session', 'session-log-failed', error);
    }

    return {
      kind: 'turn',
      stateDir,
      launchId,
      turn,
      source: found.source,
      run,
      sessionId: input.sessionId,
      agentType: input.agentType,
      agentId: input.agentId,
      toolUseId,
    };
  } catch (error) {
    return skip(step, 'error', error);
  }
}
