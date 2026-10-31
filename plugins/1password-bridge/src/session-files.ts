/**
 * The small per-session files the hooks, the broker and the exit trap share:
 * `last-seen` (its mtime is the session's last hook run), `session.json` (the
 * directory the session started in) and `masked` (ids of tickets whose value
 * is masked, one per line, never a value). Only the broker writes `masked`;
 * it exists only while it lists an id, so its existence is the check.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { lastSeenPath, maskedMarkerPath, sessionDir, sessionInfoPath } from './paths.ts';

function errCode(err: unknown): unknown {
  return err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
}

/** Writes `text` to `path` (mode 0600) through a temporary file and a rename. */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Sets the mtime of the session's `last-seen` to `now`, creating the file and its directory if needed. */
export function touchLastSeen(stateDir: string, id: string, now: number): void {
  const path = lastSeenPath(stateDir, id);
  const time = new Date(now);
  try {
    utimesSync(path, time, time);
  } catch (err) {
    if (errCode(err) !== 'ENOENT') throw err;
    mkdirSync(sessionDir(stateDir, id), { recursive: true, mode: 0o700 });
    writeFileSync(path, '', { mode: 0o600 });
    utimesSync(path, time, time);
  }
}

/** What `session.json` holds. */
export interface SessionInfo {
  /** The directory the session started in (the SessionStart payload's `cwd`). */
  cwd?: string;
}

/** Records the session info in `session.json`, replacing it whole. */
export function writeSessionInfo(stateDir: string, id: string, info: SessionInfo): void {
  writeAtomic(sessionInfoPath(stateDir, id), `${JSON.stringify(info)}\n`);
}

/** The recorded session info; empty when the file is missing or broken. */
export function readSessionInfo(stateDir: string, id: string): SessionInfo {
  try {
    const parsed: unknown = JSON.parse(readFileSync(sessionInfoPath(stateDir, id), 'utf8'));
    const cwd = parsed !== null && typeof parsed === 'object' ? (parsed as { cwd?: unknown }).cwd : undefined;
    return typeof cwd === 'string' ? { cwd } : {};
  } catch {
    return {};
  }
}

/** The ticket ids in the session's marker; undefined when there is no marker. */
export function readMarker(stateDir: string, id: string): string[] | undefined {
  let text: string;
  try {
    text = readFileSync(maskedMarkerPath(stateDir, id), 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') return undefined;
    throw err;
  }
  return text.split('\n').filter((line) => line !== '');
}

/** Adds `ticket` to the marker, creating it; an id already listed changes nothing. */
export function markTicket(stateDir: string, id: string, ticket: string): void {
  const ids = readMarker(stateDir, id) ?? [];
  if (!ids.includes(ticket)) writeAtomic(maskedMarkerPath(stateDir, id), `${[...ids, ticket].join('\n')}\n`);
}

/** Removes `tickets` from the marker, and the marker with its last id. */
export function unmarkTickets(stateDir: string, id: string, tickets: readonly string[]): void {
  const ids = readMarker(stateDir, id);
  if (ids === undefined) return;
  const left = ids.filter((t) => !tickets.includes(t));
  if (left.length === ids.length) return;
  if (left.length === 0) rmSync(maskedMarkerPath(stateDir, id), { force: true });
  else writeAtomic(maskedMarkerPath(stateDir, id), `${left.join('\n')}\n`);
}
