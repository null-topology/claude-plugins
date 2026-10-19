/**
 * The startup sweep: once, after the MCP handshake, the server settles the
 * runs that a dead server left behind on this host.
 *
 * - First, it lists the containers labelled with this host's id and removes
 *   each whose labelled driver (pid and start time) is dead, whatever its
 *   run's state and whether its run directory exists. A container whose
 *   driver is alive, or that carries another host's id, stays. Without a
 *   docker CLI on PATH there is nothing to list, and nothing is reported.
 * - A run whose driver is alive, or on another host, is never touched.
 * - For a run whose driver is dead the sweep takes the session mutex (a
 *   `send`, `cancel` or `stop` of that run then answers `E_BUSY`, and a run
 *   whose mutex a call already holds is left to that call) and the stale run
 *   lock, and reads `meta.json` again under the lock. Then, for a run still
 *   `starting`, `idle` or `running`:
 *   - reaps: removes the run's containers by the launch label, and kills the
 *     recorded local child only while its pid still has the recorded start
 *     time. When the containers cannot be removed the run is left as it is
 *     for the next sweep to retry, and the steps below are skipped;
 *   - a run of this server's owner is adopted: its open turn gets an `exited`
 *     result (created once), the state becomes `exited` and this server
 *     becomes its driver;
 *   - a run of another owner gets a `lost` result for its open turn (created
 *     once) and the state `lost`;
 *   - a run still `starting` without a Kiro session id never started: of
 *     either owner, its open turn gets the result above (created once) and
 *     the state becomes `failed`, with the driver left as it was.
 *   A run that already ended keeps its state (`completed` included, 4.11)
 *   and is deleted with its directory once its `updatedAt` is older than
 *   `retention_days`, unless one of its turns has a claim that stays (below). A run settled now has a fresh `updatedAt`,
 *   and a run without a readable `meta.json` is never deleted.
 *   In every state it then removes the stale `turns/<n>.claimed` markers, so
 *   the turn's waiter can push the result: a marker stays while a call of
 *   this server holds the turn, or while the holder it records is alive or
 *   on another host; one that records no holder is taken as the dead
 *   driver's. It also removes the stale temp files of atomic writes in the
 *   run directory and in `turns/`. The lock is released at the end.
 * - After the runs, outside them:
 *   - a call record `calls/<tool use id>.json` whose mtime is older than
 *     `retention_days` is deleted, unless the driver it records is on
 *     another host, whose sweep deletes it; a record without a readable
 *     driver goes by its age alone. A waiter reads a record only while its
 *     hook runs, which the hook timeout ends within an hour, and
 *     `retention_days` is at least 1;
 *   - `hooks.log` is renamed to `hooks.log.1`, replacing it, when it is
 *     larger than `HOOKS_LOG_MAX_BYTES` or its mtime is older than
 *     `retention_days`; then `hooks.log.1` is deleted once its mtime is
 *     older than `retention_days`;
 *   - stale temp files of atomic writes in `calls/` are deleted.
 * - A temp file of an atomic write counts as stale once its mtime is
 *   `TEMP_FILE_MIN_AGE_MS` old: a writer holds its temp file only for one
 *   write and one rename or link.
 * - `homes/` is never cleaned.
 * - A failure of one run is reported and the sweep goes on with the next;
 *   once the server shuts down the sweep stops between runs.
 */

import { lstat, readdir, rename, rm } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { hooksLogPath, rotatedHooksLogPath } from '../hooks/log.ts';
import { errorCode, isTempName, readJsonIfExists } from '../store/files.ts';
import { DockerNotFoundError } from '../docker/cli.ts';
import type { HostContainer } from '../docker/remove.ts';
import { isProcessIdentity, liveness, localHostId, processStartTime } from '../store/identity.ts';
import type { ProcessIdentity } from '../store/identity.ts';
import { acquireRunLock } from '../store/lock.ts';
import type { RunLock } from '../store/lock.ts';
import { callsDir, isLaunchId, isValidToolUseId, runPaths, runsDir } from '../store/paths.ts';
import { createTurnResult, readMeta, readTurnResult, writeMeta } from '../store/runs.ts';
import type { ChildProcessRecord, RunMeta } from '../store/runs.ts';
import { stderrTail } from '../text/read.ts';
import { isoSeconds, readClaimHolder } from './claims.ts';
import { describeError } from './outcome.ts';
import { isLiveState } from './resolve.ts';
import { ADOPTED_ERROR, LOST_ERROR, endedWithoutResult } from './turn-result.ts';

/** What the sweep did with one run. */
export type SweepAction = 'adopted' | 'lost' | 'failed' | 'deleted' | 'untouched';

export interface SweepRunReport {
  readonly launchId: string;
  action: SweepAction;
  /** Why the run was left as it was, when it was. */
  skipped: string | null;
  /** The turn whose result the sweep created, if any. */
  resultCreated: number | null;
  readonly cleanedUp: string[];
  readonly failures: string[];
}

/** What the sweep removed outside the run directories, and what it failed on there. */
export interface SweepStateReport {
  readonly cleanedUp: string[];
  readonly failures: string[];
}

export interface SweepReport {
  /** The containers of this host whose labelled driver is dead, removed before the runs. */
  readonly containers: SweepStateReport;
  readonly runs: readonly SweepRunReport[];
  readonly state: SweepStateReport;
}

/** The outcome of running a body under a session's mutex. */
export type Exclusive<T> = { readonly ran: true; readonly value: T } | { readonly ran: false; readonly holder: string };

export interface SweepDeps {
  readonly stateDir: string;
  /** This server's owner key. */
  readonly owner: string;
  /** This server's identity: the driver it records and the lock holder. */
  readonly driver: ProcessIdentity;
  /** Runs `body` holding the session mutex of `launchId`, or names the call that holds it. */
  readonly exclusive: <T>(launchId: string, body: () => Promise<T>) => Promise<Exclusive<T>>;
  /** Removes the containers labelled with `launchId`; returns their ids; rejects when docker fails. */
  readonly removeContainers: (launchId: string) => Promise<readonly string[]>;
  /**
   * Lists the containers labelled with this server's host id; rejects when
   * docker fails, with `DockerNotFoundError` when there is no docker CLI.
   */
  readonly listHostContainers: () => Promise<readonly HostContainer[]>;
  /** Removes containers by id; returns the ids docker removed; rejects when docker fails. */
  readonly removeContainersById: (ids: readonly string[]) => Promise<readonly string[]>;
  /** Kills a recorded local child, only while its pid still has the recorded start time. */
  readonly killChild: (child: ChildProcessRecord, report: SweepRunReport) => Promise<void>;
  /** True while a call of this server holds the claim on the turn. */
  readonly claimHeld: (launchId: string, turn: number) => boolean;
  /** True once the server is shutting down. */
  readonly stopped: () => boolean;
  /** Ended runs, call records and `hooks.log` older than this many days are deleted. */
  readonly retentionDays: number;
  readonly now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `hooks.log` larger than this is rotated by the sweep. */
export const HOOKS_LOG_MAX_BYTES = 1024 * 1024;

/** How old a temp file of an atomic write must be before the sweep deletes it. */
export const TEMP_FILE_MIN_AGE_MS = DAY_MS;

const CLAIMED_PATTERN = /^([1-9][0-9]*)\.claimed$/;
const CALL_RECORD_SUFFIX = '.json';

/**
 * Sweeps every run of the state directory, one after the other, then the
 * call records and `hooks.log`.
 */
export async function sweepRuns(deps: SweepDeps): Promise<SweepReport> {
  const containers: SweepStateReport = { cleanedUp: [], failures: [] };
  if (!deps.stopped()) {
    await sweepHostContainers(deps, containers).catch((error: unknown) =>
      containers.failures.push(`containers: ${describeError(error)}`),
    );
  }
  const runs = await sweepRunDirectories(deps);
  const state: SweepStateReport = { cleanedUp: [], failures: [] };
  if (!deps.stopped()) {
    await sweepCalls(deps, state).catch((error: unknown) => state.failures.push(`calls: ${describeError(error)}`));
  }
  if (!deps.stopped()) {
    await sweepHooksLog(deps, state).catch((error: unknown) => state.failures.push(`hooks.log: ${describeError(error)}`));
  }
  return { containers, runs, state };
}

/**
 * Removes every container labelled with this host's id whose labelled driver
 * is dead, whatever its run's state and whether its run directory exists. A
 * container whose driver labels are missing, or whose driver cannot be
 * checked, stays. Without a docker CLI on PATH there is no container to
 * sweep, and nothing is reported.
 */
async function sweepHostContainers(deps: SweepDeps, report: SweepStateReport): Promise<void> {
  let listed: readonly HostContainer[];
  try {
    listed = await deps.listHostContainers();
  } catch (error) {
    if (error instanceof DockerNotFoundError) {
      return;
    }
    throw error;
  }
  const dead: HostContainer[] = [];
  for (const container of listed) {
    if (container.driver === null) {
      continue;
    }
    let startTime: string | null;
    try {
      startTime = await processStartTime(container.driver.pid);
    } catch (error) {
      report.failures.push(`container ${container.id.slice(0, 12)} kept, its driver not checked: ${describeError(error)}`);
      continue;
    }
    if (startTime !== container.driver.startTime) {
      dead.push(container);
    }
  }
  const removed = new Set(await deps.removeContainersById(dead.map(({ id }) => id)));
  for (const { id, launchId } of dead) {
    if (removed.has(id)) {
      report.cleanedUp.push(`container ${id.slice(0, 12)}${launchId === null ? '' : ` of ${launchId}`} removed: its driver is dead`);
    }
  }
}

async function sweepRunDirectories(deps: SweepDeps): Promise<SweepRunReport[]> {
  let names: string[];
  try {
    names = await readdir(runsDir(deps.stateDir));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const runs: SweepRunReport[] = [];
  for (const launchId of names.filter(isLaunchId).sort()) {
    if (deps.stopped()) {
      break;
    }
    const report = newReport(launchId);
    runs.push(report);
    try {
      await sweepRun(deps, report);
    } catch (error) {
      report.failures.push(describeError(error));
    }
  }
  return runs;
}

async function sweepRun(deps: SweepDeps, report: SweepRunReport): Promise<void> {
  const { launchId } = report;
  const seen = await readMeta(deps.stateDir, launchId);
  if (seen === undefined) {
    report.skipped = 'no meta.json';
    return;
  }
  const state = await liveness(seen.driver);
  if (state !== 'dead') {
    report.skipped = `driver ${state}`;
    return;
  }
  const outcome = await deps.exclusive(launchId, () => sweepDeadRun(deps, report));
  if (!outcome.ran) {
    report.skipped = `busy with a ${outcome.holder} call`;
  }
}

async function sweepDeadRun(deps: SweepDeps, report: SweepRunReport): Promise<void> {
  const { launchId } = report;
  const attempt = await acquireRunLock(deps.stateDir, launchId, deps.driver);
  if (!attempt.acquired) {
    report.skipped = `lock ${attempt.reason}`;
    return;
  }
  const { lock } = attempt;
  try {
    // Another server's sweep may have settled the run before this one took the lock.
    const meta = await readMeta(deps.stateDir, launchId);
    if (meta === undefined) {
      report.skipped = 'no meta.json';
      return;
    }
    const state = await liveness(meta.driver);
    if (state !== 'dead') {
      report.skipped = `driver ${state}`;
      return;
    }
    if (isLiveState(meta.state)) {
      if (await reap(deps, meta, report)) {
        await settle(deps, lock, meta, report);
      } else {
        // Left as it is, so the next sweep tries the removal again.
        report.skipped = `state ${meta.state}, not settled: its containers could not be removed`;
      }
    } else if (pastRetention(deps, meta.updatedAt)) {
      const held: number[] = [];
      for (const marker of await claimMarkers(deps.stateDir, launchId)) {
        const standing = await claimStanding(deps, launchId, marker);
        if (standing.kind !== 'stale' && standing.kind !== 'gone') {
          held.push(marker.turn);
        }
      }
      if (held.length === 0) {
        await deleteRun(deps, launchId, report);
        return;
      }
      report.skipped = `state ${meta.state}, past retention, kept while a call holds turn ${held.join(', ')}`;
    } else {
      report.skipped = `state ${meta.state}`;
    }
    await removeStaleClaims(deps, launchId, report);
    await removeStaleTemps(deps, launchId, report);
  } finally {
    await lock.release().catch((error: unknown) => report.failures.push(`lock release: ${describeError(error)}`));
  }
}

/** Removes the run's containers and kills its child; false when the containers could not be removed. */
async function reap(deps: SweepDeps, meta: RunMeta, report: SweepRunReport): Promise<boolean> {
  let removedAll = true;
  if (meta.mode === 'docker') {
    try {
      const removed = await deps.removeContainers(meta.launchId);
      for (const id of removed) {
        report.cleanedUp.push(`container ${id.slice(0, 12)} removed`);
      }
    } catch (error) {
      report.failures.push(`containers: ${describeError(error)}`);
      removedAll = false;
    }
  }
  if (meta.child !== null) {
    await deps.killChild(meta.child, report);
  }
  return removedAll;
}

/**
 * Ends the open turn and writes the run's new state: `failed` for a start
 * that never got a Kiro session, else `exited` for an own run and `lost` for
 * another owner's.
 */
async function settle(deps: SweepDeps, lock: RunLock, meta: RunMeta, report: SweepRunReport): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const own = meta.ownerKey === deps.owner;
  const turn = meta.currentTurn;
  if (turn > 0 && (await readTurnResult(deps.stateDir, meta.launchId, turn)) === undefined) {
    const result = endedWithoutResult(meta, turn, {
      outcome: own ? 'exited' : 'lost',
      error: own ? ADOPTED_ERROR : LOST_ERROR,
      startedAt: turnOpenedAt(meta, now),
      endedAt: now,
      stderrTail: readStderrTail(deps.stateDir, meta.launchId),
    });
    if (await createTurnResult(deps.stateDir, meta.launchId, turn, result)) {
      report.resultCreated = turn;
    }
  }
  if (meta.state === 'starting' && meta.kiroSessionId === null) {
    // Recorded the way a failed start is: it cannot be resumed, so it is not adopted either.
    await writeMeta(lock, { ...meta, state: 'failed', updatedAt: isoSeconds(now) });
    report.action = 'failed';
    return;
  }
  const updated: RunMeta = own
    ? { ...meta, state: 'exited', driver: deps.driver, updatedAt: isoSeconds(now) }
    : { ...meta, state: 'lost', updatedAt: isoSeconds(now) };
  await writeMeta(lock, updated);
  report.action = own ? 'adopted' : 'lost';
}

/**
 * When the open turn began: the run's last `meta.json` write, which opened
 * it, while that is a valid time not after `now`; otherwise `now`.
 */
function turnOpenedAt(meta: RunMeta, now: Date): Date {
  const opened = Date.parse(meta.updatedAt);
  return Number.isFinite(opened) && opened <= now.getTime() ? new Date(opened) : now;
}

function readStderrTail(stateDir: string, launchId: string): string | null {
  try {
    return stderrTail(runPaths(stateDir, launchId).stderrLog);
  } catch {
    return null;
  }
}

/** The names in `dir`; none when it does not exist. */
async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/** The stats of `path` when it is a regular file; undefined when it is missing or something else. */
async function fileStats(path: string): Promise<Stats | undefined> {
  try {
    const stats = await lstat(path);
    return stats.isFile() ? stats : undefined;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** Deletes `path` when it is a regular file last modified before `cutoffMs`; true when it did. */
async function removeIfOlder(path: string, cutoffMs: number): Promise<boolean> {
  const stats = await fileStats(path);
  if (stats === undefined || stats.mtimeMs >= cutoffMs) {
    return false;
  }
  await rm(path, { force: true });
  return true;
}

function currentTime(deps: SweepDeps): number {
  return (deps.now?.() ?? new Date()).getTime();
}

/** The time before which an ended run, a call record or `hooks.log` is past retention. */
function retentionCutoff(deps: SweepDeps): number {
  return currentTime(deps) - deps.retentionDays * DAY_MS;
}

function pastRetention(deps: SweepDeps, at: string): boolean {
  const time = Date.parse(at);
  return Number.isFinite(time) && time < retentionCutoff(deps);
}

async function deleteRun(deps: SweepDeps, launchId: string, report: SweepRunReport): Promise<void> {
  // Retried as a purge is: a waiter's heartbeat can recreate `turns/<n>.armed` while the tree goes.
  await rm(runPaths(deps.stateDir, launchId).dir, { recursive: true, force: true, maxRetries: 3 });
  report.action = 'deleted';
}

/** The `turns/<n>.claimed` markers of a run. */
async function claimMarkers(stateDir: string, launchId: string): Promise<{ readonly name: string; readonly turn: number }[]> {
  const markers: { name: string; turn: number }[] = [];
  for (const name of await listNames(runPaths(stateDir, launchId).turns)) {
    const match = CLAIMED_PATTERN.exec(name);
    if (match !== null) {
      markers.push({ name, turn: Number(match[1]) });
    }
  }
  return markers;
}

/** Whether a claim marker stays, read right before it would be removed. */
type ClaimStanding =
  /** A call of this server holds the turn. */
  | { readonly kind: 'held' }
  /** Its recorded holder is dead on this host, or it records none. */
  | { readonly kind: 'stale' }
  | { readonly kind: 'gone' }
  /** Its recorded holder is alive or on another host. */
  | { readonly kind: 'kept'; readonly why: string }
  /** Its holder could not be read or checked; it stays. */
  | { readonly kind: 'unchecked'; readonly error: string };

async function claimStanding(
  deps: SweepDeps,
  launchId: string,
  marker: { readonly name: string; readonly turn: number },
): Promise<ClaimStanding> {
  if (deps.claimHeld(launchId, marker.turn)) {
    return { kind: 'held' };
  }
  try {
    const holder = await readClaimHolder(join(runPaths(deps.stateDir, launchId).turns, marker.name));
    if (holder === undefined) {
      return { kind: 'gone' };
    }
    // A marker that records no holder is left by the run's driver, which is dead.
    if (holder === null) {
      return { kind: 'stale' };
    }
    const state = await liveness(holder);
    if (state === 'dead') {
      return { kind: 'stale' };
    }
    return { kind: 'kept', why: state === 'alive' ? 'holder alive' : 'holder on another host' };
  } catch (error) {
    return { kind: 'unchecked', error: describeError(error) };
  }
}

async function removeStaleClaims(deps: SweepDeps, launchId: string, report: SweepRunReport): Promise<void> {
  const turnsDir = runPaths(deps.stateDir, launchId).turns;
  for (const marker of await claimMarkers(deps.stateDir, launchId)) {
    const standing = await claimStanding(deps, launchId, marker);
    switch (standing.kind) {
      case 'stale':
        await rm(join(turnsDir, marker.name), { force: true });
        report.cleanedUp.push(`turns/${marker.name} removed`);
        break;
      case 'kept':
        report.cleanedUp.push(`turns/${marker.name} kept: ${standing.why}`);
        break;
      case 'unchecked':
        report.failures.push(`turns/${marker.name} kept, its holder not checked: ${standing.error}`);
        break;
      case 'held':
      case 'gone':
        break;
    }
  }
}

/** Deletes the stale temp files of atomic writes in the run directory and in `turns/`. */
async function removeStaleTemps(deps: SweepDeps, launchId: string, report: SweepRunReport): Promise<void> {
  const paths = runPaths(deps.stateDir, launchId);
  const cutoff = currentTime(deps) - TEMP_FILE_MIN_AGE_MS;
  for (const [dir, prefix] of [[paths.dir, ''], [paths.turns, 'turns/']] as const) {
    for (const name of await listNames(dir)) {
      if (isTempName(name) && (await removeIfOlder(join(dir, name), cutoff))) {
        report.cleanedUp.push(`${prefix}${name} removed`);
      }
    }
  }
}

function isCallRecordName(name: string): boolean {
  return name.endsWith(CALL_RECORD_SUFFIX) && isValidToolUseId(name.slice(0, -CALL_RECORD_SUFFIX.length));
}

/**
 * Whether a call record names a driver on another host, whose sweep deletes
 * it. A record without a readable driver, such as an older failed record,
 * names none.
 */
async function isRecordOfAnotherHost(path: string): Promise<boolean> {
  let value: unknown;
  try {
    value = await readJsonIfExists(path);
  } catch {
    return false;
  }
  const driver = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).driver : undefined;
  return isProcessIdentity(driver) && driver.hostId !== (await localHostId());
}

/** Deletes the call records past retention and the stale temp files of `calls/`. */
async function sweepCalls(deps: SweepDeps, report: SweepStateReport): Promise<void> {
  const dir = callsDir(deps.stateDir);
  const recordCutoff = retentionCutoff(deps);
  const tempCutoff = currentTime(deps) - TEMP_FILE_MIN_AGE_MS;
  let records = 0;
  let foreign = 0;
  let temps = 0;
  for (const name of await listNames(dir)) {
    const path = join(dir, name);
    if (isCallRecordName(name)) {
      const stats = await fileStats(path);
      if (stats === undefined || stats.mtimeMs >= recordCutoff) {
        continue;
      }
      if (await isRecordOfAnotherHost(path)) {
        foreign += 1;
        continue;
      }
      await rm(path, { force: true });
      records += 1;
    } else if (isTempName(name)) {
      temps += (await removeIfOlder(path, tempCutoff)) ? 1 : 0;
    }
  }
  if (records > 0) {
    report.cleanedUp.push(`calls: ${records} records older than ${deps.retentionDays} days removed`);
  }
  if (foreign > 0) {
    report.cleanedUp.push(`calls: ${foreign} records older than ${deps.retentionDays} days kept: their driver is on another host`);
  }
  if (temps > 0) {
    report.cleanedUp.push(`calls: ${temps} stale temp files removed`);
  }
}

/**
 * Bounds `hooks.log`: rotates it to `hooks.log.1` when it is too large or
 * past retention, then deletes `hooks.log.1` once it is past retention.
 */
async function sweepHooksLog(deps: SweepDeps, report: SweepStateReport): Promise<void> {
  const cutoff = retentionCutoff(deps);
  const log = hooksLogPath(deps.stateDir);
  const rotated = rotatedHooksLogPath(deps.stateDir);
  const stats = await fileStats(log);
  if (stats !== undefined && (stats.size > HOOKS_LOG_MAX_BYTES || stats.mtimeMs < cutoff)) {
    await rename(log, rotated);
    report.cleanedUp.push('hooks.log rotated to hooks.log.1');
  }
  if (await removeIfOlder(rotated, cutoff)) {
    report.cleanedUp.push('hooks.log.1 removed');
  }
}

function newReport(launchId: string): SweepRunReport {
  return { launchId, action: 'untouched', skipped: null, resultCreated: null, cleanedUp: [], failures: [] };
}

const ACTION_TEXT: Record<Exclude<SweepAction, 'untouched'>, string> = {
  adopted: 'adopted, state exited',
  lost: 'state lost',
  failed: 'state failed',
  deleted: 'past retention, run directory deleted',
};

/**
 * One diagnostic line per run the sweep changed or failed on, none for a run
 * it left alone, and one for what it did outside the runs, if anything.
 */
export function sweepLogLines(report: SweepReport): string[] {
  const lines: string[] = [];
  const containers = [...report.containers.cleanedUp, ...report.containers.failures.map((failure) => `failed: ${failure}`)];
  if (containers.length > 0) {
    lines.push(`host containers: ${containers.join('; ')}`);
  }
  for (const run of report.runs) {
    const done: string[] = [];
    if (run.action !== 'untouched') {
      done.push(ACTION_TEXT[run.action]);
    }
    if (run.resultCreated !== null) {
      done.push(`turn ${run.resultCreated} result created`);
    }
    done.push(...run.cleanedUp);
    done.push(...run.failures.map((failure) => `failed: ${failure}`));
    if (done.length > 0) {
      lines.push(`${run.launchId}: ${done.join('; ')}`);
    }
  }
  const state = [...report.state.cleanedUp, ...report.state.failures.map((failure) => `failed: ${failure}`)];
  if (state.length > 0) {
    lines.push(`state directory: ${state.join('; ')}`);
  }
  return lines;
}
