/**
 * `<stateDir>/log/hook.log`: one JSON line per error a hook caught.
 *
 * A line holds a UTC time, the hook event, the step and an error code: a
 * Node.js error code such as `ENOENT`, a broker code upper-cased such as
 * `TIMEOUT` or `DISPLACED`, or the error's class name such as
 * `SyntaxError`. It never holds an error message, the hook input or a tool
 * output: a JSON parse error and a store error can both quote the text they
 * failed on, and that text may hold a granted value.
 *
 * Writing a line never throws, so a hook that cannot log still exits cleanly.
 * The file is cut back to nothing once it passes 1 MB.
 */

import { appendFileSync, chmodSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import type { BrokerErrorCode } from '../mcp/broker-client.ts';
import { FAILURE_CODES } from '../protocol.ts';
import { HOOK_EVENTS } from './common.ts';

export const MAX_HOOK_LOG_BYTES = 1024 * 1024;

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const STEP = /^[a-z][a-z-]{0,31}$/;

/** Every BrokerError code; a Record, so the compiler keeps it equal to BrokerErrorCode. */
const BROKER_ERROR_CODES: Record<BrokerErrorCode, true> = { unavailable: true, untrusted: true, closed: true, timeout: true, protocol: true };

/** The broker's own lower-case codes, logged upper-cased; any other lower-case code is never logged. */
const BROKER_CODES: ReadonlySet<string> = new Set<string>([...Object.keys(BROKER_ERROR_CODES), ...FAILURE_CODES]);

export function hookLogPath(stateDir: string): string {
  return join(stateDir, 'log', 'hook.log');
}

/**
 * A loggable code for `err`: its Node.js code; else a broker code (a
 * BrokerError's or a failure answer's), upper-cased; else its class name;
 * else `unknown`.
 */
export function errorCode(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && ERROR_CODE.test(code)) return code;
    if (typeof code === 'string' && BROKER_CODES.has(code)) return code.toUpperCase();
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && ERROR_NAME.test(name)) return name;
  }
  return 'unknown';
}

/** Appends one line for `err`; `event` is logged only when it is a known hook event. */
export function logHookError(stateDir: string, event: unknown, step: string, err: unknown, now: Date = new Date()): void {
  try {
    const line = {
      at: now.toISOString(),
      event: HOOK_EVENTS.includes(event as never) ? event : 'unknown',
      step: STEP.test(step) ? step : 'unknown',
      code: errorCode(err),
    };
    const path = hookLogPath(stateDir);
    mkdirSync(join(stateDir, 'log'), { recursive: true, mode: 0o700 });
    try {
      if (statSync(path).size > MAX_HOOK_LOG_BYTES) truncateSync(path, 0);
    } catch {
      // No log yet.
    }
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    // Logging is best effort.
  }
}
