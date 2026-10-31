/**
 * Where the plugin keeps its state, and the names of everything inside it.
 *
 * Every id that becomes a path segment is checked here, so no caller can
 * build a path outside the state directory from an untrusted value.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { PROTOCOL_VERSION } from './version.ts';

export type Environment = Readonly<Record<string, string | undefined>>;

export const STATE_DIR_NAME = '1password-bridge';

/**
 * The longest socket path used inside the state directory. A Unix socket path
 * is limited to 104 bytes on macOS and 108 on Linux; 100 leaves a margin.
 */
export const MAX_SOCKET_PATH_BYTES = 100;

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The state directory: `CLAUDE_PLUGIN_DATA` when set, else
 * `$XDG_STATE_HOME/1password-bridge`, else `~/.local/state/1password-bridge`. A
 * relative `XDG_STATE_HOME` is ignored, as the XDG base directory rules say.
 */
export function resolveStateDir(env: Environment = process.env): string {
  const pluginData = env.CLAUDE_PLUGIN_DATA;
  if (pluginData !== undefined && pluginData !== '') {
    return resolve(pluginData);
  }
  const xdgState = env.XDG_STATE_HOME;
  if (xdgState !== undefined && isAbsolute(xdgState)) {
    return join(xdgState, STATE_DIR_NAME);
  }
  const home = env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir();
  return join(home, '.local', 'state', STATE_DIR_NAME);
}

/** True for a Claude Code session id that is safe as one path segment. */
export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

/** `<stateDir>/sessions`, the parent of every session directory. */
export function sessionsDir(stateDir: string): string {
  return join(stateDir, 'sessions');
}

/** `<stateDir>/sessions/<id>`; throws on an id that is not a safe path segment. */
export function sessionDir(stateDir: string, sessionId: string): string {
  if (!isSessionId(sessionId)) {
    throw new TypeError(`Invalid session id ${JSON.stringify(sessionId)}`);
  }
  return join(sessionsDir(stateDir), sessionId);
}

/** The session's board of running commands (`src/board.ts`). */
export function boardDir(stateDir: string, id: string): string {
  return join(sessionDir(stateDir, id), 'board');
}

/** The marker the hooks and the exit trap check: ids of tickets whose value is masked. */
export function maskedMarkerPath(stateDir: string, id: string): string {
  return join(sessionDir(stateDir, id), 'masked');
}

/** Touched by every hook run except SessionEnd; the sweep keys on its mtime. */
export function lastSeenPath(stateDir: string, id: string): string {
  return join(sessionDir(stateDir, id), 'last-seen');
}

/** What SessionStart records for the window: the directory the session started in. */
export function sessionInfoPath(stateDir: string, id: string): string {
  return join(sessionDir(stateDir, id), 'session.json');
}

/**
 * The broker's socket: `<stateDir>/run/broker-v<N>.sock`. When that path is
 * longer than 100 bytes, `<runtimeDir>/1password-bridge/broker-v<N>.sock`, if
 * `runtimeDir` (`XDG_RUNTIME_DIR`) is absolute and the path fits in 100 bytes;
 * else `<tmp>/1password-bridge-<uid>/broker-v<N>.sock`. The runtime directory
 * is private to the user, `tmp` may be shared, which is why the client checks
 * the owner and mode of the socket's directory before it connects. The
 * protocol version is in the name, so brokers of two plugin versions with
 * different protocols never answer each other's clients.
 */
export function socketPath(stateDir: string, uid: number, tmp: string, runtimeDir: string | undefined): string {
  const name = `broker-v${PROTOCOL_VERSION}.sock`;
  const preferred = join(stateDir, 'run', name);
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) {
    return preferred;
  }
  if (runtimeDir !== undefined && isAbsolute(runtimeDir)) {
    const runtime = join(runtimeDir, STATE_DIR_NAME, name);
    if (Buffer.byteLength(runtime) <= MAX_SOCKET_PATH_BYTES) {
      return runtime;
    }
  }
  return join(tmp, `${STATE_DIR_NAME}-${uid}`, name);
}
