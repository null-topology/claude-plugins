/**
 * The turn a start or send call opened, as a hook finds it.
 *
 * The reply's last line is the trailer `kiro-turn: <launchId>#<n>`; nothing
 * else in the reply is read, so text inside it cannot name a turn. Without a
 * trailer (the call was moved to the background before it replied, or it
 * failed) the turn comes from the call's `calls/<toolUseId>.json`, read every
 * 2 s for up to 120 s: the server writes that record before any slow step.
 * A record that failed, or that names no turn (a start without a prompt),
 * gives no turn.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { isValidToolUseId } from '../store/paths.ts';
import { readCall } from '../store/runs.ts';
import { LAUNCH_ID_PATTERN } from '../text/format.ts';

export const CALL_POLL_INTERVAL_MS = 2_000;
export const CALL_WAIT_MS = 120_000;

const TRAILER_PREFIX = 'kiro-turn:';
const TRAILER_PATTERN = /^kiro-turn: ([^#\s]*)#([0-9]+)$/;

export interface TurnRef {
  readonly launchId: string;
  /** Counted from 1. */
  readonly turn: number;
}

/** Time for polling; tests pass a fake one. */
export interface PollClock {
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export const SYSTEM_CLOCK: PollClock = {
  now: () => Date.now(),
  sleep: (ms) => delay(ms),
};

export type TrailerParse =
  | { readonly kind: 'trailer'; readonly ref: TurnRef }
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' };

/** The last line of `text`; one line break at the very end does not count as a line. */
export function lastLine(text: string): string {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const line = body.slice(body.lastIndexOf('\n') + 1);
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * The trailer on the last line of a reply. `absent` when that line does not
 * start with `kiro-turn:`; `invalid` when it does but is not exactly
 * `kiro-turn: <launchId>#<n>` with a valid launch id and a positive safe
 * integer `n` written without leading zeros.
 */
export function parseTurnTrailer(text: string): TrailerParse {
  const line = lastLine(text);
  if (!line.startsWith(TRAILER_PREFIX)) {
    return { kind: 'absent' };
  }
  const match = TRAILER_PATTERN.exec(line);
  const launchId = match?.[1];
  const digits = match?.[2];
  if (
    launchId === undefined ||
    digits === undefined ||
    !LAUNCH_ID_PATTERN.test(launchId) ||
    digits.startsWith('0')
  ) {
    return { kind: 'invalid' };
  }
  const turn = Number(digits);
  if (!Number.isSafeInteger(turn)) {
    return { kind: 'invalid' };
  }
  return { kind: 'trailer', ref: { launchId, turn } };
}

export type CallSkipReason =
  | 'tool-use-id-invalid'
  | 'call-not-found'
  | 'call-unreadable'
  | 'call-failed'
  | 'no-turn';

export type CallLookup =
  | { readonly kind: 'call'; readonly ref: TurnRef }
  | { readonly kind: 'skip'; readonly reason: CallSkipReason; readonly error?: unknown };

export interface CallWaitOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

/**
 * The turn in `calls/<toolUseId>.json`, read now and then every interval
 * until the timeout. An id that does not match the tool use id pattern is
 * refused before any file is touched.
 */
export async function waitForCallTurn(
  stateDir: string,
  toolUseId: string | null,
  clock: PollClock = SYSTEM_CLOCK,
  options: CallWaitOptions = {},
): Promise<CallLookup> {
  if (toolUseId === null || !isValidToolUseId(toolUseId)) {
    return { kind: 'skip', reason: 'tool-use-id-invalid' };
  }
  const intervalMs = options.intervalMs ?? CALL_POLL_INTERVAL_MS;
  const deadline = clock.now() + (options.timeoutMs ?? CALL_WAIT_MS);
  for (;;) {
    let record: Awaited<ReturnType<typeof readCall>>;
    try {
      record = await readCall(stateDir, toolUseId);
    } catch (error) {
      return { kind: 'skip', reason: 'call-unreadable', error };
    }
    if (record !== undefined) {
      if ('failed' in record) {
        return { kind: 'skip', reason: 'call-failed' };
      }
      if (record.turn === null) {
        return { kind: 'skip', reason: 'no-turn' };
      }
      return { kind: 'call', ref: { launchId: record.launchId, turn: record.turn } };
    }
    const remaining = deadline - clock.now();
    if (remaining <= 0) {
      return { kind: 'skip', reason: 'call-not-found' };
    }
    await clock.sleep(Math.min(intervalMs, remaining));
  }
}

export type TurnSkipReason = 'trailer-invalid' | CallSkipReason;

export type TurnLookup =
  | { readonly kind: 'turn'; readonly ref: TurnRef; readonly source: 'trailer' | 'call' }
  | { readonly kind: 'skip'; readonly reason: TurnSkipReason; readonly error?: unknown };

/**
 * The turn of a call: from the trailer of its reply text, else from its
 * `calls/` record. A malformed trailer gives no turn; the record is not read
 * then.
 */
export async function findTurn(
  stateDir: string,
  responseText: string | null,
  toolUseId: string | null,
  clock: PollClock = SYSTEM_CLOCK,
  options: CallWaitOptions = {},
): Promise<TurnLookup> {
  if (responseText !== null) {
    const trailer = parseTurnTrailer(responseText);
    if (trailer.kind === 'trailer') {
      return { kind: 'turn', ref: trailer.ref, source: 'trailer' };
    }
    if (trailer.kind === 'invalid') {
      return { kind: 'skip', reason: 'trailer-invalid' };
    }
  }
  const call = await waitForCallTurn(stateDir, toolUseId, clock, options);
  return call.kind === 'call' ? { kind: 'turn', ref: call.ref, source: 'call' } : call;
}
