/**
 * The run's own copies of its skills and steering files (spec 7). A docker
 * run mounts its `skills/` and `steering/` read-only over Kiro's, so Kiro
 * sees exactly these copies.
 *
 * A skill is copied from inside its own directory only. That directory may
 * itself be a symlink: its real path is the skill's root. Every entry under
 * it is taken by its real path, so symlinks are dereferenced and the copy
 * holds real files and directories (a link into the host would dangle inside
 * the container). An entry whose real path lies outside the root, a link
 * back to a directory that holds it, and anything that is neither a regular
 * file nor a directory are refused, and one start copies at most
 * {@link SKILL_COPY_LIMITS} for all its skills together. The same walk runs
 * twice: at validation ({@link checkSkillTrees}), which only reads, and at
 * the copy ({@link copySkills}), which checks every entry again, since the
 * tree may change in between. File and directory modes are kept, so a
 * skill's scripts stay executable. A copy never replaces what is already
 * there: a name the run already holds fails the copy.
 *
 * Steering files are single files the caller names by absolute path; they
 * are copied as given.
 */

import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { chmod, copyFile, mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ResolvedSkill } from './skills.ts';
import type { ResolvedSteering } from './steering.ts';

/** What one start copies for all its skills together, at most. */
export interface SkillCopyLimits {
  /** Files and directories, each skill's own directory included. */
  readonly entries: number;
  /** The bytes of the files. */
  readonly bytes: number;
}

export const SKILL_COPY_LIMITS: SkillCopyLimits = Object.freeze({ entries: 10_000, bytes: 100 * 1024 * 1024 });

/** A skill tree that breaks the copy rules; the message names paths, never content. */
export class SkillTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillTreeError';
  }
}

export interface SkillCopyOptions {
  readonly limits?: SkillCopyLimits;
  /** Stops the copy between entries and between chunks of a file. */
  readonly signal?: AbortSignal;
}

type SkillSource = Pick<ResolvedSkill, 'name' | 'dir'>;

/**
 * The key two copy names collide under: NFC-normalized and lower-cased. On
 * a case- and normalization-insensitive file system (macOS APFS) names that
 * differ only so are one file, so the reserved-name and uniqueness checks
 * of the copies compare these keys.
 */
export function copyNameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** The size of one read while a file is copied. */
const COPY_CHUNK_BYTES = 256 * 1024;

/**
 * Checks that `skills` can be copied: every entry inside its skill, and all
 * of them within `limits`. Reads only; a file's size is what `stat` says.
 */
export async function checkSkillTrees(skills: readonly SkillSource[], limits: SkillCopyLimits = SKILL_COPY_LIMITS): Promise<void> {
  const budget = new CopyBudget(limits);
  for (const skill of skills) {
    await walkSkill(skill, budget, undefined, {
      enter: async () => {},
      leave: async () => {},
      file: async (_real, _to, stats) => {
        budget.addBytes(stats.size);
      },
    });
  }
}

/**
 * Copies each skill directory, recursively, to `<dir>/<name>/`, checking
 * every entry again as it goes: a break of the rules fails the copy with a
 * {@link SkillTreeError}. A file's bytes count as they are read.
 */
export async function copySkills(skills: readonly SkillSource[], dir: string, options: SkillCopyOptions = {}): Promise<void> {
  const budget = new CopyBudget(options.limits ?? SKILL_COPY_LIMITS);
  for (const skill of skills) {
    const target = join(dir, skill.name);
    await walkSkill(skill, budget, options.signal, {
      // No `recursive`: a directory already there fails the copy.
      enter: async (to) => {
        await mkdir(join(target, to));
      },
      // Set once the directory is filled, since its mode may forbid writing into it.
      leave: async (to, stats) => {
        await chmod(join(target, to), stats.mode & 0o7777);
      },
      file: (real, to) => copyFileBounded(real, join(target, to), budget, options.signal),
    });
  }
}

/** Copies each steering file to `<dir>/<name>`. */
export async function copySteering(files: readonly Pick<ResolvedSteering, 'name' | 'file'>[], dir: string): Promise<void> {
  for (const file of files) {
    await copyFile(file.file, join(dir, file.name), constants.COPYFILE_EXCL);
  }
}

class CopyBudget {
  readonly #limits: SkillCopyLimits;
  #entries = 0;
  #bytes = 0;

  constructor(limits: SkillCopyLimits) {
    this.#limits = limits;
  }

  addEntry(): void {
    this.#entries += 1;
    if (this.#entries > this.#limits.entries) {
      throw new SkillTreeError(
        `the skills hold more than ${this.#limits.entries} files and directories together, more than one start copies`,
      );
    }
  }

  addBytes(count: number): void {
    this.#bytes += count;
    if (this.#bytes > this.#limits.bytes) {
      throw new SkillTreeError(`the skills hold more than ${this.#limits.bytes} bytes together, more than one start copies`);
    }
  }
}

interface SkillVisitor {
  /** A directory, before its entries; `to` is its path under the skill, `''` for the skill itself. */
  enter(to: string): Promise<void>;
  /** A directory, after its entries. */
  leave(to: string, stats: Stats): Promise<void>;
  /** A regular file, by its real path. */
  file(real: string, to: string, stats: Stats): Promise<void>;
}

/**
 * Walks a skill depth first, in name order, every entry by its real path.
 * The skill's directory must still be its own real path, as resolved.
 * File system errors come through as they are.
 */
async function walkSkill(skill: SkillSource, budget: CopyBudget, signal: AbortSignal | undefined, visitor: SkillVisitor): Promise<void> {
  const root = skill.dir;
  const name = JSON.stringify(skill.name);
  if ((await realpath(root)) !== root) {
    throw new SkillTreeError(`skill ${name}: its directory ${JSON.stringify(root)} has changed since it was resolved`);
  }
  const walkDirectory = async (real: string, to: string, stats: Stats, holding: readonly string[]): Promise<void> => {
    budget.addEntry();
    await visitor.enter(to);
    for (const entry of (await readdir(real)).sort()) {
      signal?.throwIfAborted();
      const path = join(real, entry);
      const entryTo = join(to, entry);
      const entryReal = await realpath(path);
      if (!isInside(root, entryReal)) {
        throw new SkillTreeError(`skill ${name}: ${JSON.stringify(path)} is a link that leads outside the skill`);
      }
      const entryStats = await stat(entryReal);
      if (entryStats.isDirectory()) {
        if (holding.includes(entryReal)) {
          throw new SkillTreeError(`skill ${name}: ${JSON.stringify(path)} is a link back to a directory that holds it`);
        }
        await walkDirectory(entryReal, entryTo, entryStats, [...holding, entryReal]);
      } else if (entryStats.isFile()) {
        budget.addEntry();
        await visitor.file(entryReal, entryTo, entryStats);
      } else {
        throw new SkillTreeError(`skill ${name}: ${JSON.stringify(path)} is neither a regular file nor a directory`);
      }
    }
    await visitor.leave(to, stats);
  };
  const stats = await stat(root);
  if (!stats.isDirectory()) {
    throw new SkillTreeError(`skill ${name}: ${JSON.stringify(root)} is not a directory`);
  }
  await walkDirectory(root, '', stats, [root]);
}

/** Whether the real path `path` is `root` or lies under it. */
function isInside(root: string, path: string): boolean {
  const inside = relative(root, path);
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

/**
 * Copies the regular file at the real path `real` to the new file `target`
 * with its mode, counting its bytes as they are read. The file read is the
 * one still at `real` once it is open: a path changed between the check and
 * the open fails the copy rather than reading another file.
 */
async function copyFileBounded(real: string, target: string, budget: CopyBudget, signal: AbortSignal | undefined): Promise<void> {
  const source = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await source.stat();
    const current = (await realpath(real)) === real ? await stat(real) : undefined;
    if (!opened.isFile() || current === undefined || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new SkillTreeError(`${JSON.stringify(real)} changed while the skills were copied`);
    }
    const copy = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await pump(source, copy, budget, signal);
      await copy.chmod(opened.mode & 0o7777);
    } finally {
      await copy.close();
    }
  } finally {
    await source.close();
  }
}

async function pump(source: FileHandle, copy: FileHandle, budget: CopyBudget, signal: AbortSignal | undefined): Promise<void> {
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  for (;;) {
    signal?.throwIfAborted();
    const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) {
      return;
    }
    budget.addBytes(bytesRead);
    let written = 0;
    while (written < bytesRead) {
      written += (await copy.write(buffer, written, bytesRead - written)).bytesWritten;
    }
  }
}
