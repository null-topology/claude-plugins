/**
 * SessionEnd: the session's tickets and masks end with it. The broker, if it
 * is running, forgets them; the session directory goes (board, marker,
 * last-seen, session.json). A resumed session starts with none. A broker
 * failure is logged (its code only) and never keeps the files.
 */

import { rmSync } from 'node:fs';
import { BrokerError } from '../mcp/broker-client.ts';
import { sessionDir } from '../paths.ts';
import { PROTOCOL_VERSION } from '../version.ts';
import { brokerAsk, BrokerFailure, END_SESSION_TIMEOUT_MS, type AskBroker } from './broker.ts';
import { liveSessionId, type HookContext, type HookOutput } from './common.ts';
import { logHookError } from './log.ts';

export async function sessionEnd(ctx: HookContext, ask: AskBroker = brokerAsk(ctx, END_SESSION_TIMEOUT_MS)): Promise<HookOutput | undefined> {
  const id = liveSessionId(ctx.input);
  if (id === undefined) return undefined;
  try {
    const answer = await ask({ v: PROTOCOL_VERSION, op: 'end_session', session: id });
    if (!answer.ok) throw new BrokerFailure(answer.code);
  } catch (err) {
    // A broker that is not running holds nothing of this session: not a
    // failure. Any other broker error (untrusted, closed, timeout, protocol)
    // or failure answer is logged; either way the files still go below.
    if (!(err instanceof BrokerError && err.code === 'unavailable')) logHookError(ctx.stateDir, 'SessionEnd', 'end-session', err);
  }
  try {
    rmSync(sessionDir(ctx.stateDir, id), { recursive: true, force: true });
  } catch (err) {
    logHookError(ctx.stateDir, 'SessionEnd', 'remove', err);
  }
  return undefined;
}
