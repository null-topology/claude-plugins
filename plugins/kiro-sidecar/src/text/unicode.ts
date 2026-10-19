/**
 * Cut helpers that never split a UTF-16 surrogate pair or a UTF-8 sequence,
 * so a cut piece encodes to the same bytes it had inside the whole text.
 */

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** True when `index` falls between the two halves of a surrogate pair. */
export function splitsSurrogatePair(text: string, index: number): boolean {
  return (
    index > 0 &&
    index < text.length &&
    isHighSurrogate(text.charCodeAt(index - 1)) &&
    isLowSurrogate(text.charCodeAt(index))
  );
}

/** The first `maxChars` code units of `text`, one fewer when that would split a pair. */
export function headChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const end = Math.max(0, maxChars);
  return text.slice(0, splitsSurrogatePair(text, end) ? end - 1 : end);
}

/**
 * The index from which at most `keepChars` code units of `text` remain,
 * moved one forward when it would split a pair.
 */
export function tailStart(text: string, keepChars: number): number {
  const start = Math.max(0, text.length - Math.max(0, keepChars));
  return splitsSurrogatePair(text, start) ? start + 1 : start;
}

/**
 * The length of the longest prefix of `bytes` that is at most `maxBytes`
 * long and does not end inside a UTF-8 sequence.
 */
export function utf8PrefixLength(bytes: Uint8Array, maxBytes: number): number {
  if (bytes.length <= maxBytes) {
    return bytes.length;
  }
  let end = Math.max(0, maxBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return end;
}
