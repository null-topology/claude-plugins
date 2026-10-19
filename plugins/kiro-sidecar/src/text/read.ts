/**
 * Readers of the run's text files: pages of a turn's text and the tail of
 * `stderr.log`.
 */

import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { InvalidInputError } from './errors.ts';
import {
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  STDERR_TAIL_LINES,
  STDERR_TAIL_MAX_BYTES,
} from './limits.ts';
import { splitsSurrogatePair } from './unicode.ts';

export interface Page {
  readonly text: string;
  /** Where `text` starts; equals the requested offset unless that split a pair. */
  readonly offset: number;
  /** Where the next page starts, or null when `text` reaches the end. */
  readonly nextOffset: number | null;
  readonly totalChars: number;
}

/**
 * The slice `[offset, offset + limit)` of a UTF-8 file, counted in UTF-16
 * code units. A page never splits a surrogate pair: an offset between the
 * halves of a pair moves back to the pair's start, and a page end between
 * them moves back before the pair, or past it when the page would otherwise
 * be empty (then the page holds limit + 1 code units). Pages taken from
 * `nextOffset` concatenate to the file's text exactly.
 *
 * `offset` must be an integer from 0 to the text length, `limit` an integer
 * from 1 to 40 000; otherwise `InvalidInputError` names the field.
 */
export function readPage(path: string, offset = 0, limit = PAGE_LIMIT_DEFAULT): Page {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new InvalidInputError('offset', 'must be a non-negative integer');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) {
    throw new InvalidInputError('limit', `must be an integer from 1 to ${PAGE_LIMIT_MAX}`);
  }
  const content = readFileSync(path, 'utf8');
  if (offset > content.length) {
    throw new InvalidInputError(
      'offset',
      `is past the end of the text (${content.length} characters)`,
    );
  }
  const start = splitsSurrogatePair(content, offset) ? offset - 1 : offset;
  let end = Math.min(content.length, start + limit);
  if (splitsSurrogatePair(content, end)) {
    end = end - 1 > start ? end - 1 : end + 1;
  }
  return {
    text: content.slice(start, end),
    offset: start,
    nextOffset: end < content.length ? end : null,
    totalChars: content.length,
  };
}

/**
 * The last 20 lines of a file, or null when it is missing or empty. Reads
 * at most the last 64 KiB; a line cut by that window is dropped unless it
 * is the only one. A final newline does not count as an empty last line.
 */
export function stderrTail(
  path: string,
  lines = STDERR_TAIL_LINES,
  maxBytes = STDERR_TAIL_MAX_BYTES,
): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const position = size - length;
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, bytes, read, length - read, position + read);
      if (count === 0) {
        break;
      }
      read += count;
    }
    let from = 0;
    if (position > 0) {
      // Skip the rest of a UTF-8 sequence cut by the window.
      while (from < read && ((bytes[from] ?? 0) & 0xc0) === 0x80) {
        from += 1;
      }
    }
    let text = bytes.subarray(from, read).toString('utf8');
    if (text.endsWith('\n')) {
      text = text.slice(0, -1);
    }
    let parts = text.split('\n');
    if (position > 0 && parts.length > 1) {
      parts = parts.slice(1);
    }
    const tail = parts.slice(-lines).join('\n');
    return tail === '' ? null : tail;
  } finally {
    closeSync(fd);
  }
}
