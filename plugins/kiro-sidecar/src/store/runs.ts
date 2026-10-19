/**
 * Runs on disk: the run directory, `meta.json`, the `calls/` records, the
 * Claude session log and the turn results, plus the shared homes.
 *
 * `meta.json` has one writer, the holder of the run's lock: `writeMeta` takes
 * the held lock and checks it against the lock file before every write.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Mode } from '../settings.ts';
import {
  DIR_MODE,
  FILE_MODE,
  appendJsonLine,
  createJsonOnce,
  ensureDir,
  errorCode,
  readJsonIfExists,
  writeJsonAtomic,
} from './files.ts';
import { isProcessIdentity, liveness } from './identity.ts';
import type { ProcessIdentity } from './identity.ts';
import { RunLock } from './lock.ts';
import {
  callPath,
  callsDir,
  homePaths,
  isLaunchId,
  newLaunchId,
  runPaths,
  runsDir,
  turnPaths,
} from './paths.ts';
import type { HomePaths, RunPaths } from './paths.ts';

export const RUN_STATES = Object.freeze([
  'starting',
  'idle',
  'running',
  'exited',
  'stopped',
  /** Kiro called `complete_task` and the plugin closed the session; never resumable. */
  'completed',
  'lost',
  'failed',
] as const);

export type RunState = (typeof RUN_STATES)[number];

export type Permissions = 'allow' | 'deny';

export type TokenSource = 'preset' | 'api_key';

/** The Kiro process of a local run. */
export interface ChildProcessRecord {
  readonly pid: number;
  readonly startTime: string;
}

export interface RunMeta {
  readonly launchId: string;
  /** Null until Kiro answers `session/new` or `session/load`. */
  readonly kiroSessionId: string | null;
  readonly ownerKey: string;
  readonly driver: ProcessIdentity;
  /** The home name or home key. */
  readonly home: string;
  readonly projectDir: string | null;
  readonly label: string | null;
  readonly mode: Mode;
  readonly dir: string;
  readonly dirReadOnly: boolean;
  readonly mounts: readonly string[];
  /** Skill names. */
  readonly skills: readonly string[];
  /** Source paths of the steering files. */
  readonly steering: readonly string[];
  readonly model: string | null;
  readonly effort: string | null;
  readonly kiroMode: string | null;
  readonly permissions: Permissions;
  readonly preset: string | null;
  /** Every run started now has a token; null is accepted only in records written without one. */
  readonly tokenSource: TokenSource | null;
  readonly image: string | null;
  readonly dockerUser: string | null;
  readonly containerName: string | null;
  /** The Kiro child process of a local run. */
  readonly child: ChildProcessRecord | null;
  readonly state: RunState;
  /** The last opened turn; 0 before the first. */
  readonly currentTurn: number;
  readonly firstPromptPreview: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type Check = (value: unknown) => boolean;

const isString: Check = (value) => typeof value === 'string';
const isBoolean: Check = (value) => typeof value === 'boolean';
const isStringList: Check = (value) => Array.isArray(value) && value.every(isString);
const isTurnCount: Check = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isOneOf =
  (allowed: readonly string[]): Check =>
  (value) =>
    typeof value === 'string' && allowed.includes(value);
const isNullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const isChild: Check = (value) => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { pid, startTime } = value as Record<string, unknown>;
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && isString(startTime);
};

const META_FIELDS: { readonly [K in keyof RunMeta]-?: Check } = {
  launchId: (value) => typeof value === 'string' && isLaunchId(value),
  kiroSessionId: isNullable(isString),
  ownerKey: isString,
  driver: isProcessIdentity,
  home: isString,
  projectDir: isNullable(isString),
  label: isNullable(isString),
  mode: isOneOf(['local', 'docker']),
  dir: isString,
  dirReadOnly: isBoolean,
  mounts: isStringList,
  skills: isStringList,
  steering: isStringList,
  model: isNullable(isString),
  effort: isNullable(isString),
  kiroMode: isNullable(isString),
  permissions: isOneOf(['allow', 'deny']),
  preset: isNullable(isString),
  tokenSource: isNullable(isOneOf(['preset', 'api_key'])),
  image: isNullable(isString),
  dockerUser: isNullable(isString),
  containerName: isNullable(isString),
  child: isNullable(isChild),
  state: isOneOf(RUN_STATES),
  currentTurn: isTurnCount,
  firstPromptPreview: isNullable(isString),
  createdAt: isString,
  updatedAt: isString,
};

/** Checks every field of a parsed `meta.json`; throws naming the first bad one. */
export function parseRunMeta(value: unknown): RunMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Malformed meta.json: not an object');
  }
  const record = value as Record<string, unknown>;
  for (const [field, check] of Object.entries(META_FIELDS)) {
    if (!check(record[field])) {
      throw new Error(`Malformed meta.json: bad field ${field}`);
    }
  }
  return record as unknown as RunMeta;
}

export interface CreatedRun {
  readonly launchId: string;
  readonly paths: RunPaths;
}

/** Creates a new run directory, with its `turns/`, under a fresh launch id. */
export async function createRun(stateDir: string): Promise<CreatedRun> {
  await ensureDir(runsDir(stateDir));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const launchId = newLaunchId();
    const paths = runPaths(stateDir, launchId);
    try {
      await mkdir(paths.dir, { mode: DIR_MODE });
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        continue;
      }
      throw error;
    }
    await mkdir(paths.turns, { mode: DIR_MODE });
    return { launchId, paths };
  }
  throw new Error('Could not find an unused launch id');
}

/** The run's metadata, or undefined when it has no `meta.json`. */
export async function readMeta(stateDir: string, launchId: string): Promise<RunMeta | undefined> {
  const value = await readJsonIfExists(runPaths(stateDir, launchId).meta);
  return value === undefined ? undefined : parseRunMeta(value);
}

/**
 * Writes the run's `meta.json` atomically. Only the holder of the run's lock
 * may: the lock must be a live handle for the same run, still named in the
 * lock file.
 */
export async function writeMeta(lock: RunLock, meta: RunMeta): Promise<void> {
  if (!(lock instanceof RunLock)) {
    throw new TypeError('writeMeta needs the held run lock');
  }
  if (meta.launchId !== lock.launchId) {
    throw new Error(`The lock of ${lock.launchId} does not cover ${meta.launchId}`);
  }
  parseRunMeta(meta);
  await lock.assertHeld();
  await writeJsonAtomic(runPaths(lock.stateDir, meta.launchId).meta, meta);
}

/**
 * The state a reader reports: a run still marked `idle` or `running` whose
 * driver is dead on this host is `lost`. A driver on another host is never
 * judged, so its run keeps the recorded state.
 */
export async function observedState(meta: RunMeta): Promise<RunState> {
  if (meta.state !== 'idle' && meta.state !== 'running') {
    return meta.state;
  }
  return (await liveness(meta.driver)) === 'dead' ? 'lost' : meta.state;
}

export interface CallRecord {
  readonly launchId: string;
  /** The turn the call opened; null when it opened none. */
  readonly turn: number | null;
  readonly driver: ProcessIdentity;
}

/**
 * A recorded call that failed. It keeps the run, turn and driver of the
 * record it replaced; a record written without them has none.
 */
export interface FailedCallRecord extends Partial<CallRecord> {
  readonly failed: true;
  readonly error: string;
}

/**
 * Records the run and turn of a tool call, once. Returns false, keeping the
 * first record, when the call is already recorded. Throws on an invalid id;
 * check it with `isValidToolUseId` first.
 */
export async function recordCall(
  stateDir: string,
  toolUseId: string,
  record: CallRecord,
): Promise<boolean> {
  const path = callPath(stateDir, toolUseId);
  await ensureDir(callsDir(stateDir));
  const { launchId, turn, driver } = record;
  return createJsonOnce(path, { launchId, turn, driver });
}

/**
 * Replaces the record of a tool call with its failure, keeping the run, turn
 * and driver of `record`, the record it replaces.
 */
export async function recordCallFailure(
  stateDir: string,
  toolUseId: string,
  error: string,
  record?: CallRecord,
): Promise<void> {
  const path = callPath(stateDir, toolUseId);
  await ensureDir(callsDir(stateDir));
  const failure: FailedCallRecord =
    record === undefined
      ? { failed: true, error }
      : { launchId: record.launchId, turn: record.turn, driver: record.driver, failed: true, error };
  await writeJsonAtomic(path, failure);
}

/** The run, turn and driver of a parsed call record, or undefined when any is missing or invalid. */
function callLocation(record: Record<string, unknown>): CallRecord | undefined {
  const { launchId, turn, driver } = record;
  if (
    typeof launchId === 'string' &&
    isLaunchId(launchId) &&
    (turn === null || (typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 1)) &&
    isProcessIdentity(driver)
  ) {
    return { launchId, turn, driver };
  }
  return undefined;
}

/**
 * The record of a tool call, or undefined when there is none. A failed record
 * carries its run, turn and driver only when all three are valid; without
 * them it still reads as failed.
 */
export async function readCall(
  stateDir: string,
  toolUseId: string,
): Promise<CallRecord | FailedCallRecord | undefined> {
  const value = await readJsonIfExists(callPath(stateDir, toolUseId));
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const location = callLocation(record);
    if (record.failed === true && isString(record.error)) {
      const error = record.error as string;
      return location === undefined ? { failed: true, error } : { ...location, failed: true, error };
    }
    if (location !== undefined) {
      return location;
    }
  }
  throw new Error(`Malformed call record for ${toolUseId}`);
}

export interface ClaudeSessionEntry {
  /** The Claude session id. */
  readonly id: string;
  readonly event: string;
  /** ISO 8601 time. */
  readonly at: string;
  readonly agentType?: string;
}

/** Appends one line to the run's `claude-sessions.jsonl`; `at` defaults to now. */
export async function appendClaudeSession(
  stateDir: string,
  launchId: string,
  entry: Omit<ClaudeSessionEntry, 'at'> & { readonly at?: string },
): Promise<ClaudeSessionEntry> {
  const line: ClaudeSessionEntry = {
    id: entry.id,
    event: entry.event,
    at: entry.at ?? new Date().toISOString(),
    ...(entry.agentType === undefined ? {} : { agentType: entry.agentType }),
  };
  await appendJsonLine(runPaths(stateDir, launchId).claudeSessions, line);
  return line;
}

/**
 * The entries of the run's `claude-sessions.jsonl` in order. A line that is
 * not a complete entry (a write cut short by a crash) is skipped.
 */
export async function readClaudeSessions(
  stateDir: string,
  launchId: string,
): Promise<ClaudeSessionEntry[]> {
  let text: string;
  try {
    text = await readFile(runPaths(stateDir, launchId).claudeSessions, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }
  const entries: ClaudeSessionEntry[] = [];
  for (const line of text.split('\n')) {
    if (line === '') {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      const { id, event, at, agentType } = value as Record<string, unknown>;
      if (isString(id) && isString(event) && isString(at)) {
        entries.push({
          id: id as string,
          event: event as string,
          at: at as string,
          ...(isString(agentType) ? { agentType: agentType as string } : {}),
        });
      }
    }
  }
  return entries;
}

/**
 * Creates `turns/<turn>.json` with the turn's result, once. Returns false,
 * keeping the first result, when the turn already has one.
 */
export async function createTurnResult(
  stateDir: string,
  launchId: string,
  turn: number,
  result: object,
): Promise<boolean> {
  return createJsonOnce(turnPaths(stateDir, launchId, turn).result, result);
}

/** The result of a turn, or undefined while it has none. */
export async function readTurnResult(
  stateDir: string,
  launchId: string,
  turn: number,
): Promise<unknown> {
  return readJsonIfExists(turnPaths(stateDir, launchId, turn).result);
}

/**
 * Creates the home directory with its `skills/` and `steering/`, each only
 * when it is missing: what the home already holds is kept.
 */
export async function ensureHome(stateDir: string, home: string): Promise<HomePaths> {
  const paths = homePaths(stateDir, home);
  await ensureDir(paths.skills);
  await ensureDir(paths.steering);
  return paths;
}

/**
 * Creates the run's `skills/` and `steering/`, where its own copies go, each
 * only when it is missing: what they already hold is kept.
 */
export async function ensureRunCopyDirs(stateDir: string, launchId: string): Promise<RunPaths> {
  const paths = runPaths(stateDir, launchId);
  await ensureDir(paths.skills);
  await ensureDir(paths.steering);
  return paths;
}

/**
 * Writes the run's `task.md`, the copy of its `prompt_file`, byte for byte
 * and private to the owner. The file must not exist yet.
 */
export async function writeTaskCopy(stateDir: string, launchId: string, content: Uint8Array): Promise<string> {
  const { task } = runPaths(stateDir, launchId);
  await writeFile(task, content, { mode: FILE_MODE, flag: 'wx' });
  return task;
}
