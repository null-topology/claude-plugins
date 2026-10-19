/**
 * Line formats shared by tool replies and hooks, and the label rule.
 */

import { InvalidInputError } from './errors.ts';
import { LABEL_MAX_CHARS } from './limits.ts';

export const LAUNCH_ID_PATTERN = /^ks_[0-9a-f]{12}$/;
export const LABEL_PATTERN = new RegExp(`^[A-Za-z0-9._-]{1,${LABEL_MAX_CHARS}}$`);

function turnRef(launchId: string, turn: number): string {
  if (!LAUNCH_ID_PATTERN.test(launchId)) {
    throw new RangeError('launchId must match ks_ followed by 12 lowercase hex digits');
  }
  if (!Number.isSafeInteger(turn) || turn < 1) {
    throw new RangeError(`turn must be a positive integer, got ${String(turn)}`);
  }
  return `${launchId}#${turn}`;
}

/** The trailer that ends a reply which opened a turn: `kiro-turn: <launchId>#<n>`. */
export function formatTurnTrailer(launchId: string, turn: number): string {
  return `kiro-turn: ${turnRef(launchId, turn)}`;
}

/** The line that ends a reply carrying a turn result: `kiro-result: <launchId>#<n>`. */
export function formatResultLine(launchId: string, turn: number): string {
  return `kiro-result: ${turnRef(launchId, turn)}`;
}

/** A label is 1 to 40 characters from A-Z, a-z, 0-9, `.`, `_` and `-`. */
export function isValidLabel(value: unknown): value is string {
  return typeof value === 'string' && LABEL_PATTERN.test(value);
}

/** Throws `InvalidInputError` for `label` unless `value` is a valid label. */
export function assertLabel(value: unknown): asserts value is string {
  if (!isValidLabel(value)) {
    throw new InvalidInputError(
      'label',
      `must be 1 to ${LABEL_MAX_CHARS} characters from A-Z, a-z, 0-9, ".", "_" and "-"`,
    );
  }
}
