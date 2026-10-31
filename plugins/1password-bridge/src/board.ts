/**
 * The board: one file per Bash command a session is running now, written by
 * the hooks, read by the broker to attribute a `redeem` to an agent. An entry
 * holds the command text and the directory it runs in, never a value.
 *
 * `<tool_use_id>.json` is a foreground command; PostToolUse renames it to
 * `bg-<backgroundTaskId>.json` when the command goes on in the background,
 * after setting the file's mtime to the time of the move. A foreground entry
 * older than the larger of its timeout and the ticket lifetime, plus 30 s, is
 * left over (an interrupt, a subagent killed without SubagentStop): readers
 * ignore it and the next hook run deletes it. A scan never misses an entry
 * that exists all through it, even one renamed meanwhile (see `list`).
 */

import { readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { boardDir, type Environment } from './paths.ts';
import { writeAtomic } from './session-files.ts';
import { TICKET_TTL_MS } from './ticket-lifetime.ts';

/** A command's timeout when neither its tool input nor `$BASH_MAX_TIMEOUT_MS` sets one. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
/** How long past the larger of its timeout and the ticket lifetime a foreground entry still counts as running. */
export const STALE_GRACE_MS = 30_000;
/**
 * How long before the hook process started a background entry must have moved
 * for a prune whose task list does not name it to delete it. The list is a
 * snapshot Claude Code takes before it starts the hook, so a task moved after
 * the snapshot must keep its entry. This is an assumed bound on the delay
 * between the snapshot and the hook's start, not a proven one.
 */
export const BACKGROUND_PRUNE_MARGIN_MS = 10_000;
/** How many passes a scan makes while entries move under it before it settles for their union. */
export const MAX_SCAN_ATTEMPTS = 5;

/** A tool_use_id or background task id that is safe as a file name. */
const FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BACKGROUND_PREFIX = 'bg-';

/** One command on the board, as its file holds it. */
export interface BoardEntry {
  /** The subagent's agent_id, or `main`. */
  agent_id: string;
  agent_type?: string;
  tool_use_id: string;
  command: string;
  cwd: string;
  /** When PreToolUse wrote the entry, in ms since the epoch. */
  startedAt: number;
  /** The command's timeout (`commandTimeoutMs`). */
  timeoutMs: number;
}

/** An entry `readBoard` counts as running; `background` marks a `bg-` file. */
export interface LiveEntry extends BoardEntry {
  background: boolean;
}

function errCode(err: unknown): unknown {
  return err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
}

function positive(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Whether `id` starts with the background prefix, which the board refuses as a tool_use_id. */
export function hasBackgroundPrefix(id: string): boolean {
  return id.startsWith(BACKGROUND_PREFIX);
}

/** Whether the board can name a background entry after task `id`: safe as a file name. */
export function isTaskId(id: string): boolean {
  return FILE_ID.test(id);
}

/** A tool_use_id safe as a file name that a scan cannot take for a background entry. */
function isForegroundId(id: string): boolean {
  return FILE_ID.test(id) && !hasBackgroundPrefix(id);
}

/** The command's timeout: the tool input's, else `$BASH_MAX_TIMEOUT_MS`, else 600 s. */
export function commandTimeoutMs(toolInput: unknown, env: Environment): number {
  const own = toolInput !== null && typeof toolInput === 'object' ? (toolInput as { timeout?: unknown }).timeout : undefined;
  return positive(own) ?? positive(env['BASH_MAX_TIMEOUT_MS']) ?? DEFAULT_COMMAND_TIMEOUT_MS;
}

/** Puts a foreground command on the board; a tool_use_id unsafe as a file name or starting with `bg-` writes nothing. */
export function writeEntry(stateDir: string, session: string, entry: BoardEntry): void {
  if (!isForegroundId(entry.tool_use_id)) return;
  writeAtomic(join(boardDir(stateDir, session), `${entry.tool_use_id}.json`), JSON.stringify(entry));
}

/** Takes a foreground command off the board; never touches a background entry. */
export function removeEntry(stateDir: string, session: string, toolUseId: string): void {
  if (!isForegroundId(toolUseId)) return;
  rmSync(join(boardDir(stateDir, session), `${toolUseId}.json`), { force: true });
}

/**
 * Turns the foreground entry of `toolUseId` into the background entry of
 * `taskId`; a missing entry is left alone. The mtime is set to `now` before
 * the rename, so the background file carries the time of its move:
 * `pruneBackground` keys on it, since a command can move long after it
 * started (at its timeout). When setting it fails, the rename still happens.
 */
export function moveToBackground(stateDir: string, session: string, toolUseId: string, taskId: string, now: number = Date.now()): void {
  if (!isForegroundId(toolUseId) || !isTaskId(taskId)) return;
  const dir = boardDir(stateDir, session);
  const from = join(dir, `${toolUseId}.json`);
  const time = new Date(now);
  try {
    utimesSync(from, time, time);
  } catch {
    // The rename matters more: left in the foreground, the running command
    // drops off the board at its agent's Stop or past its age limit; moved
    // with its write time, only a prune racing the move can drop it. A missing
    // entry fails the rename too, and is left alone there.
  }
  try {
    renameSync(from, join(dir, `${BACKGROUND_PREFIX}${taskId}.json`));
  } catch (err) {
    if (errCode(err) !== 'ENOENT') throw err;
  }
}

function parseEntry(text: string): BoardEntry | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (v === null || typeof v !== 'object') return undefined;
  const e = v as Record<string, unknown>;
  const { agent_id, agent_type, tool_use_id, command, cwd, startedAt, timeoutMs } = e;
  if (typeof agent_id !== 'string' || typeof tool_use_id !== 'string' || typeof command !== 'string' || typeof cwd !== 'string') return undefined;
  if (typeof startedAt !== 'number' || typeof timeoutMs !== 'number') return undefined;
  if (agent_type !== undefined && typeof agent_type !== 'string') return undefined;
  const entry: BoardEntry = { agent_id, tool_use_id, command, cwd, startedAt, timeoutMs };
  if (agent_type !== undefined) entry.agent_type = agent_type;
  return entry;
}

interface Listed {
  path: string;
  /** The task id of a background entry, else undefined. */
  taskId: string | undefined;
  entry: BoardEntry | undefined;
}

/** The `.json` names in the board directory; none while it does not exist. */
function listNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (err) {
    if (errCode(err) === 'ENOENT') return [];
    throw err;
  }
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  const names = new Set(a);
  return a.length === b.length && b.every((name) => names.has(name));
}

/**
 * Every board file with its entry. A rename to the background can make an
 * entry vanish between the listing and its read, and a listing taken while
 * the rename lands may hold neither name, so a pass counts only when every
 * listed file was read and a second listing names the same files; otherwise
 * it is repeated. When no pass settles within MAX_SCAN_ATTEMPTS, the result
 * is the union of all passes, each entry in its latest form: it may hold a
 * command that ended meanwhile, never miss one that ran throughout.
 */
function list(stateDir: string, session: string): Listed[] {
  const dir = boardDir(stateDir, session);
  const seen = new Map<string, Listed>();
  for (let attempt = 0; attempt < MAX_SCAN_ATTEMPTS; attempt += 1) {
    const names = listNames(dir);
    const pass: Listed[] = [];
    let vanished = false;
    for (const name of names) {
      const path = join(dir, name);
      let entry: BoardEntry | undefined;
      try {
        entry = parseEntry(readFileSync(path, 'utf8'));
      } catch (err) {
        // Gone since the listing: the command ended, or moved to a name this pass may not hold.
        if (errCode(err) !== 'ENOENT') throw err;
        vanished = true;
        continue;
      }
      const base = name.slice(0, -'.json'.length);
      pass.push({ path, taskId: base.startsWith(BACKGROUND_PREFIX) ? base.slice(BACKGROUND_PREFIX.length) : undefined, entry });
    }
    if (!vanished && sameNames(names, listNames(dir))) return pass;
    // An entry keeps its tool_use_id through the move, so a later pass's background form replaces the foreground one.
    for (const item of pass) seen.set(item.entry === undefined ? `path:${item.path}` : `id:${item.entry.tool_use_id}`, item);
  }
  return [...seen.values()];
}

/**
 * Whether a foreground entry is past its age limit: the larger of its timeout
 * and the ticket lifetime, plus STALE_GRACE_MS. PreToolUse writes the entry
 * before the permission decision, so its clock may start while a prompt is
 * still open; the ticket-lifetime floor keeps the entry live for as long as
 * any ticket its command could name can be redeemed.
 */
function stale(entry: BoardEntry, now: number): boolean {
  return now - entry.startedAt > Math.max(entry.timeoutMs, TICKET_TTL_MS) + STALE_GRACE_MS;
}

/**
 * The session's live entries: background ones, and foreground ones within the
 * age limit. Never omits a command running all through the call; while
 * entries keep moving it may still list one that ended during it.
 */
export function readBoard(stateDir: string, session: string, now: number): LiveEntry[] {
  const out: LiveEntry[] = [];
  for (const { taskId, entry } of list(stateDir, session)) {
    if (entry === undefined) continue;
    const background = taskId !== undefined;
    if (!background && stale(entry, now)) continue;
    out.push({ ...entry, background });
  }
  return out;
}

/** Deletes foreground entries past the age limit, and unreadable ones. */
export function pruneStale(stateDir: string, session: string, now: number): void {
  for (const { path, taskId, entry } of list(stateDir, session)) {
    if (taskId === undefined && (entry === undefined || stale(entry, now))) rmSync(path, { force: true });
  }
}

/** Deletes the foreground entries of `agentId` (Stop for `main`, SubagentStop for a subagent). */
export function pruneForeground(stateDir: string, session: string, agentId: string): void {
  for (const { path, taskId, entry } of list(stateDir, session)) {
    if (taskId === undefined && entry?.agent_id === agentId) rmSync(path, { force: true });
  }
}

/**
 * Deletes background entries whose task is not in `live`, the task list of a
 * Stop or SubagentStop payload. `hookStart` is when the hook process began,
 * `performance.timeOrigin` by default: the list was taken before it, and
 * counting from it rather than from this call keeps the hook's own run time
 * out of the margin. An entry that moved to the background less than
 * BACKGROUND_PRUNE_MARGIN_MS before `hookStart` stays, since its task may
 * postdate the list. It then stays until a later Stop or SubagentStop prune
 * deletes it, however long that takes, not for the margin alone; meanwhile
 * `readBoard` lists it as running. In a process that handles more than one
 * payload the default bound is older than the payload, which only keeps more.
 */
export function pruneBackground(stateDir: string, session: string, live: ReadonlySet<string>, hookStart: number = performance.timeOrigin): void {
  const movedBefore = hookStart - BACKGROUND_PRUNE_MARGIN_MS;
  for (const { path, taskId } of list(stateDir, session)) {
    if (taskId === undefined || live.has(taskId)) continue;
    const movedAt = statSync(path, { throwIfNoEntry: false })?.mtimeMs;
    if (movedAt !== undefined && movedAt < movedBefore) rmSync(path, { force: true });
  }
}
