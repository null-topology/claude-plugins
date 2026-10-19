/**
 * Shapes shared by the session manager, which drives Kiro sessions, and the
 * session queries, which read runs from disk and from the live registry.
 */

import type { RunState } from '../store/runs.ts';

/** How a turn ended. */
export const TURN_OUTCOMES = Object.freeze([
  'end_turn',
  'refusal',
  'max_tokens',
  'max_turn_requests',
  'cancelled',
  'stopped',
  'error',
  'exited',
  'lost',
] as const);

export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

/** Set when this plugin ended the turn; such a result is never pushed. */
export const ENDED_BY = Object.freeze(['cancel', 'interrupt', 'stop'] as const);

export type EndedBy = (typeof ENDED_BY)[number];

/** The task result Kiro handed over with `complete_task`. */
export interface Completion {
  readonly result: string;
  /** UTC ISO 8601 with seconds: when the call's `completed` update was seen. */
  readonly at: string;
}

/** The content of `turns/<n>.json`. Absent values are null, never omitted. */
export interface TurnResult {
  readonly launchId: string;
  readonly sessionId: string;
  readonly label: string | null;
  readonly turn: number;
  readonly outcome: TurnOutcome;
  readonly endedBy: EndedBy | null;
  /** UTC ISO 8601 with seconds. */
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationS: number;
  readonly toolCalls: number;
  readonly lastTool: string | null;
  /** The `send_message` texts of the turn, redacted and cut (4.4). */
  readonly messages: readonly string[];
  /** Earlier messages not kept within the turn's total bound. */
  readonly messagesDropped: number;
  /** The first `complete_task` of the turn, redacted and cut, or null. */
  readonly completion: Completion | null;
  /** The text after the last tool call, cut keeping its end. */
  readonly final: string;
  readonly textChars: number;
  readonly truncated: boolean;
  /** Set for `error`, `exited` and `lost`. */
  readonly error: string | null;
  /** The last lines of `stderr.log`, for `error`, `exited` and `lost`. */
  readonly stderrTail: string | null;
}

/** Counters of the turn a live session is running now. */
export interface LiveTurn {
  readonly turn: number;
  readonly startedAt: string;
  readonly toolCalls: number;
  readonly lastTool: string | null;
}

/** What this server knows in memory about a session it drives. */
export interface LiveSession {
  readonly launchId: string;
  readonly state: RunState;
  readonly currentTurn: number;
  /** Null unless the state is `running`. */
  readonly runningTurn: LiveTurn | null;
  readonly permissionsAnswered: { readonly allowed: number; readonly denied: number };
}

/** The sessions this server process drives. */
export interface LiveRegistry {
  get(launchId: string): LiveSession | undefined;
  list(): readonly LiveSession[];
}
