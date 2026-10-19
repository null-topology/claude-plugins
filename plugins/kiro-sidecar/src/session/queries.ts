/**
 * The read side of the session layer: `wait`, `status` and `list` over the
 * runs on disk and the live registry. Each returns structured data; the tool
 * layer renders it as text.
 *
 * `wait` on an own run:
 *
 * - A turn that is running is claimed (`turns/<n>.claimed`) BEFORE its result
 *   is looked for, so the waiter cannot push a result that this call is about
 *   to return. The result is then polled for; the claim is released on every
 *   way out (result, timeout, abort, error).
 * - A returned result gets `turns/<n>.returned` before the call returns.
 * - An abort releases the claim and leaves the turn running.
 *
 * `wait` on a run that is not own (another owner of this home, or another
 * host) is read-only: it reads finished turns and writes nothing, neither a
 * claim nor `.returned`, so it never takes a delivery away from the owner. A
 * running turn of such a run is `E_BUSY`.
 *
 * A turn without a result in a run that is not running it (for example a
 * `lost` run whose result has not been written yet) is `E_NOT_FOUND`.
 */

import { readdir, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { SidecarError } from '../errors.ts';
import { errorCode } from '../store/files.ts';
import { runPaths, turnPaths } from '../store/paths.ts';
import { readTurnResult } from '../store/runs.ts';
import type { Mode } from '../settings.ts';
import type { RunState } from '../store/runs.ts';
import { InvalidInputError } from '../text/errors.ts';
import { fittedHead } from '../text/fit.ts';
import { formatResultLine } from '../text/format.ts';
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from '../text/limits.ts';
import { messagesBlockChars } from '../text/messages.ts';
import { readPage } from '../text/read.ts';
import type { Page } from '../text/read.ts';
import { resultBlockChars } from '../text/result-block.ts';
import { failureFieldsChars } from '../tools/render.ts';
import { markTurnReturned } from './claims.ts';
import type { ReleaseClaim } from './claims.ts';
import { resolveSession, scanVisibleRuns } from './resolve.ts';
import type { RunRelation, SessionScope, VisibleRun } from './resolve.ts';
import { parseTurnResult } from './turn-result.ts';
import type { Completion, LiveSession, TurnOutcome, TurnResult } from './types.ts';

export interface QueryDeps extends SessionScope {
  /** Takes the delivery claim of a turn of an own run; resolves to its release. */
  readonly claim: (launchId: string, turn: number) => Promise<ReleaseClaim>;
  /** The clock, in ms since the epoch. */
  readonly now?: (() => number) | undefined;
  /** How often `wait` looks for the result of a running turn. */
  readonly pollMs?: number | undefined;
  /** How often `wait` reports progress while it blocks. */
  readonly progressMs?: number | undefined;
}

export const WAIT_TIMEOUT_DEFAULT_S = 600;
export const WAIT_TIMEOUT_MAX_S = 3600;
export const WAIT_POLL_MS = 250;
export const WAIT_PROGRESS_MS = 30_000;
/** A waiter heartbeat younger than this counts as armed. */
export const WAITER_ARMED_MS = 10_000;

const HISTORY_STATES: readonly RunState[] = ['exited', 'stopped', 'completed', 'lost', 'failed'];

export interface WaitArgs {
  readonly session: unknown;
  readonly turn?: unknown;
  readonly timeout_s?: unknown;
  readonly offset?: unknown;
  readonly limit?: unknown;
}

/** The counters of a running turn; null when the live registry does not have them. */
export interface TurnCounters {
  readonly elapsedS: number | null;
  readonly toolCalls: number | null;
  readonly lastTool: string | null;
}

export interface WaitOptions {
  /** Aborts the wait: the claim is released and the turn keeps running. */
  readonly signal?: AbortSignal | undefined;
  /** Called every `progressMs` while the call blocks; a failure is ignored. */
  readonly onProgress?: ((progress: TurnCounters) => void | Promise<void>) | undefined;
}

export interface FinishedTurn {
  readonly state: 'finished';
  readonly launchId: string;
  readonly sessionId: string | null;
  readonly relation: RunRelation;
  readonly turn: number;
  readonly result: TurnResult;
  /** The messages the reply shows: the turn's on the page at offset 0, none on a later page. */
  readonly messages: readonly string[];
  /** The completion the reply shows: the turn's on the page at offset 0, none on a later page. */
  readonly completion: Completion | null;
  /** The page `[offset, nextOffset)` of the turn's text. */
  readonly text: string;
  readonly offset: number;
  /** Null when `text` reaches the end. */
  readonly nextOffset: number | null;
  readonly totalChars: number;
  /** The reply's last line: `kiro-result: <launchId>#<n>`. */
  readonly trailer: string;
}

/** A turn still running at the timeout; carries no trailer. */
export interface RunningTurn extends TurnCounters {
  readonly state: 'running';
  readonly launchId: string;
  readonly sessionId: string | null;
  readonly turn: number;
}

export type WaitResult = FinishedTurn | RunningTurn;

interface CheckedWaitArgs {
  readonly turn: number | undefined;
  readonly timeoutS: number;
  readonly offset: number;
  readonly limit: number;
}

function integerArg(
  field: string,
  value: unknown,
  min: number,
  max: number,
  rule: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new InvalidInputError(field, rule);
  }
  return value;
}

function checkWaitArgs(args: WaitArgs): CheckedWaitArgs {
  const max = Number.MAX_SAFE_INTEGER;
  return {
    turn: integerArg('turn', args.turn, 1, max, 'must be a positive integer'),
    timeoutS:
      integerArg(
        'timeout_s',
        args.timeout_s,
        1,
        WAIT_TIMEOUT_MAX_S,
        `must be an integer from 1 to ${WAIT_TIMEOUT_MAX_S}`,
      ) ?? WAIT_TIMEOUT_DEFAULT_S,
    offset: integerArg('offset', args.offset, 0, max, 'must be a non-negative integer') ?? 0,
    limit:
      integerArg(
        'limit',
        args.limit,
        1,
        PAGE_LIMIT_MAX,
        `must be an integer from 1 to ${PAGE_LIMIT_MAX}`,
      ) ?? PAGE_LIMIT_DEFAULT,
  };
}

/**
 * The validated result of a turn, or undefined while it has none. A file that
 * cannot be parsed or does not match the contract is `E_INTERNAL`.
 */
export async function readValidTurnResult(
  stateDir: string,
  launchId: string,
  turn: number,
): Promise<TurnResult | undefined> {
  let value: unknown;
  try {
    value = await readTurnResult(stateDir, launchId, turn);
    return value === undefined ? undefined : parseTurnResult(value, launchId, turn);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SidecarError(
      'E_INTERNAL',
      `turns/${turn}.json of ${launchId} is not a valid turn result: ${reason}`,
    );
  }
}

/**
 * A page of the turn's text: `turns/<n>.md`, else the streamed
 * `turns/<n>.md.part` (a turn whose driver died has no `.md`), else empty.
 */
function readTurnPage(
  stateDir: string,
  launchId: string,
  turn: number,
  offset: number,
  limit: number,
): Page {
  const paths = turnPaths(stateDir, launchId, turn);
  for (const path of [paths.text, paths.partial]) {
    try {
      return readPage(path, offset, limit);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw error;
      }
    }
  }
  if (offset > 0) {
    throw new InvalidInputError('offset', 'is past the end of the text (0 characters)');
  }
  return { text: '', offset: 0, nextOffset: null, totalChars: 0 };
}

function currentTurnOf(run: VisibleRun): number {
  return run.live?.currentTurn ?? run.meta.currentTurn;
}

function countersOf(live: LiveSession | undefined | null, turn: number, now: number): TurnCounters {
  const running = live?.runningTurn;
  if (running === null || running === undefined || running.turn !== turn) {
    return { elapsedS: null, toolCalls: null, lastTool: null };
  }
  const started = Date.parse(running.startedAt);
  return {
    elapsedS: Number.isNaN(started) ? null : Math.max(0, Math.floor((now - started) / 1000)),
    toolCalls: running.toolCalls,
    lastTool: running.lastTool,
  };
}

function isRunningTurn(run: VisibleRun, turn: number): boolean {
  if (run.live?.runningTurn?.turn === turn) {
    return true;
  }
  return turn === currentTurnOf(run) && (run.state === 'running' || run.state === 'starting');
}

async function finishedTurn(
  deps: QueryDeps,
  run: VisibleRun,
  turn: number,
  result: TurnResult,
  args: CheckedWaitArgs,
  signal: AbortSignal | undefined,
): Promise<FinishedTurn> {
  const messages = args.offset === 0 ? result.messages : [];
  const completion = args.offset === 0 ? result.completion : null;
  // Every page of a failed turn is shortened by its error and stderr tail as the JSON shows them, and the page that
  // shows the messages and the result by their blocks too, so the reply stays bounded (4.4).
  const shown = failureFieldsChars(result) + messagesBlockChars(messages) + resultBlockChars(completion?.result ?? null);
  const limit = Math.max(1, args.limit - shown);
  const page = readTurnPage(deps.stateDir, run.launchId, turn, args.offset, limit);
  // The limit holds the page as shown: neutralising can lengthen it, and the next page starts where it stops.
  const text = fittedHead(page.text, limit);
  const nextOffset = text.length < page.text.length ? page.offset + text.length : page.nextOffset;
  if (run.relation === 'own') {
    signal?.throwIfAborted();
    await markTurnReturned(deps.stateDir, run.launchId, turn, new Date((deps.now ?? Date.now)()));
  }
  return {
    state: 'finished',
    launchId: run.launchId,
    sessionId: run.meta.kiroSessionId ?? result.sessionId,
    relation: run.relation,
    turn,
    result,
    messages,
    completion,
    text,
    offset: page.offset,
    nextOffset,
    totalChars: page.totalChars,
    trailer: formatResultLine(run.launchId, turn),
  };
}

async function blockOnTurn(
  deps: QueryDeps,
  run: VisibleRun,
  turn: number,
  args: CheckedWaitArgs,
  options: WaitOptions,
): Promise<WaitResult> {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? WAIT_POLL_MS;
  const progressMs = deps.progressMs ?? WAIT_PROGRESS_MS;
  const { signal, onProgress } = options;
  const release = await deps.claim(run.launchId, turn);
  try {
    const startedAt = now();
    const deadline = startedAt + args.timeoutS * 1000;
    let nextProgress = startedAt + progressMs;
    for (;;) {
      const result = await readValidTurnResult(deps.stateDir, run.launchId, turn);
      if (result !== undefined) {
        return await finishedTurn(deps, run, turn, result, args, signal);
      }
      signal?.throwIfAborted();
      const time = now();
      if (time >= deadline) {
        return {
          state: 'running',
          launchId: run.launchId,
          sessionId: run.meta.kiroSessionId,
          turn,
          ...countersOf(deps.live.get(run.launchId), turn, time),
        };
      }
      if (time >= nextProgress) {
        nextProgress = time + progressMs;
        try {
          await onProgress?.(countersOf(deps.live.get(run.launchId), turn, time));
        } catch {
          // A progress report that fails does not end the wait.
        }
      }
      const pause = Math.max(1, Math.min(pollMs, deadline - time, nextProgress - time));
      await delay(pause, undefined, { signal });
    }
  } finally {
    await release();
  }
}

/** `wait {session, turn?, timeout_s?, offset?, limit?}` (see the module comment). */
export async function waitTurn(
  deps: QueryDeps,
  args: WaitArgs,
  options: WaitOptions = {},
): Promise<WaitResult> {
  const checked = checkWaitArgs(args);
  options.signal?.throwIfAborted();
  const run = await resolveSession(deps, args.session);
  const latest = currentTurnOf(run);
  if (latest === 0) {
    throw new InvalidInputError('session', `${run.launchId} has no turns`);
  }
  const turn = checked.turn ?? latest;
  if (turn > latest) {
    throw new SidecarError(
      'E_NOT_FOUND',
      `Turn ${turn} of ${run.launchId} does not exist; the latest is ${latest}`,
    );
  }
  const running = isRunningTurn(run, turn);
  if (run.relation === 'own' && running) {
    return blockOnTurn(deps, run, turn, checked, options);
  }
  const result = await readValidTurnResult(deps.stateDir, run.launchId, turn);
  if (result !== undefined) {
    return finishedTurn(deps, run, turn, result, checked, options.signal);
  }
  if (running) {
    throw new SidecarError(
      'E_BUSY',
      `Turn ${turn} of ${run.launchId} is still running; wait reads only finished turns ` +
        'of a session owned by another process',
    );
  }
  throw new SidecarError(
    'E_NOT_FOUND',
    `Turn ${turn} of ${run.launchId} has no result; the session is ${run.state}`,
  );
}

/** Fields every session entry carries. */
export interface SessionSummary {
  readonly launchId: string;
  /** The Kiro session id; null until Kiro has answered. */
  readonly sessionId: string | null;
  readonly label: string | null;
  readonly mode: Mode;
  readonly dir: string;
  readonly home: string;
  readonly state: RunState;
  readonly relation: RunRelation;
  /** The driver's host id for an `other-host` run, else null. */
  readonly host: string | null;
}

function summaryOf(run: VisibleRun): SessionSummary {
  const { meta } = run;
  return {
    launchId: run.launchId,
    sessionId: meta.kiroSessionId,
    label: meta.label,
    mode: meta.mode,
    dir: meta.dir,
    home: meta.home,
    state: run.state,
    relation: run.relation,
    host: run.relation === 'other-host' ? meta.driver.hostId : null,
  };
}

export interface StatusArgs {
  readonly session?: unknown;
}

export interface SessionStatus extends SessionSummary, TurnCounters {
  readonly currentTurn: number;
  /** Null unless this server drives the session. */
  readonly permissionsAnswered: { readonly allowed: number; readonly denied: number } | null;
  /** The current turn's `.armed` heartbeat is younger than 10 s. */
  readonly waiterArmed: boolean;
  /** Finished turns with neither `.pushed` nor `.returned`, ascending. */
  readonly undelivered: readonly number[];
}

async function turnFiles(stateDir: string, launchId: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(runPaths(stateDir, launchId).turns));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return new Set();
    }
    throw error;
  }
}

function undeliveredTurns(files: ReadonlySet<string>): number[] {
  const turns: number[] = [];
  for (const name of files) {
    const match = /^([1-9][0-9]*)\.json$/.exec(name);
    const turn = match?.[1];
    if (turn !== undefined && !files.has(`${turn}.pushed`) && !files.has(`${turn}.returned`)) {
      turns.push(Number(turn));
    }
  }
  return turns.sort((a, b) => a - b);
}

async function isWaiterArmed(
  stateDir: string,
  launchId: string,
  turn: number,
  now: number,
): Promise<boolean> {
  if (turn < 1) {
    return false;
  }
  try {
    const { mtimeMs } = await stat(turnPaths(stateDir, launchId, turn).armed);
    return now - mtimeMs < WAITER_ARMED_MS;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function statusOf(deps: QueryDeps, run: VisibleRun): Promise<SessionStatus> {
  const now = (deps.now ?? Date.now)();
  const currentTurn = currentTurnOf(run);
  const running = run.live?.runningTurn;
  const counters =
    running === null || running === undefined
      ? { elapsedS: null, toolCalls: null, lastTool: null }
      : countersOf(run.live, running.turn, now);
  const files = await turnFiles(deps.stateDir, run.launchId);
  const answered = run.live?.permissionsAnswered;
  return {
    ...summaryOf(run),
    currentTurn,
    ...counters,
    permissionsAnswered:
      answered === undefined ? null : { allowed: answered.allowed, denied: answered.denied },
    waiterArmed: await isWaiterArmed(deps.stateDir, run.launchId, currentTurn, now),
    undelivered: undeliveredTurns(files),
  };
}

/**
 * `status {session?}`: the named session (own, or read-only another one of
 * this home), else every own session. Never carries turn text.
 */
export async function sessionStatus(
  deps: QueryDeps,
  args: StatusArgs = {},
): Promise<SessionStatus[]> {
  if (args.session !== undefined) {
    return [await statusOf(deps, await resolveSession(deps, args.session))];
  }
  const own = (await scanVisibleRuns(deps)).filter((run) => run.relation === 'own');
  return Promise.all(own.map((run) => statusOf(deps, run)));
}

export interface ListArgs {
  readonly history?: unknown;
}

export interface LastTurn {
  readonly n: number;
  /** Null while the turn has no result, or when its result is invalid. */
  readonly outcome: TurnOutcome | null;
  readonly endedAt: string | null;
  /** Why the turn's result file was not trusted, else null. */
  readonly invalid: string | null;
}

export interface SessionListing extends SessionSummary {
  /** Null before the first turn. */
  readonly lastTurn: LastTurn | null;
  /** False for every session, with or without `history`: resume is not available in this version. */
  readonly resumable: boolean;
}

async function lastTurnOf(stateDir: string, run: VisibleRun): Promise<LastTurn | null> {
  const n = currentTurnOf(run);
  if (n === 0) {
    return null;
  }
  try {
    const result = await readValidTurnResult(stateDir, run.launchId, n);
    return {
      n,
      outcome: result?.outcome ?? null,
      endedAt: result?.endedAt ?? null,
      invalid: null,
    };
  } catch (error) {
    if (error instanceof SidecarError) {
      return { n, outcome: null, endedAt: null, invalid: error.message };
    }
    throw error;
  }
}

/**
 * `list {history?}`: the own sessions; with `history: true` also the home's
 * other sessions in a history state (`exited`, `stopped`, `completed`,
 * `lost`, `failed`)
 * and every record of this home driven from another host, whose state cannot
 * be judged here. Own sessions come first, each group oldest first.
 */
export async function listSessions(
  deps: QueryDeps,
  args: ListArgs = {},
): Promise<SessionListing[]> {
  if (args.history !== undefined && typeof args.history !== 'boolean') {
    throw new InvalidInputError('history', 'must be a boolean');
  }
  const history = args.history === true;
  const runs = await scanVisibleRuns(deps);
  const own = runs.filter((run) => run.relation === 'own');
  const others = history
    ? runs.filter(
        (run) =>
          run.relation === 'other-host' ||
          (run.relation === 'same-home' && HISTORY_STATES.includes(run.state)),
      )
    : [];
  return Promise.all(
    [...own, ...others].map(async (run) => ({
      ...summaryOf(run),
      lastTurn: await lastTurnOf(deps.stateDir, run),
      resumable: false,
    })),
  );
}
