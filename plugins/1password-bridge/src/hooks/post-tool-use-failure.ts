/**
 * PostToolUseFailure, for Bash only: a failed command's output cannot be
 * rewritten. A failed command leaves the board; a board failure is logged on
 * its own and the check still runs. While the session holds masks, the broker
 * checks the error text: the model is told which ticket's value it holds
 * (every ticket with more labels after masking than the error already
 * quoted), or that it may hold one, naming no ticket, when the check could
 * not run, the broker lacks a ticket's mask, or no ticket's labels grew. Any
 * other tool is ignored, whatever the matcher in hooks.json lets through.
 * Failed shell commands normally reach PostToolUse instead, through the exit
 * trap (bin/exit-trap.sh).
 */

import { PROTOCOL_VERSION } from '../version.ts';
import { boardFailed } from './board-hooks.ts';
import { brokerAsk, BrokerFailure, type AskBroker } from './broker.ts';
import { maskedSession, type HookContext, type HookOutput } from './common.ts';
import { logHookError } from './log.ts';

const MASK_LABEL = /<masked ticket=(tkt_[a-z2-7]{16})>/g;

/** How many mask labels `text` holds per ticket id, in order of first appearance. */
function labelCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(MASK_LABEL)) {
    const id = m[1] ?? '';
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export async function postToolUseFailure(ctx: HookContext, ask: AskBroker = brokerAsk(ctx)): Promise<HookOutput | undefined> {
  if (ctx.input['tool_name'] !== 'Bash') return undefined;
  try {
    boardFailed(ctx);
  } catch (err) {
    logHookError(ctx.stateDir, 'PostToolUseFailure', 'board', err);
  }
  const masked = maskedSession(ctx);
  if (masked === undefined) return undefined;
  const error = ctx.input['error'];
  if (typeof error !== 'string' || error === '') return undefined;
  let leaked: string[] | undefined;
  // An unreadable marker leaves the coverage unknown: only the warning is left.
  if (!masked.unreadable) {
    try {
      const answer = await ask({ v: PROTOCOL_VERSION, op: 'mask', session: masked.id, tickets: masked.tickets, output: error });
      // A failure answer (`displaced` included) is logged with its code; it and a broker lacking a mask leave the warning.
      if (!answer.ok) throw new BrokerFailure(answer.code);
      if (answer.op === 'mask' && answer.known) {
        if (!answer.changed) return undefined;
        // Masking keeps the labels the error already quoted, so a ticket's count grows only when one of
        // its values was masked. Known limit: a needle overlapping a quoted label breaks that label, so
        // its ticket's leak can go unnamed.
        const quoted = labelCounts(error);
        const added = [...labelCounts(String(answer.output))].filter(([id, n]) => n > (quoted.get(id) ?? 0)).map(([id]) => id);
        // A change that grows no ticket's count cannot be attributed: the warning, not an empty list.
        if (added.length > 0) leaked = added;
      }
    } catch (err) {
      logHookError(ctx.stateDir, 'PostToolUseFailure', 'scan', err);
    }
  }
  const additionalContext =
    leaked === undefined
      ? 'The failed output above may contain an unmasked secret value of this session, and no ticket could be named for it (failed Bash output cannot be rewritten). Do not repeat anything that looks like a secret; tell the user.'
      : `The failed output above contains the unmasked value of ticket ${leaked.join(', ')} (failed Bash output cannot be rewritten). Do not repeat it; tell the user it may need rotating.`;
  return { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext } };
}
