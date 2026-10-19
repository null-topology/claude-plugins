/**
 * The `steering` argument of `start` (spec 5, 6.1, 7): absolute paths of
 * markdown files that Kiro applies as steering. Each path must name an
 * existing regular file whose name ends in `.md`; its copy in the run's
 * `steering/` gets the name the path gives, so two different files with one
 * name are refused, and so is the name of the protocol steering, which every
 * run gets; names are compared ignoring case and Unicode normalization
 * ({@link copyNameKey}). Paths that resolve to the same file are kept once
 * (the first).
 * Every refusal is `E_INVALID` for the field `steering`.
 *
 * The module only reads the file system; nothing is copied here.
 */

import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { errorCode } from '../store/files.ts';
import { InvalidInputError } from '../text/errors.ts';
import { PROTOCOL_STEERING_FILE } from './protocol-steering.ts';
import { copyNameKey } from './run-copies.ts';

const FIELD = 'steering';
const MARKDOWN_SUFFIX = '.md';

/** One resolved entry of `steering`. */
export interface ResolvedSteering {
  /** The path as given: the source the run's meta records. */
  readonly requested: string;
  /** The file name of the given path, which the copy gets; unique in one call. */
  readonly name: string;
  /** The file: absolute, symlinks resolved, a regular file. */
  readonly file: string;
}

/**
 * Resolves `paths` in order. Each path is checked when it is reached, so the
 * first offending path is the one reported.
 */
export async function resolveSteering(paths: readonly string[]): Promise<ResolvedSteering[]> {
  const resolved: ResolvedSteering[] = [];
  for (const path of paths) {
    const name = steeringName(path);
    const file = await regularFile(path);
    if (resolved.some((entry) => entry.file === file)) {
      continue;
    }
    const clash = resolved.find((entry) => copyNameKey(entry.name) === copyNameKey(name));
    if (clash !== undefined) {
      const named = clash.name === name ? quote(name) : `${quote(clash.name)} and ${quote(name)}`;
      throw new InvalidInputError(
        FIELD,
        `${quote(clash.requested)} and ${quote(path)} are two files named ${named}; ` +
          'steering file names must be unique, ignoring case',
      );
    }
    resolved.push({ requested: path, name, file });
  }
  return resolved;
}

/** The copy's name: the path's file name, a markdown name that is not the protocol steering's. */
function steeringName(path: string): string {
  if (!isAbsolute(path)) {
    throw new InvalidInputError(FIELD, `must hold absolute paths, got ${quote(path)}`);
  }
  const name = basename(path);
  if (!name.endsWith(MARKDOWN_SUFFIX) || name === MARKDOWN_SUFFIX) {
    throw new InvalidInputError(FIELD, `must hold markdown files whose names end in "${MARKDOWN_SUFFIX}", got ${quote(path)}`);
  }
  if (copyNameKey(name) === copyNameKey(PROTOCOL_STEERING_FILE)) {
    const ignoringCase = name === PROTOCOL_STEERING_FILE ? '' : ' ignoring case';
    throw new InvalidInputError(
      FIELD,
      `${quote(path)} is named ${quote(PROTOCOL_STEERING_FILE)}${ignoringCase}, which is reserved for the plugin's own steering; ` +
        'rename the file',
    );
  }
  return name;
}

/** The real path of `path`, which must be an existing regular file. */
async function regularFile(path: string): Promise<string> {
  let file: string;
  try {
    file = await realpath(path);
  } catch (error) {
    throw lookupFailure(path, error);
  }
  let isFile: boolean;
  try {
    isFile = (await stat(file)).isFile();
  } catch (error) {
    throw lookupFailure(path, error);
  }
  if (!isFile) {
    throw new InvalidInputError(FIELD, `must hold regular files, got ${quote(path)}`);
  }
  return file;
}

function lookupFailure(path: string, error: unknown): InvalidInputError {
  const code = errorCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new InvalidInputError(FIELD, `${quote(path)} does not exist`);
  }
  return new InvalidInputError(FIELD, `${quote(path)} cannot be looked up (${code ?? 'unknown error'})`);
}

function quote(value: string): string {
  return JSON.stringify(value);
}
