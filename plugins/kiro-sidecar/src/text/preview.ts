/**
 * Previews of Kiro text and of prompts, and the cut of large fields in
 * debug frames.
 */

import { DEBUG_FIELD_CAP_BYTES, PROMPT_PREVIEW_CHARS } from './limits.ts';
import type { SecretSet } from './redact.ts';
import { headChars, tailStart, utf8PrefixLength } from './unicode.ts';

/** The marker that opens a preview whose start was cut. */
export function cutMarker(droppedChars: number): string {
  return `[kiro-sidecar: ${droppedChars} earlier characters cut]\n`;
}

/** Used instead of `cutMarker` when the budget is too small for it. */
export const SHORT_CUT_MARKER = '[cut]\n';

/** The marker that closes a text whose end was cut. */
export const HEAD_CUT_MARKER = ' [...]';

/**
 * The first `maxChars` characters of `text`, followed by `HEAD_CUT_MARKER`
 * when anything was cut; the marker is not counted within `maxChars`. The cut
 * never splits a surrogate pair.
 */
export function cutKeepingStart(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${headChars(text, maxChars)}${HEAD_CUT_MARKER}`;
}

/**
 * `text` cut to at most `maxChars` characters, keeping its END. A cut is
 * marked by `cutMarker` at the start, counted within `maxChars`. Pass
 * `droppedBefore` when `text` is already the tail of a longer text, such as
 * `TurnSummary.final` with `finalCutChars`; the result is then marked even
 * when `text` fits. When the budget cannot hold the full marker, the short
 * marker is used, and when it cannot hold that either, the result is empty.
 * The cut never splits a surrogate pair.
 */
export function cutKeepingEnd(text: string, maxChars: number, droppedBefore = 0): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new RangeError(`maxChars must be a non-negative integer, got ${String(maxChars)}`);
  }
  if (droppedBefore === 0 && text.length <= maxChars) {
    return text;
  }
  const longestMarker = cutMarker(droppedBefore + text.length);
  if (longestMarker.length <= maxChars) {
    const start = tailStart(text, maxChars - longestMarker.length);
    return cutMarker(droppedBefore + start) + text.slice(start);
  }
  if (SHORT_CUT_MARKER.length <= maxChars) {
    return SHORT_CUT_MARKER + text.slice(tailStart(text, maxChars - SHORT_CUT_MARKER.length));
  }
  return '';
}

/**
 * The first 200 characters of a session's first prompt. With `secrets`, the
 * prompt is redacted before it is cut, so a secret across the cut is caught.
 */
export function firstPromptPreview(prompt: string, secrets?: SecretSet): string {
  const text = secrets === undefined ? prompt : secrets.redact(prompt);
  return headChars(text, PROMPT_PREVIEW_CHARS);
}

/** Ends a field cut by `prepareDebugFrame`. */
export function debugCutMarker(totalBytes: number): string {
  return `...[kiro-sidecar: field cut, ${totalBytes} bytes in full]`;
}

/**
 * A copy of an ACP frame for the `debug_acp` log in which no string value
 * and no `content` field keeps more than `capBytes` (4 KiB) of its JSON
 * form. Every string (keys too) is redacted first. Then every `content`
 * field, whatever its type, and every other string value, at any depth,
 * whose JSON form is over `capBytes` is replaced by a string: the first
 * `capBytes` of that JSON form, never ending inside a UTF-8 character,
 * followed by `debugCutMarker`. A `content` field is measured on its uncut
 * form, so its marker counts the bytes it really had; when it fits, so does
 * every string inside it. Redacting before the cut keeps a secret from
 * surviving in part at the cut.
 */
export function prepareDebugFrame(
  frame: unknown,
  secrets: SecretSet,
  capBytes = DEBUG_FIELD_CAP_BYTES,
): unknown {
  return copyFrame(frame, secrets, capBytes);
}

/** A redacted copy of `value`, cut as `prepareDebugFrame` says unless `capBytes` is null. */
function copyFrame(value: unknown, secrets: SecretSet, capBytes: number | null): unknown {
  if (typeof value === 'string') {
    const redacted = secrets.redact(value);
    return capBytes === null ? redacted : cutField(redacted, capBytes);
  }
  if (Array.isArray(value)) {
    return value.map((item) => copyFrame(item, secrets, capBytes));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[secrets.redact(key)] =
      capBytes !== null && key === 'content'
        ? cutField(copyFrame(item, secrets, null), capBytes)
        : copyFrame(item, secrets, capBytes);
  }
  return copy;
}

function cutField(value: unknown, capBytes: number): unknown {
  const json = JSON.stringify(value);
  if (json === undefined) {
    return value;
  }
  const bytes = Buffer.from(json, 'utf8');
  if (bytes.length <= capBytes) {
    return value;
  }
  const kept = bytes.subarray(0, utf8PrefixLength(bytes, capBytes)).toString('utf8');
  return kept + debugCutMarker(bytes.length);
}
