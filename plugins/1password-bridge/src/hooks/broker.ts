/**
 * The hooks' broker call: a running broker only, never one started from a
 * hook. A broker that is not running holds no masks and no tickets, which
 * the handlers treat as "masking failed" or "nothing to forget".
 *
 * This module may import the protocol and the broker client, never
 * `src/broker/`: every hook run loads it.
 */

import { requestRunning } from '../mcp/broker-client.ts';
import { MAX_OUTPUT_BYTES, type FailureCode, type Request, type Response } from '../protocol.ts';
import type { HookContext } from './common.ts';

export type AskBroker = (req: Request) => Promise<Response>;

/** A failure answer (`displaced`, `internal`, ...) as an error, so the hook log records its code. */
export class BrokerFailure extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode) {
    super(`The 1password-bridge broker answered ${code}.`);
    this.name = 'BrokerFailure';
    this.code = code;
  }
}

/**
 * Below the hook timeouts in hooks/hooks.json (PostToolUse 15 s,
 * PostToolUseFailure 10 s), so a slow broker withholds instead of letting
 * Claude Code time the hook out.
 */
export const HOOK_BROKER_TIMEOUT_MS = 8000;
/** SessionEnd only asks the broker to forget; the file cleanup must not wait long behind it. */
export const END_SESSION_TIMEOUT_MS = 2000;

export function brokerAsk(ctx: HookContext, timeoutMs: number = HOOK_BROKER_TIMEOUT_MS): AskBroker {
  return (req) => requestRunning(req, { stateDir: ctx.stateDir, env: ctx.env, timeoutMs, maxBytes: MAX_OUTPUT_BYTES });
}
