/**
 * Delivery markers of a turn (4.6) written by in-process tool calls.
 *
 * `turns/<n>.claimed` exists while at least one call of this server is
 * blocked on turn n: the first claim writes it before it resolves, the last
 * release removes it. It records `{at, holder}`, the holder being this
 * server's process identity, so that another server's sweep can tell a
 * claim of a live server from one a dead server left. `turns/<n>.returned`
 * is written before a tool reply that carries the turn's result is sent. The
 * waiter reads both and pushes a result only when neither exists; it only
 * tests whether they exist.
 */

import { rm } from 'node:fs/promises';
import { createJsonOnce, readJsonIfExists, writeJsonAtomic } from '../store/files.ts';
import { currentDriver, isProcessIdentity } from '../store/identity.ts';
import type { ProcessIdentity } from '../store/identity.ts';
import { turnPaths } from '../store/paths.ts';

/** Ends one claim; the marker is removed when the last holder releases. Safe to call twice. */
export type ReleaseClaim = () => Promise<void>;

interface ClaimEntry {
  holders: number;
  /** File operations on the marker, in order; never rejects. */
  chain: Promise<void>;
  /** The marker write of the first holder; later holders share its outcome. */
  write: Promise<void>;
}

/** UTC ISO 8601 with seconds. */
export function isoSeconds(at: Date = new Date()): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Writes `turns/<n>.returned`, once, before a reply carrying the turn's result
 * is sent. The only writer of that marker.
 */
export async function markTurnReturned(
  stateDir: string,
  launchId: string,
  turn: number,
  at: Date = new Date(),
): Promise<void> {
  await createJsonOnce(turnPaths(stateDir, launchId, turn).returned, { at: isoSeconds(at) });
}

/**
 * The holder a `turns/<n>.claimed` marker records. Undefined when the marker
 * is gone; null when it records none: an empty or unparseable marker, or one
 * written before markers recorded their holder. Rejects when the marker
 * cannot be read for another reason.
 */
export async function readClaimHolder(path: string): Promise<ProcessIdentity | null | undefined> {
  let value: unknown;
  try {
    value = await readJsonIfExists(path);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
  if (value === undefined) {
    return undefined;
  }
  const holder = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).holder : undefined;
  return isProcessIdentity(holder) ? holder : null;
}

export class TurnClaims {
  readonly #stateDir: string;
  readonly #holder: () => Promise<ProcessIdentity>;
  readonly #entries = new Map<string, ClaimEntry>();

  /** `holder` is the identity a marker records; this process's by default. */
  constructor(stateDir: string, holder: () => Promise<ProcessIdentity> = currentDriver) {
    this.#stateDir = stateDir;
    this.#holder = holder;
  }

  /** How many holders turn n of `launchId` has now. */
  holders(launchId: string, turn: number): number {
    return this.#entries.get(key(launchId, turn))?.holders ?? 0;
  }

  /**
   * Claims turn n: resolves once `turns/<n>.claimed` exists. Rejects, holding
   * nothing, when the marker cannot be written; so does every claim that
   * joined the failed write.
   */
  async claim(launchId: string, turn: number): Promise<ReleaseClaim> {
    const path = turnPaths(this.#stateDir, launchId, turn).claimed;
    const id = key(launchId, turn);
    let entry = this.#entries.get(id);
    if (entry === undefined) {
      entry = { holders: 0, chain: Promise.resolve(), write: Promise.resolve() };
      this.#entries.set(id, entry);
    }
    const held = entry;
    held.holders += 1;
    if (held.holders === 1) {
      held.write = held.chain.then(async () => {
        await writeJsonAtomic(path, { at: isoSeconds(), holder: await this.#holder() });
      });
      held.chain = held.write.catch(() => {});
    }
    try {
      // A later holder waits for the first holder's write and fails with it.
      await held.write;
    } catch (error) {
      await this.#drop(id, held, path);
      throw error;
    }
    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      await this.#drop(id, held, path);
    };
  }

  /** Writes `turns/<n>.returned`, once, before a reply carrying the result is sent. */
  markReturned(launchId: string, turn: number): Promise<void> {
    return markTurnReturned(this.#stateDir, launchId, turn);
  }

  async #drop(id: string, entry: ClaimEntry, path: string): Promise<void> {
    entry.holders -= 1;
    if (entry.holders > 0) {
      return;
    }
    const removal = entry.chain.then(() => rm(path, { force: true }));
    entry.chain = removal.catch(() => {});
    const chain = entry.chain;
    try {
      await removal;
    } finally {
      if (entry.holders === 0 && entry.chain === chain && this.#entries.get(id) === entry) {
        this.#entries.delete(id);
      }
    }
  }
}

function key(launchId: string, turn: number): string {
  return `${launchId}#${turn}`;
}
