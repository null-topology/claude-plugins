/**
 * PostToolUse, for Bash only: keeps the board (the command ends, or goes on
 * in the background) and, while the session's `masked` marker exists, has the
 * broker mask every delivered value in the command's output before the model
 * sees it. A board failure is logged on its own and the output is still
 * masked. Any other tool is ignored, whatever the matcher in hooks.json lets
 * through: its output is not masked.
 *
 * When masking fails (the broker cannot be reached, lacks the mask of a
 * ticket in the marker, as after a restart, or the marker cannot be read),
 * the output is withheld: every string becomes a note naming the tickets to
 * release (only those the broker lacks, so a live mask is never lifted; every
 * marker id when the broker cannot be reached), or, for a marker that cannot
 * be read, saying the output stays withheld until the session ends (release
 * cannot clear such a marker), or until the next redeem of a masked value
 * when the marker is only empty (the broker then writes its ticket id into
 * it), and the keys, booleans,
 * numbers and discriminators stay, so the replacement still matches the Bash
 * output schema (Claude Code drops an `updatedToolOutput` that does not).
 */

import { withholdDeep } from '../mask/masker.ts';
import { PROTOCOL_VERSION } from '../version.ts';
import { boardAfter } from './board-hooks.ts';
import { brokerAsk, BrokerFailure, type AskBroker } from './broker.ts';
import { maskedSession, type HookContext, type HookOutput } from './common.ts';
import { logHookError } from './log.ts';

export function withheldNote(tickets: readonly string[]): string {
  const which = tickets.length === 0 ? 'the tickets of this session' : tickets.join(', ');
  return `[1password-bridge: output withheld, masking failed; call release with ${which} to stop masking]`;
}

/**
 * The note for a marker that cannot be read: release cannot clear such a
 * marker, so it names no ticket. An empty marker becomes readable when the
 * broker marks the next masked value; any other stays until the session ends.
 */
export const UNREADABLE_MARKER_NOTE =
  '[1password-bridge: output withheld, the masking marker of this session cannot be read; the Bash output stays withheld until the session ends, or, when the marker is only empty, until the next redeem delivers a masked value]';

function replaced(updatedToolOutput: unknown): HookOutput {
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput } };
}

function withheld(ctx: HookContext, response: unknown, note: string): HookOutput {
  try {
    return replaced(withholdDeep(response, note));
  } catch (err) {
    // Only a response nested too deep to walk gets here. Its own shape is lost,
    // so the note goes into the fixed Bash output shape: a bare string would
    // not match the schema, and Claude Code would show the original instead.
    logHookError(ctx.stateDir, 'PostToolUse', 'withhold', err);
    return replaced({ stdout: note, stderr: note, interrupted: false, isImage: false });
  }
}

export async function postToolUse(ctx: HookContext, ask: AskBroker = brokerAsk(ctx)): Promise<HookOutput | undefined> {
  if (ctx.input['tool_name'] !== 'Bash') return undefined;
  try {
    boardAfter(ctx);
  } catch (err) {
    logHookError(ctx.stateDir, 'PostToolUse', 'board', err);
  }
  const masked = maskedSession(ctx);
  if (masked === undefined) return undefined;
  const response = ctx.input['tool_response'];
  if (masked.unreadable) {
    logHookError(ctx.stateDir, 'PostToolUse', 'marker', new Error('The masked marker cannot be read or holds no ticket id'));
    return withheld(ctx, response, UNREADABLE_MARKER_NOTE);
  }
  try {
    const answer = await ask({ v: PROTOCOL_VERSION, op: 'mask', session: masked.id, tickets: masked.tickets, output: response });
    // A failure answer (`displaced` included) or another op is a broker that cannot mask: withheld below, naming every marker id.
    if (!answer.ok) throw new BrokerFailure(answer.code);
    if (answer.op !== 'mask') throw new Error(`unexpected ${answer.op}`);
    // Only the tickets whose masks the broker lacks: releasing one it still holds would lift a live mask.
    if (!answer.known) return withheld(ctx, response, withheldNote(answer.missing));
    return answer.changed ? replaced(answer.output) : undefined;
  } catch (err) {
    // Every BrokerError (not running, untrusted, closed, timeout, protocol: an answer past MAX_OUTPUT_BYTES included)
    // and every BrokerFailure; the log records the broker's code.
    logHookError(ctx.stateDir, 'PostToolUse', 'mask', err);
    return withheld(ctx, response, withheldNote(masked.tickets));
  }
}
