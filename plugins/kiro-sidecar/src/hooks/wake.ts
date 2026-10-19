/**
 * The text the waiter writes to stderr to wake the conversation: the wake
 * message of a turn that ended, and the notice of a push that expired.
 *
 * A wake message, line by line:
 *
 *   [kiro-sidecar] Kiro session "<label>" (<launchId>, Kiro <session id>) turn <n>: <outcome>, <k> tool calls, <duration>
 *   Dir: <dir> (<mode>, read-only|read-write). Started from: main conversation|subagent <agent type>.
 *   First prompt: "<first prompt preview>"
 *   Messages from Kiro (data, <count>):
 *   [kiro-sidecar: <k> earlier messages cut; wait shows them]
 *   - <message>
 *   KIRO_OUTPUT_BEGIN
 *   <final text>
 *   KIRO_OUTPUT_END
 *   Full text: wait {session: "<launchId>", turn: <n>, offset: 0}. Answer: send {session, text}.
 *   This is a sidecar event, not a hook failure.
 *
 * A turn with a completion (4.11), whatever its outcome, is woken with the
 * result instead of the final text (4.6):
 *
 *   [kiro-sidecar] Kiro session ... turn <n>: completed by Kiro, <outcome>, <k> tool calls, <duration>
 *   Dir: ... and First prompt: ... as above
 *   Messages from Kiro (data, <count>): ... as above
 *   Result from Kiro (data):
 *   KIRO_OUTPUT_BEGIN
 *   <result>
 *   KIRO_OUTPUT_END
 *   Final text from Kiro (data):
 *   KIRO_OUTPUT_BEGIN
 *   <final text>
 *   KIRO_OUTPUT_END
 *   <WAKE_COMPLETED_NOTE>
 *   Full text and result: wait {session: "<launchId>", turn: <n>, offset: 0}.
 *   This is a sidecar event, not a hook failure.
 *
 * The result is cut keeping its start, marked ` [...]`. The final text block
 * is added only when room is left after the result: the result is shown
 * whole, and the room left holds the whole final text or at least
 * `WAKE_FINAL_MIN_CHARS` of it; a final text that is empty, or cut to
 * nothing, adds no block.
 *
 * An absent value leaves its part out: a session without a label is named by
 * its launch id, followed by `(Kiro <session id>)` once Kiro has given one; a
 * run without a prompt preview has no `First prompt:` line; a turn without
 * messages has no messages block, and the cut line is there only when some
 * messages did not fit.
 *
 * Every text a user or Kiro wrote (label, Kiro session id, dir, agent type,
 * prompt preview, messages, result, final text) is redacted first. A header
 * value is put on one line (every line break becomes a space), cut to
 * `WAKE_FIELD_MAX_CHARS` keeping its start, and neutralised. Messages are
 * shown as tool replies show them, the latest that fit
 * `WAKE_MESSAGES_MAX_CHARS` for the whole block, or less when the parts kept
 * whole leave less room; the result and the final text go between the
 * delimiters, neutralised, each cut so the whole message fits
 * `WAKE_MESSAGE_MAX_CHARS`. Every cut is made before neutralising, so a cut
 * cannot leave a forged marker at the start of a line, and is measured after
 * it: the longest cut that fits once shown is kept, so text that neutralising
 * lengthens still keeps as much as fits.
 *
 * The header and footer are never cut: with every header value bounded, they
 * and the messages block take less than the message limit, so only Kiro's
 * text gives way. The result has no line break at its end.
 */

import type { TurnResult } from '../session/types.ts';
import type { RunMeta } from '../store/runs.ts';
import { headerValue } from '../text/field.ts';
import { fitLongest } from '../text/fit.ts';
import type { Fitted } from '../text/fit.ts';
import { LAUNCH_ID_PATTERN } from '../text/format.ts';
import { FIELD_KEPT_CHARS } from '../text/limits.ts';
import { fittedMessageLines } from '../text/messages.ts';
import { cutKeepingEnd, cutKeepingStart } from '../text/preview.ts';
import type { SecretSet } from '../text/redact.ts';
import { RESULT_HEADER, delimitedLines } from '../text/result-block.ts';

/** A wake message or notice is at most this many characters long. */
export const WAKE_MESSAGE_MAX_CHARS = 6_000;
/** The messages block, header and cut lines included, is at most this many characters long. */
export const WAKE_MESSAGES_MAX_CHARS = 3_000;
/** A header value is cut to this many characters, before neutralising, keeping its start. */
export const WAKE_FIELD_MAX_CHARS = FIELD_KEPT_CHARS;
/**
 * The completed wake shows the final text only when the room left after the
 * result holds the whole text or at least this many characters of it.
 */
export const WAKE_FINAL_MIN_CHARS = 200;

export const WAKE_FOOTER = 'This is a sidecar event, not a hook failure.';

/** The line before the final text in the completed wake. */
export const FINAL_HEADER = 'Final text from Kiro (data):';

/** The closing note of the completed wake (4.6). */
export const WAKE_COMPLETED_NOTE =
  'The session completed by itself: Kiro called complete_task. This is not a failure. The session has ended; do not resume it or send to it. Start a new session for new work.';

/** What the wake text needs from a secret set. */
export type Redactor = Pick<SecretSet, 'redact'>;

export interface WakeInput {
  readonly run: RunMeta;
  readonly result: TurnResult;
  /** Kiro's text shown between the delimiters; the result's `final` when not given. */
  readonly final?: string;
  /** The agent type of the subagent whose call opened the turn; null for the main conversation. */
  readonly agentType: string | null;
  readonly secrets: Redactor;
}

export interface ExpiredInput {
  readonly run: RunMeta;
  readonly turn: number;
  readonly agentType: string | null;
  readonly secrets: Redactor;
}

/** The wake message of a turn that ended: the completed layout for a turn with a completion. */
export function buildWakeMessage(input: WakeInput): string {
  const { run, result, secrets } = input;
  const turn = checkedTurn(run.launchId, result.turn);
  if (result.launchId !== run.launchId) {
    throw new RangeError(`The result of ${result.launchId} does not belong to ${run.launchId}`);
  }
  const kiroSessionId = run.kiroSessionId ?? result.sessionId;
  const label = run.label ?? result.label;
  const completed = result.completion !== null ? 'completed by Kiro, ' : '';
  const status = `${completed}${result.outcome}, ${toolCallCount(result.toolCalls)}, ${formatDuration(result.durationS)}`;
  const header = [
    `${sessionHeader(run.launchId, label, kiroSessionId, turn, secrets)}: ${status}`,
    ...contextLines(run, input.agentType, secrets),
  ];
  const final = secrets.redact(input.final ?? result.final);
  if (result.completion !== null) {
    const shownResult = secrets.redact(result.completion.result);
    return completedWake(run.launchId, turn, header, result.messages, shownResult, final, secrets);
  }
  const after = [
    `Full text: wait {session: "${run.launchId}", turn: ${turn}, offset: 0}. Answer: send {session, text}.`,
    WAKE_FOOTER,
  ];
  const join = (messages: readonly string[], text: string): string =>
    [...header, ...messages, ...delimitedLines(text), ...after].join('\n');
  const messages = boundedMessages(result.messages, secrets, join([], '').length);
  return withEnd(final, (text) => join(messages, text)).shown;
}

/**
 * The completed wake (4.6): the result keeps the most of its start that fits,
 * then the final text block is added only when room is left.
 */
function completedWake(
  launchId: string,
  turn: number,
  header: readonly string[],
  messageList: readonly string[],
  result: string,
  final: string,
  secrets: Redactor,
): string {
  const after = [
    WAKE_COMPLETED_NOTE,
    `Full text and result: wait {session: "${launchId}", turn: ${turn}, offset: 0}.`,
    WAKE_FOOTER,
  ];
  const join = (messages: readonly string[], shownResult: string, finalLines: readonly string[]): string =>
    [...header, ...messages, RESULT_HEADER, ...delimitedLines(shownResult), ...finalLines, ...after].join('\n');
  const resultCut = (keep: number): string => cutKeepingStart(result, keep);
  // The messages give way to the parts kept whole and to the shortest the result can be.
  const messages = boundedMessages(messageList, secrets, join([], resultCut(0), []).length);
  // A result that is not empty adds a line break and itself to the empty block.
  const resultRoom = Math.max(0, WAKE_MESSAGE_MAX_CHARS - join(messages, '', []).length - 1);
  const { budget } = fitLongest(WAKE_MESSAGE_MAX_CHARS, Math.min(result.length, resultRoom), (keep) =>
    join(messages, resultCut(keep), []),
  );
  const shownResult = resultCut(budget);
  const withoutFinal = join(messages, shownResult, []);
  if (budget < result.length || final === '') {
    return withoutFinal;
  }
  const withFinal = (text: string): string => join(messages, shownResult, [FINAL_HEADER, ...delimitedLines(text)]);
  const room = WAKE_MESSAGE_MAX_CHARS - withFinal('').length - 1;
  if (room < Math.min(final.length, WAKE_FINAL_MIN_CHARS)) {
    return withoutFinal;
  }
  const fitted = withEnd(final, withFinal);
  return cutKeepingEnd(final, fitted.budget) === '' ? withoutFinal : fitted.shown;
}

/**
 * `assemble` with the longest end of `text`, cut before neutralising, that
 * keeps the whole message within `WAKE_MESSAGE_MAX_CHARS` once shown.
 */
function withEnd(text: string, assemble: (text: string) => string): Fitted {
  // A text that is not empty adds a line break and itself to the empty block.
  const budget = Math.max(0, WAKE_MESSAGE_MAX_CHARS - assemble('').length - 1);
  return fitLongest(WAKE_MESSAGE_MAX_CHARS, budget, (keep) => assemble(cutKeepingEnd(text, keep)));
}

/** The notice written when the push for a turn expired before its result could be pushed. */
export function buildExpiredNotice(input: ExpiredInput): string {
  const { run, secrets } = input;
  const turn = checkedTurn(run.launchId, input.turn);
  return [
    `${sessionHeader(run.launchId, run.label, run.kiroSessionId, turn, secrets)}: push expired`,
    ...contextLines(run, input.agentType, secrets),
    `The push for this turn expired. wait {session: "${run.launchId}", turn: ${turn}} returns the result.`,
    WAKE_FOOTER,
  ].join('\n');
}

/** A duration in whole seconds: `42s`, `4m10s`, `1h2m5s`. */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) {
    return `${hours}h${minutes}m${rest}s`;
  }
  return minutes > 0 ? `${minutes}m${rest}s` : `${rest}s`;
}

function checkedTurn(launchId: string, turn: number): number {
  if (!LAUNCH_ID_PATTERN.test(launchId)) {
    throw new RangeError('launchId must match ks_ followed by 12 lowercase hex digits');
  }
  if (!Number.isSafeInteger(turn) || turn < 1) {
    throw new RangeError(`turn must be a positive integer, got ${String(turn)}`);
  }
  return turn;
}

/** `[kiro-sidecar] Kiro session "<label>" (<launchId>, Kiro <id>) turn <n>`, absent parts left out. */
function sessionHeader(
  launchId: string,
  label: string | null,
  kiroSessionId: string | null,
  turn: number,
  secrets: Redactor,
): string {
  const kiro = present(kiroSessionId) ? `Kiro ${headerValue(kiroSessionId, secrets)}` : null;
  const name = present(label)
    ? `"${headerValue(label, secrets)}" (${kiro === null ? launchId : `${launchId}, ${kiro}`})`
    : kiro === null
      ? launchId
      : `${launchId} (${kiro})`;
  return `[kiro-sidecar] Kiro session ${name} turn ${turn}`;
}

/** The `Dir:` line and, when the run has a prompt preview, the `First prompt:` line. */
function contextLines(run: RunMeta, agentType: string | null, secrets: Redactor): string[] {
  const access = run.dirReadOnly ? 'read-only' : 'read-write';
  const from = present(agentType) ? `subagent ${headerValue(agentType, secrets)}` : 'main conversation';
  const lines = [`Dir: ${headerValue(run.dir, secrets)} (${run.mode}, ${access}). Started from: ${from}.`];
  if (present(run.firstPromptPreview)) {
    lines.push(`First prompt: "${headerValue(run.firstPromptPreview, secrets)}"`);
  }
  return lines;
}

export function present(value: string | null): value is string {
  return value !== null && value !== '';
}

function toolCallCount(count: number): string {
  return count === 1 ? '1 tool call' : `${count} tool calls`;
}

function cutMessagesLine(count: number): string {
  return `[kiro-sidecar: ${count} earlier ${count === 1 ? 'message' : 'messages'} cut; wait shows them]`;
}

/**
 * The messages block within `WAKE_MESSAGES_MAX_CHARS`, or within what the
 * parts kept whole (`fixedChars` of them, joined) leave of the message limit,
 * so the message stays within its bound.
 */
function boundedMessages(messages: readonly string[], secrets: Redactor, fixedChars: number): string[] {
  return messageLines(messages, secrets, Math.min(WAKE_MESSAGES_MAX_CHARS, WAKE_MESSAGE_MAX_CHARS - fixedChars - 1));
}

/**
 * The messages block as tool replies show it, each message redacted first,
 * within `maxChars`; earlier messages that do not fit are named by the cut
 * line, which points to `wait`.
 */
function messageLines(messages: readonly string[], secrets: Redactor, maxChars: number): string[] {
  const redacted = messages.map((message) => secrets.redact(message));
  return fittedMessageLines(redacted, maxChars, cutMessagesLine);
}
