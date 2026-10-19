/**
 * `$STATE/hooks.log`: one JSON line per event a hook could not act on.
 *
 * A line holds a UTC time, the hook, the step and a fixed reason, plus ids
 * that passed their pattern and a Node.js error code. It never holds hook
 * input text, tool text, a prompt or an error message (a JSON parse error
 * quotes the input it failed on). A hook input id is logged only once the
 * hook has found that its secret set would leave every id of the input
 * unchanged; an input it would change ends the hook with an `input-secret`
 * line that carries no ids. So nothing in a line needs redaction.
 *
 * Writing a line never throws: a hook that cannot log still exits cleanly.
 *
 * The startup sweep bounds the log: it renames `hooks.log` to `hooks.log.1`
 * and deletes `hooks.log.1` by size and age. A hook that opened the log
 * before the rename writes its line into `hooks.log.1`; the next line goes to
 * a new `hooks.log`.
 */

import { join } from 'node:path';
import { isoSeconds } from '../session/claims.ts';
import { appendJsonLine, ensureDir, errorCode } from '../store/files.ts';

export const HOOKS_LOG_NAME = 'hooks.log';

export type HookName = 'waiter' | 'context';

/** The hook step that decided: reading the input, finding the turn, the owner check, the session log. */
export type HookStep = 'input' | 'turn' | 'owner' | 'session';

/** Ids a line may carry; each must already have passed its own pattern. */
export interface HookLogIds {
  readonly launchId?: string;
  readonly turn?: number;
  readonly toolUseId?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
}

export interface HookLogEntry extends HookLogIds {
  readonly hook: HookName;
  readonly step: HookStep;
  readonly reason: string;
  /** The error behind the reason, when there was one; only its code is logged. */
  readonly error?: unknown;
}

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

export function hooksLogPath(stateDir: string): string {
  return join(stateDir, HOOKS_LOG_NAME);
}

/** The one earlier generation of `hooks.log` the startup sweep keeps. */
export function rotatedHooksLogPath(stateDir: string): string {
  return `${hooksLogPath(stateDir)}.1`;
}

/** The line written for an entry at time `at`. */
export function hookLogLine(entry: HookLogEntry, at: Date): Record<string, unknown> {
  const { hook, step, reason, launchId, turn, toolUseId, sessionId, agentId, error } = entry;
  const code = error === undefined ? undefined : errorCode(error);
  return {
    at: isoSeconds(at),
    hook,
    step,
    reason,
    ...(launchId === undefined ? {} : { launchId }),
    ...(turn === undefined ? {} : { turn }),
    ...(toolUseId === undefined ? {} : { toolUseId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(code !== undefined && ERROR_CODE_PATTERN.test(code) ? { code } : {}),
  };
}

/** Appends one line to `$STATE/hooks.log`, creating the state directory if needed. */
export async function appendHookLog(
  stateDir: string,
  entry: HookLogEntry,
  at: Date = new Date(),
): Promise<void> {
  try {
    await ensureDir(stateDir);
    await appendJsonLine(hooksLogPath(stateDir), hookLogLine(entry, at));
  } catch {
    // Logging is best effort.
  }
}
