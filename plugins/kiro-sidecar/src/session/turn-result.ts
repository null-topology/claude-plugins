/**
 * Validation of a turn result read from `turns/<n>.json`. A file that does
 * not match the contract is reported, never passed on. Also builds the
 * result of a turn that ended because its driving server is gone.
 */

import { isLaunchId } from '../store/paths.ts';
import type { RunMeta } from '../store/runs.ts';
import { isoSeconds } from './claims.ts';
import { ENDED_BY, TURN_OUTCOMES } from './types.ts';
import type { Completion, TurnResult } from './types.ts';

type Check = (value: unknown) => boolean;

const isString: Check = (value) => typeof value === 'string';
const isBoolean: Check = (value) => typeof value === 'boolean';
const isCount: Check = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isPositiveCount: Check = (value) => isCount(value) && (value as number) >= 1;
const isDuration: Check = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isOneOf =
  (allowed: readonly string[]): Check =>
  (value) =>
    typeof value === 'string' && allowed.includes(value);
const isNullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const isStrings: Check = (value) => Array.isArray(value) && value.every(isString);
const isCompletion: Check = (value) =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  isString((value as Record<string, unknown>)['result']) &&
  isString((value as Record<string, unknown>)['at']);

const RESULT_FIELDS: { readonly [K in keyof TurnResult]-?: Check } = {
  launchId: (value) => typeof value === 'string' && isLaunchId(value),
  sessionId: isString,
  label: isNullable(isString),
  turn: isPositiveCount,
  outcome: isOneOf(TURN_OUTCOMES),
  endedBy: isNullable(isOneOf(ENDED_BY)),
  startedAt: isString,
  endedAt: isString,
  durationS: isDuration,
  toolCalls: isCount,
  lastTool: isNullable(isString),
  messages: isStrings,
  messagesDropped: isCount,
  completion: isNullable(isCompletion),
  final: isString,
  textChars: isCount,
  truncated: isBoolean,
  error: isNullable(isString),
  stderrTail: isNullable(isString),
};

/** What a result written before these fields existed reads as (4.4). */
const LEGACY_DEFAULTS: { readonly [K in keyof TurnResult]?: TurnResult[K] } = {
  messages: [],
  messagesDropped: 0,
  completion: null,
};

/** A copy of a checked field value, so the result shares no array or object with the file. */
function copyField(field: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    return [...(value as string[])];
  }
  if (field === 'completion' && value !== null) {
    const { result, at } = value as Completion;
    return { result, at };
  }
  return value;
}

/**
 * Checks every field of a parsed turn result and that it belongs to the
 * expected run and turn. Returns a copy holding only the contract's fields;
 * throws naming the first bad field. A field of `LEGACY_DEFAULTS` that is
 * missing reads as its default; a field outside the contract, such as the
 * `questions` of an older result, is ignored.
 */
export function parseTurnResult(value: unknown, launchId: string, turn: number): TurnResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('not an object');
  }
  const record = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const [field, check] of Object.entries(RESULT_FIELDS)) {
    const fieldValue = Object.hasOwn(LEGACY_DEFAULTS, field) && !Object.hasOwn(record, field)
      ? LEGACY_DEFAULTS[field as keyof TurnResult]
      : record[field];
    if (!check(fieldValue)) {
      throw new Error(`bad field ${field}`);
    }
    copy[field] = copyField(field, fieldValue);
  }
  if (record.launchId !== launchId) {
    throw new Error(`launchId ${String(record.launchId)} is not ${launchId}`);
  }
  if (record.turn !== turn) {
    throw new Error(`turn ${String(record.turn)} is not ${turn}`);
  }
  return copy as unknown as TurnResult;
}

/** The error of a turn whose driving server is gone. */
export const LOST_ERROR = 'The server driving this session is gone; the turn ended without a result';

/** The error of a turn adopted by its owner's new server: the Kiro process went with the old one. */
export const ADOPTED_ERROR =
  'The server driving this session was restarted and its Kiro process is gone; the turn ended without a result';

/** The error of a turn its server ended by shutting down: the Kiro process was stopped with it. */
export const SHUTDOWN_ERROR = 'The server shut down during the turn and stopped its Kiro process';

export interface EndedWithoutResult {
  readonly outcome: 'exited' | 'lost';
  readonly error: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
  /** The last lines of the run's `stderr.log`, or null. */
  readonly stderrTail: string | null;
}

/**
 * The result of a turn that ended without an answer from Kiro, because the
 * server driving it is gone: the waiter's and the startup sweep's `lost`,
 * and the sweep's `exited` for a session its owner's new server adopts.
 */
export function endedWithoutResult(
  run: Pick<RunMeta, 'launchId' | 'kiroSessionId' | 'label'>,
  turn: number,
  ending: EndedWithoutResult,
): TurnResult {
  const { startedAt, endedAt } = ending;
  return {
    launchId: run.launchId,
    sessionId: run.kiroSessionId ?? '',
    label: run.label,
    turn,
    outcome: ending.outcome,
    endedBy: null,
    startedAt: isoSeconds(startedAt),
    endedAt: isoSeconds(endedAt),
    durationS: Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)),
    toolCalls: 0,
    lastTool: null,
    messages: [],
    messagesDropped: 0,
    completion: null,
    final: '',
    textChars: 0,
    truncated: false,
    error: ending.error,
    stderrTail: ending.stderrTail,
  };
}
