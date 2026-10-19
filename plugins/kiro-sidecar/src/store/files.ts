/**
 * File primitives for the state directory. Directories are created 0700 and
 * files 0600; the mode is given at creation, so it does not depend on a
 * umask that leaves the owner's bits alone.
 *
 * - `writeJsonAtomic` and `writeTextAtomic` write a temp file and rename it
 *   over the target: a reader sees the old content or the new, never a part.
 * - `createJsonOnce` writes a temp file and `link()`s it to the target:
 *   linking fails when the target exists, so the first writer wins and a
 *   created file is complete the moment its name appears.
 *
 * Temp files start with `.` and end with `.tmp`, sit next to their target,
 * and are removed on every path out. A process that dies mid-write leaves
 * its temp file behind; `isTempName` tells such a file by its name.
 */

import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** The `code` of a Node.js system error, if any. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** Creates `dir` and its missing parents with mode 0700. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
}

function serialize(value: unknown, indent?: number): string {
  const text = JSON.stringify(value, null, indent);
  if (text === undefined) {
    throw new TypeError('Value cannot be written as JSON');
  }
  return `${text}\n`;
}

/** The name `writeTemp` gives a temp file: `.<target name>.<12 hex digits>.tmp`. */
const TEMP_NAME_PATTERN = /^\..+\.[0-9a-f]{12}\.tmp$/;

/** True when `name` is the name of a temp file of an atomic write or `createJsonOnce`. */
export function isTempName(name: string): boolean {
  return TEMP_NAME_PATTERN.test(name);
}

async function writeTemp(target: string, data: string): Promise<string> {
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temp, 'wx', FILE_MODE);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  return temp;
}

/** Replaces `path` with `value` as JSON in one step. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, serialize(value, 2));
}

/** Replaces `path` with `text` in one step. */
export async function writeTextAtomic(path: string, text: string): Promise<void> {
  const temp = await writeTemp(path, text);
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Creates `path` holding `value` as JSON unless it exists. Returns false,
 * leaving the existing file untouched, when another writer was first.
 */
export async function createJsonOnce(path: string, value: unknown): Promise<boolean> {
  const temp = await writeTemp(path, serialize(value, 2));
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return false;
    }
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

/** Parsed JSON content of `path`, or undefined when the file does not exist. */
export async function readJsonIfExists(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  return JSON.parse(text) as unknown;
}

/**
 * Appends `value` as one JSON line in a single write to a file opened in
 * append mode, so lines from concurrent writers do not interleave.
 */
export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  const line = Buffer.from(serialize(value), 'utf8');
  const handle = await open(path, 'a', FILE_MODE);
  try {
    const { bytesWritten } = await handle.write(line, 0, line.length);
    if (bytesWritten !== line.length) {
      throw new Error(`Short write to ${path}: ${bytesWritten} of ${line.length} bytes`);
    }
  } finally {
    await handle.close();
  }
}
