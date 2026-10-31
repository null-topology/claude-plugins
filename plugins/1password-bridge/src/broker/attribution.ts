/**
 * Attribution of a `redeem` to an agent through the session's board.
 *
 * A command of another agent that names the ticket refuses at once. The
 * redeem is attributed only while every live entry of the session is the
 * owner's and there is at least one: a literal ticket id never attributes on
 * its own, since it does not prove which process called `redeem`. Otherwise
 * the board is read again every 500 ms for up to 30 s.
 */

import type { LiveEntry } from '../board.ts';
import type { Clock } from './pool.ts';

export const RECHECK_MS = 500;
export const ATTRIBUTION_WAIT_MS = 30_000;

export interface AttributedCommand {
  command: string;
  cwd: string;
  /** The command names the ticket id literally. */
  literal: boolean;
}

export type Attribution =
  | { kind: 'attributed'; commands: AttributedCommand[] }
  | { kind: 'refused'; code: 'not_owner' }
  | { kind: 'pending'; code: 'other_agent' | 'no_command' };

export function attribute(entries: readonly LiveEntry[], owner: string, ticket: string): Attribution {
  if (entries.some((e) => e.agent_id !== owner && e.command.includes(ticket))) return { kind: 'refused', code: 'not_owner' };
  if (entries.some((e) => e.agent_id !== owner)) return { kind: 'pending', code: 'other_agent' };
  if (entries.length === 0) return { kind: 'pending', code: 'no_command' };
  const commands = entries.map((e) => ({ command: e.command, cwd: e.cwd, literal: e.command.includes(ticket) }));
  // Stable sort: the commands naming the ticket first, each group in board order.
  commands.sort((a, b) => Number(b.literal) - Number(a.literal));
  return { kind: 'attributed', commands };
}

function sleep(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clock.clearTimeout(handle);
      resolve();
    };
    const handle = clock.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** `attribute` until it is not pending or `waitMs` has passed; null when `signal` aborts first. */
export async function attributeWaiting(
  read: () => readonly LiveEntry[],
  owner: string,
  ticket: string,
  clock: Clock,
  signal: AbortSignal,
  waitMs: number = ATTRIBUTION_WAIT_MS,
  everyMs: number = RECHECK_MS,
): Promise<Attribution | null> {
  const deadline = clock.now() + waitMs;
  for (;;) {
    if (signal.aborted) return null;
    const result = attribute(read(), owner, ticket);
    const left = deadline - clock.now();
    if (result.kind !== 'pending' || left <= 0) return result;
    await sleep(clock, Math.min(everyMs, left), signal);
  }
}
