/**
 * Renders tool replies as text.
 *
 * A reply starts with a JSON object (2-space indent) holding its fields.
 * Kiro's text never goes inside that JSON as multi-line content: a reply that
 * carries a turn leaves `final`, `messages` and `completion` out of the JSON
 * and shows, after it, the messages block (`Messages from Kiro (data, N):`,
 * one `- <message>` line each), then for a completion the result block
 * (`Result from Kiro (data):` and the result between the delimiters), and
 * then the text between `KIRO_OUTPUT_BEGIN` and `KIRO_OUTPUT_END`,
 * neutralised (4.4). The trailer (`kiro-turn:` or `kiro-result:`) is always
 * the last line.
 *
 * JSON escapes every line break except U+2028 and U+2029; those are escaped
 * here too, so no string value inside the JSON can start a line of its own.
 *
 * Every string value inside the JSON, at any depth and in arrays too, is
 * neutralised as the delimited text is, since JSON escaping leaves tags as
 * they are and Kiro's text reaches many fields.
 */

import type { TurnResult } from '../session/types.ts';
import { fittedStartMarked, fittedTail } from '../text/fit.ts';
import { REPLY_ERROR_CHARS, REPLY_STDERR_TAIL_CHARS } from '../text/limits.ts';
import { messagesBlock } from '../text/messages.ts';
import { neutraliseKiroText } from '../text/neutralise.ts';
import { delimitedLines, resultBlock } from '../text/result-block.ts';

/** One reply part: the turn text a reply carries, with the messages and the completion result it shows. */
export interface KiroTextBlock {
  readonly messages: readonly string[];
  /** The completion's result; null or absent when the part shows none. */
  readonly result?: string | null;
  readonly text: string;
}

const LINE_SEPARATOR = /\u{2028}/gu;
const PARAGRAPH_SEPARATOR = /\u{2029}/gu;
const BACKSLASH = '\\';

/**
 * The JSON form of a reply's fields, with U+2028 and U+2029 escaped and every
 * string value neutralised.
 */
export function renderJson(value: unknown): string {
  return JSON.stringify(value, neutraliseStrings, 2)
    .replace(LINE_SEPARATOR, `${BACKSLASH}u2028`)
    .replace(PARAGRAPH_SEPARATOR, `${BACKSLASH}u2029`);
}

/** Called for every value, array elements and the top value included. */
function neutraliseStrings(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? neutraliseKiroText(value) : value;
}

/** The messages block, the result block and the delimited text of a turn. */
export function renderKiroText(block: KiroTextBlock): string[] {
  return [...messagesBlock(block.messages), ...resultBlock(block.result ?? null), ...delimitedLines(block.text)];
}

/** A turn result without the fields that hold Kiro's text. */
export type ResultFields = Omit<TurnResult, 'final' | 'messages' | 'completion'>;

/**
 * A turn result as a reply shows it: without the fields that hold Kiro's
 * text, and with `error` and `stderrTail` cut to their reply bounds as the
 * JSON shows them, so a failed turn's reply stays bounded as well (4.4).
 */
export function resultFields(result: TurnResult): ResultFields {
  const { final: _final, messages: _messages, completion: _completion, ...fields } = result;
  return {
    ...fields,
    error: fields.error === null ? null : fittedStartMarked(fields.error, REPLY_ERROR_CHARS, shownInJson),
    stderrTail: fields.stderrTail === null ? null : fittedTail(fields.stderrTail, REPLY_STDERR_TAIL_CHARS, shownInJson),
  };
}

/**
 * How many characters a turn result's `error` and `stderrTail` take in a
 * reply's JSON as `resultFields` shows them, their quotes not counted; 0 for
 * a turn without them. Every page of a failed turn gives way to them (4.4).
 */
export function failureFieldsChars(result: TurnResult): number {
  const { error, stderrTail } = resultFields(result);
  return (error === null ? 0 : shownInJson(error).length) + (stderrTail === null ? 0 : shownInJson(stderrTail).length);
}

/** A string value as the reply's JSON shows it: neutralised and escaped, without its quotes. */
function shownInJson(text: string): string {
  return renderJson(text).slice(1, -1);
}

/**
 * Joins a reply: the JSON of `fields`, then each Kiro text block (each may be
 * followed by its own `kiro-result:` line), then the trailer as the last line.
 */
export function renderReply(
  fields: unknown,
  parts: readonly { readonly block: KiroTextBlock; readonly resultLine: string | null }[] = [],
  trailer: string | null = null,
): string {
  const lines = [renderJson(fields)];
  for (const part of parts) {
    lines.push(...renderKiroText(part.block));
    if (part.resultLine !== null) {
      lines.push(part.resultLine);
    }
  }
  if (trailer !== null) {
    lines.push(trailer);
  }
  return lines.join('\n');
}
