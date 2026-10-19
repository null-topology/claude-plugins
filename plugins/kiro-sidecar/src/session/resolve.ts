/**
 * The runs a server may see, and the resolution of a `session` argument.
 *
 * Visible runs are the own runs (whatever home they use) and the runs whose
 * `meta.home` is the server's home. A run relates to the caller as:
 *
 * - `own`: `meta.ownerKey` is the current owner key;
 * - `same-home`: another owner, with a driver on this host;
 * - `other-host`: another owner, with a driver on another host. Such a run is
 *   read-only and never judged dead: it keeps its recorded state.
 *
 * The state of a run is the live registry's for an own run this server
 * drives; otherwise the recorded state, except that `idle` or `running` with
 * a dead driver on this host reads as `lost`.
 *
 * A `session` argument is a launch id, a Kiro session id or a label, tried in
 * that order. A launch id names one run. A Kiro session id or a label that
 * several runs share resolves to the own live run among them, else to the
 * latest created one. When that choice is still not unique (two own live
 * runs, or two runs created at the same instant) the argument is `E_INVALID`,
 * and the message lists those tied runs as the candidates. An argument that
 * names no visible run is `E_NOT_FOUND`, so a run of another home answers the
 * same as one that does not exist.
 */

import { readdir } from 'node:fs/promises';
import { SidecarError } from '../errors.ts';
import { errorCode } from '../store/files.ts';
import { localHostId } from '../store/identity.ts';
import { isLaunchId, runsDir } from '../store/paths.ts';
import { observedState, readMeta } from '../store/runs.ts';
import type { RunMeta, RunState } from '../store/runs.ts';
import { InvalidInputError } from '../text/errors.ts';
import type { LiveRegistry, LiveSession } from './types.ts';

/** What a query needs to know about the caller. */
export interface SessionScope {
  readonly stateDir: string;
  /** The server's home. */
  readonly home: string;
  /** The owner key of the current Claude process. */
  readonly owner: string;
  /** The sessions this server drives. */
  readonly live: LiveRegistry;
}

export type RunRelation = 'own' | 'same-home' | 'other-host';

export interface VisibleRun {
  readonly launchId: string;
  readonly meta: RunMeta;
  readonly relation: RunRelation;
  /** The state this server reports for the run. */
  readonly state: RunState;
  /** The registry entry of an own run this server drives, else null. */
  readonly live: LiveSession | null;
}

const LIVE_STATES: readonly RunState[] = ['starting', 'idle', 'running'];

/** True for `starting`, `idle` and `running`. */
export function isLiveState(state: RunState): boolean {
  return LIVE_STATES.includes(state);
}

/** The run's creation time in ms; an unparsable time sorts first. */
export function createdTime(meta: RunMeta): number {
  const time = Date.parse(meta.createdAt);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

async function viewRun(scope: SessionScope, meta: RunMeta): Promise<VisibleRun | undefined> {
  const own = meta.ownerKey === scope.owner;
  if (!own && meta.home !== scope.home) {
    return undefined;
  }
  let relation: RunRelation = 'own';
  if (!own) {
    relation = meta.driver.hostId === (await localHostId()) ? 'same-home' : 'other-host';
  }
  const live = own ? (scope.live.get(meta.launchId) ?? null) : null;
  const state = live === null ? await observedState(meta) : live.state;
  return { launchId: meta.launchId, meta, relation, state, live };
}

/**
 * The visible run with this launch id, or undefined when it is missing, not
 * visible, or its `meta.json` is unreadable or invalid.
 */
export async function readVisibleRun(
  scope: SessionScope,
  launchId: string,
): Promise<VisibleRun | undefined> {
  if (!isLaunchId(launchId)) {
    return undefined;
  }
  let meta: RunMeta | undefined;
  try {
    meta = await readMeta(scope.stateDir, launchId);
  } catch {
    return undefined;
  }
  if (meta === undefined || meta.launchId !== launchId) {
    return undefined;
  }
  return viewRun(scope, meta);
}

/** Every visible run, oldest first; runs without a valid `meta.json` are skipped. */
export async function scanVisibleRuns(scope: SessionScope): Promise<VisibleRun[]> {
  let names: string[];
  try {
    names = await readdir(runsDir(scope.stateDir));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const runs = await Promise.all(
    names.filter(isLaunchId).map((name) => readVisibleRun(scope, name)),
  );
  return runs
    .filter((run): run is VisibleRun => run !== undefined)
    .sort(
      (a, b) =>
        createdTime(a.meta) - createdTime(b.meta) || a.launchId.localeCompare(b.launchId),
    );
}

function notFound(session: string): SidecarError {
  return new SidecarError('E_NOT_FOUND', `No session ${JSON.stringify(session)} in this home`);
}

function ambiguous(session: string, candidates: readonly VisibleRun[]): InvalidInputError {
  const ids = candidates.map((run) => run.launchId).join(', ');
  return new InvalidInputError(
    'session',
    `${JSON.stringify(session)} matches several sessions (${ids}); pass a launch id`,
  );
}

function pick(session: string, matches: readonly VisibleRun[]): VisibleRun {
  const ownLive = matches.filter((run) => run.relation === 'own' && isLiveState(run.state));
  if (ownLive.length === 1 && ownLive[0] !== undefined) {
    return ownLive[0];
  }
  if (ownLive.length > 1) {
    throw ambiguous(session, ownLive);
  }
  const latest = Math.max(...matches.map((run) => createdTime(run.meta)));
  const newest = matches.filter((run) => createdTime(run.meta) === latest);
  if (newest.length === 1 && newest[0] !== undefined) {
    return newest[0];
  }
  throw ambiguous(session, newest);
}

/** Resolves a `session` argument to a visible run (see the module comment). */
export async function resolveSession(scope: SessionScope, session: unknown): Promise<VisibleRun> {
  if (typeof session !== 'string' || session === '') {
    throw new InvalidInputError('session', 'must be a launch id, a Kiro session id or a label');
  }
  if (isLaunchId(session)) {
    const run = await readVisibleRun(scope, session);
    if (run === undefined) {
      throw notFound(session);
    }
    return run;
  }
  const runs = await scanVisibleRuns(scope);
  const byKiroId = runs.filter((run) => run.meta.kiroSessionId === session);
  if (byKiroId.length > 0) {
    return pick(session, byKiroId);
  }
  const byLabel = runs.filter((run) => run.meta.label === session);
  if (byLabel.length > 0) {
    return pick(session, byLabel);
  }
  throw notFound(session);
}
