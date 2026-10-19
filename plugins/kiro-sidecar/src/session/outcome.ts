/**
 * How a turn ended, mapped to its result outcome (4.4).
 *
 * - `end_turn`, `refusal`, `max_tokens`, `max_turn_requests`: the same outcome.
 * - `cancelled` after this plugin's cancel, interrupt or stop: `cancelled`, or
 *   `stopped` for a stop, with `endedBy`; any other `cancelled` stays
 *   `cancelled` with no `endedBy`.
 * - A rejected prompt or an ACP error: `error`. An oversized message also kills
 *   the stream, so the session ends `exited` with an `error` outcome.
 * - The process exited or the stream closed during the turn: `exited`; after
 *   this plugin asked for a stop (stdin closed, then a kill): `stopped`.
 */

import { AcpClientError } from '../acp/errors.ts';
import type { EndedBy, TurnOutcome } from './types.ts';

/** What `session/prompt` settled with. */
export type TurnEnding =
  | { readonly kind: 'stop'; readonly stopReason: string }
  | { readonly kind: 'failure'; readonly error: unknown };

export interface OutcomeDecision {
  readonly outcome: TurnOutcome;
  readonly endedBy: EndedBy | null;
  /** Why the turn failed, before redaction; null unless the outcome is `error` or `exited`. */
  readonly error: string | null;
}

const PASSED_THROUGH: ReadonlySet<string> = new Set(['end_turn', 'refusal', 'max_tokens', 'max_turn_requests']);

/**
 * The outcome of a turn. `requested` is the end this plugin asked for (cancel,
 * interrupt or stop) while the turn ran, or null.
 */
export function decideOutcome(ending: TurnEnding, requested: EndedBy | null): OutcomeDecision {
  if (ending.kind === 'stop') {
    const { stopReason } = ending;
    if (PASSED_THROUGH.has(stopReason)) {
      return { outcome: stopReason as TurnOutcome, endedBy: null, error: null };
    }
    if (stopReason === 'cancelled') {
      if (requested === null) {
        return { outcome: 'cancelled', endedBy: null, error: null };
      }
      return { outcome: requested === 'stop' ? 'stopped' : 'cancelled', endedBy: requested, error: null };
    }
    return { outcome: 'error', endedBy: null, error: `Kiro ended the turn with an unknown stop reason ${JSON.stringify(stopReason)}` };
  }
  const { error } = ending;
  if (error instanceof AcpClientError && error.code === 'closed') {
    // A stop closes stdin, then kills: Kiro exits on its own or is terminated.
    if (requested === 'stop' && error.closeReason !== 'message_too_large') {
      return { outcome: 'stopped', endedBy: 'stop', error: null };
    }
    if (error.closeReason === 'message_too_large') {
      return { outcome: 'error', endedBy: null, error: describeError(error) };
    }
    return { outcome: 'exited', endedBy: null, error: describeError(error) };
  }
  return { outcome: 'error', endedBy: null, error: describeError(error) };
}

/** A one-line description of an error, before redaction. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const data = (error as { data?: unknown }).data;
    let text = error.message;
    if (typeof code === 'number') {
      text = `${text} (code ${code})`;
    }
    if (data !== undefined && data !== null) {
      text = `${text}: ${JSON.stringify(data)}`;
    }
    return text;
  }
  return String(error);
}
