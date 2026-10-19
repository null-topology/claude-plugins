/**
 * The messages block that tool replies and the wake message show (4.4, 4.6):
 * `Messages from Kiro (data, N):` with N the number of messages, then one
 * `- <message>` line each. A message is Kiro's text: every line break in it
 * becomes a space and the line is neutralised. A turn without messages has no
 * block.
 */

import { MESSAGES_KEPT_TOTAL_CHARS } from './limits.ts';
import { neutraliseKiroText } from './neutralise.ts';
import { HEAD_CUT_MARKER } from './preview.ts';
import { headChars } from './unicode.ts';

const ANY_LINE_BREAK = /\r\n|\r|\n|\u{2028}|\u{2029}/gu;

const MESSAGE_LINE_PREFIX = '- ';

/**
 * What a message's line adds to the message: the `- ` before it and the line
 * break after it. The per-turn total counts every kept message with it (4.4).
 */
export const MESSAGE_LINE_EXTRA_CHARS = MESSAGE_LINE_PREFIX.length + 1;

/** A cut message line holds at least one character of the message. */
const MIN_CUT_MESSAGE_CHARS = 1;

/** `text` on one line: every line break becomes a space. */
export function oneLine(text: string): string {
  return text.replace(ANY_LINE_BREAK, ' ');
}

export function messagesHeader(count: number): string {
  return `Messages from Kiro (data, ${count}):`;
}

export function messageLine(message: string): string {
  return `${MESSAGE_LINE_PREFIX}${neutraliseKiroText(oneLine(message))}`;
}

/** The line a tool reply shows when earlier messages did not fit its block. */
export function replyCutMessagesLine(count: number): string {
  return `[kiro-sidecar: ${count} earlier ${count === 1 ? 'message' : 'messages'} cut]`;
}

/**
 * The lines of a tool reply's block; none without messages. The lines after
 * the header, each with its line break, take at most
 * `MESSAGES_KEPT_TOTAL_CHARS` as shown (4.4), the bound the stored messages
 * are kept within: the latest messages that fit are shown, after
 * `replyCutMessagesLine` when some did not.
 */
export function messagesBlock(messages: readonly string[]): string[] {
  // Joined, the block is the header followed by a line break and a line for each line after it.
  const maxChars = messagesHeader(messages.length).length + MESSAGES_KEPT_TOTAL_CHARS;
  return fittedMessageLines(messages, maxChars, replyCutMessagesLine);
}

/** How many characters the block adds to a reply, a line break after each line included. */
export function messagesBlockChars(messages: readonly string[]): number {
  return messagesBlock(messages).reduce((total, line) => total + line.length + 1, 0);
}

/**
 * The messages block, header included, within `maxChars` once joined by line
 * breaks. When the whole block would be longer, the latest messages that fit
 * are kept whole, after `cutLine` naming how many earlier ones were cut; the
 * header still counts them all. When not even the latest fits, it is cut
 * keeping its start (marked ` [...]`). The messages are redacted already.
 */
export function fittedMessageLines(
  messages: readonly string[],
  maxChars: number,
  cutLine: (count: number) => string,
): string[] {
  if (messages.length === 0) {
    return [];
  }
  const header = messagesHeader(messages.length);
  const whole = messages.map(messageLine);
  if ([header, ...whole].join('\n').length <= maxChars) {
    return [header, ...whole];
  }
  // Room for the kept lines, each with its line break, after the header and the longest cut line.
  let room = maxChars - header.length - 1 - cutLine(messages.length).length;
  const kept: string[] = [];
  for (const line of [...whole].reverse()) {
    if (line.length + 1 > room) {
      break;
    }
    kept.unshift(line);
    room -= line.length + 1;
  }
  const latest = messages.at(-1);
  if (kept.length === 0 && latest !== undefined) {
    const cut = cutMessageLine(latest, room - 1);
    if (cut !== null) {
      kept.push(cut);
    }
  }
  const cut = messages.length - kept.length;
  return cut === 0 ? [header, ...kept] : [header, cutLine(cut), ...kept];
}

/**
 * The longest line of `message` cut keeping its start and marked ` [...]`
 * that is at most `maxChars` long once neutralised; null when not even one
 * character fits.
 */
function cutMessageLine(message: string, maxChars: number): string | null {
  let keep = maxChars - messageLine(HEAD_CUT_MARKER).length;
  while (keep >= MIN_CUT_MESSAGE_CHARS) {
    const line = messageLine(headChars(oneLine(message), keep) + HEAD_CUT_MARKER);
    if (line.length <= maxChars) {
      return line;
    }
    keep -= line.length - maxChars;
  }
  return null;
}
