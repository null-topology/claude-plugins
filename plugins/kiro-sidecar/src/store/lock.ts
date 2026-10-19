/**
 * The per-run lock: `runs/<launchId>/lock` holds the {pid, startTime, hostId}
 * of the server that drives the run. Only its holder writes the run's
 * `meta.json`.
 *
 * A free lock is taken by creating the file exclusively (a complete temp file
 * linked to the name, so the lock is never seen half-written). A lock is
 * stale only when its holder is dead on this host; a lock of another host is
 * never broken.
 *
 * Breaking a stale lock is race-free because the lock file is never removed
 * on the way: it is replaced in one rename, and only one process may do that
 * rename for a given dead holder. That right is the marker file
 * `lock.break-<digest of the dead holder>`, created exclusively, so of all
 * breakers that saw the same dead holder exactly one creates it. The winner
 * then re-reads the lock and renames its own lock over it only if it still
 * names that dead holder. Nobody else can change the lock in between: the
 * dead holder cannot release it, a plain create fails because the file
 * exists, and every other breaker lost the marker. A breaker that lost
 * answers that the lock is being taken over.
 *
 * A breaker can die between creating the marker and the rename. Its marker
 * then names a dead process, and the next breaker follows it: it races for
 * the marker of that dead breaker instead, and so on down the chain, so the
 * right to break always belongs to exactly one live process. The winner
 * removes the markers it walked after its rename; a marker removed too early
 * only lets a late breaker win it, re-read the lock, see a different holder
 * and give up.
 */

import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createJsonOnce, readJsonIfExists, writeJsonAtomic } from './files.ts';
import { currentDriver, isProcessIdentity, liveness, sameIdentity } from './identity.ts';
import type { ProcessIdentity } from './identity.ts';
import { runPaths } from './paths.ts';

/** How many times a contended acquisition starts over before it gives up. */
const ATTEMPTS = 16;

/** Why a lock was not acquired. */
export type LockRefusal =
  /** The holder is alive on this host. */
  | 'held'
  /** The holder is on another host and is never judged dead from here. */
  | 'other-host'
  /** The holder is dead and another live process is taking the lock over. */
  | 'taking-over';

export type LockAttempt =
  | { readonly acquired: true; readonly lock: RunLock }
  | { readonly acquired: false; readonly reason: LockRefusal; readonly holder: ProcessIdentity };

const CONSTRUCT = Symbol('RunLock');

/** A held run lock. Only `acquireRunLock` creates one. */
export class RunLock {
  readonly stateDir: string;
  readonly launchId: string;
  /** The lock file. */
  readonly path: string;
  readonly holder: ProcessIdentity;
  #released = false;

  constructor(
    token: typeof CONSTRUCT,
    stateDir: string,
    launchId: string,
    holder: ProcessIdentity,
  ) {
    if (token !== CONSTRUCT) {
      throw new TypeError('A RunLock comes only from acquireRunLock');
    }
    this.stateDir = stateDir;
    this.launchId = launchId;
    this.path = runPaths(stateDir, launchId).lock;
    this.holder = holder;
  }

  get released(): boolean {
    return this.#released;
  }

  /** Throws unless this handle is unreleased and the lock file still names its holder. */
  async assertHeld(): Promise<void> {
    if (this.#released) {
      throw new Error(`The lock of ${this.launchId} was released`);
    }
    const current = await readHolder(this.path);
    if (current === undefined || !sameIdentity(current, this.holder)) {
      throw new Error(`The lock of ${this.launchId} is no longer held by this process`);
    }
  }

  /** Removes the lock file if it still names this holder. Safe to call twice. */
  async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    this.#released = true;
    const current = await readHolder(this.path);
    // A live holder's lock is never replaced, so the check and the removal
    // cannot be split by another process taking the lock.
    if (current !== undefined && sameIdentity(current, this.holder)) {
      await rm(this.path, { force: true });
    }
  }
}

/** The holder named by a lock or marker file, or undefined when it does not exist. */
async function readHolder(path: string): Promise<ProcessIdentity | undefined> {
  const value = await readJsonIfExists(path);
  if (value === undefined) {
    return undefined;
  }
  if (!isProcessIdentity(value)) {
    throw new Error(`Malformed lock file ${path}`);
  }
  return { pid: value.pid, startTime: value.startTime, hostId: value.hostId };
}

/** The holder named in a run's lock, or undefined when the run is not locked. */
export async function readRunLock(
  stateDir: string,
  launchId: string,
): Promise<ProcessIdentity | undefined> {
  return readHolder(runPaths(stateDir, launchId).lock);
}

/** The marker that grants the right to replace a lock held by the dead process `dead`. */
export function breakMarker(lockPath: string, dead: ProcessIdentity): string {
  const digest = createHash('sha256')
    .update(`${dead.pid}\n${dead.startTime}\n${dead.hostId}`)
    .digest('hex')
    .slice(0, 16);
  return `${lockPath}.break-${digest}`;
}

type TakeOver =
  | { readonly kind: 'acquired' }
  | { readonly kind: 'busy'; readonly breaker: ProcessIdentity }
  | { readonly kind: 'retry' };

async function takeOver(
  lockPath: string,
  stale: ProcessIdentity,
  self: ProcessIdentity,
): Promise<TakeOver> {
  const walked: string[] = [];
  let dead = stale;
  let marker: string;
  for (;;) {
    marker = breakMarker(lockPath, dead);
    if (walked.includes(marker)) {
      throw new Error(`Lock break markers of ${lockPath} form a cycle`);
    }
    if (await createJsonOnce(marker, self)) {
      break;
    }
    walked.push(marker);
    const breaker = await readHolder(marker);
    if (breaker === undefined) {
      return { kind: 'retry' };
    }
    if ((await liveness(breaker)) !== 'dead') {
      return { kind: 'busy', breaker };
    }
    dead = breaker;
  }

  // This process alone may now replace the lock while it names `stale`.
  const current = await readHolder(lockPath);
  if (current === undefined || !sameIdentity(current, stale)) {
    await rm(marker, { force: true });
    return { kind: 'retry' };
  }
  await writeJsonAtomic(lockPath, self);
  for (const path of [...walked, marker]) {
    await rm(path, { force: true });
  }
  return { kind: 'acquired' };
}

/**
 * Takes the lock of a run for `self` (this process by default). Refuses while
 * the holder is alive, is on another host, or is being replaced by another
 * process; takes over a lock whose holder is dead on this host.
 */
export async function acquireRunLock(
  stateDir: string,
  launchId: string,
  self?: ProcessIdentity,
): Promise<LockAttempt> {
  const holder = self ?? (await currentDriver());
  const lockPath = runPaths(stateDir, launchId).lock;
  const acquired = (): LockAttempt => ({
    acquired: true,
    lock: new RunLock(CONSTRUCT, stateDir, launchId, holder),
  });

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (await createJsonOnce(lockPath, holder)) {
      return acquired();
    }
    const current = await readHolder(lockPath);
    if (current === undefined) {
      continue;
    }
    const state = await liveness(current);
    if (state === 'alive') {
      return { acquired: false, reason: 'held', holder: current };
    }
    if (state === 'other-host') {
      return { acquired: false, reason: 'other-host', holder: current };
    }
    const outcome = await takeOver(lockPath, current, holder);
    if (outcome.kind === 'acquired') {
      return acquired();
    }
    if (outcome.kind === 'busy') {
      return { acquired: false, reason: 'taking-over', holder: outcome.breaker };
    }
  }
  throw new Error(`The lock of ${launchId} kept changing; gave up after ${ATTEMPTS} attempts`);
}
