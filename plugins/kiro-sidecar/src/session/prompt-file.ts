/**
 * The `prompt_file` argument of `start`: an absolute path to an existing,
 * readable, non-empty regular file of at most {@link PROMPT_FILE_MAX_BYTES}.
 * The file is read once, during validation; the bytes read are what the run
 * copies to its `task.md`, so a later change of the file does not reach the
 * run.
 */

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { errorCode } from '../store/files.ts';
import { InvalidInputError } from '../text/errors.ts';
import { MiB, PROMPT_FILE_MAX_BYTES } from '../text/limits.ts';

const FIELD = 'prompt_file';
const READ_CHUNK_BYTES = MiB;

/** A `prompt_file` as read at validation. */
export interface PromptTask {
  /** The file's bytes, copied verbatim to the run's `task.md`. */
  readonly content: Buffer;
  /** The content decoded as UTF-8: the prompt in local mode, and the preview source. */
  readonly text: string;
}

/**
 * Reads the `prompt_file` at `value`. Every refusal is `E_INVALID` for the
 * field. The file is opened non-blocking, so a FIFO is refused instead of
 * waiting for a writer.
 */
export async function readPromptFile(value: unknown, maxBytes: number = PROMPT_FILE_MAX_BYTES): Promise<PromptTask> {
  if (typeof value !== 'string' || value === '') {
    throw new InvalidInputError(FIELD, 'must not be empty');
  }
  if (!isAbsolute(value)) {
    throw new InvalidInputError(FIELD, `must be an absolute path, got ${JSON.stringify(value)}`);
  }
  let handle: FileHandle;
  try {
    handle = await open(value, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw openFailure(value, error);
  }
  try {
    const status = await handle.stat();
    if (!status.isFile()) {
      throw new InvalidInputError(FIELD, `must be a regular file, got ${JSON.stringify(value)}`);
    }
    let content: Buffer | null;
    try {
      content = await readAtMost(handle, maxBytes);
    } catch (error) {
      throw new InvalidInputError(FIELD, `cannot be read (${errorCode(error) ?? 'unknown error'}): ${JSON.stringify(value)}`);
    }
    if (content === null) {
      throw new InvalidInputError(FIELD, `must be at most ${maxBytes} bytes: ${JSON.stringify(value)}`);
    }
    if (content.length === 0) {
      throw new InvalidInputError(FIELD, `must not be an empty file, got ${JSON.stringify(value)}`);
    }
    return { content, text: content.toString('utf8') };
  } finally {
    await handle.close();
  }
}

function openFailure(path: string, error: unknown): InvalidInputError {
  const code = errorCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new InvalidInputError(FIELD, `does not exist: ${JSON.stringify(path)}`);
  }
  return new InvalidInputError(FIELD, `cannot be read (${code ?? 'unknown error'}): ${JSON.stringify(path)}`);
}

/**
 * The whole content of `handle`, or null when it holds more than `maxBytes`.
 * At most `maxBytes + 1` bytes are read, whatever size the file has or grows to.
 */
async function readAtMost(handle: FileHandle, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total);
    }
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
    if (total > maxBytes) {
      return null;
    }
  }
}
