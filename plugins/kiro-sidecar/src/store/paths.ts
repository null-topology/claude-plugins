/**
 * Where the plugin keeps its state, and the names of everything inside it.
 *
 * Every id that becomes a path segment is checked here, so no caller can
 * build a path outside the state directory from an untrusted value.
 */

import { createHash, randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { isValidHomeName } from '../home-name.ts';
import type { Environment } from '../settings.ts';

export const STATE_DIR_NAME = 'kiro-sidecar';

/** The home used when there is no override and no startup directory. */
export const DEFAULT_HOME = 'default';

/**
 * The state directory: `CLAUDE_PLUGIN_DATA` when set, else
 * `$XDG_STATE_HOME/kiro-sidecar`, else `~/.local/state/kiro-sidecar`. A
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

/**
 * The readable part of a home key is at most this long, so the whole key
 * (readable part, `-`, 8 hex digits) fits the 255 bytes of one path segment.
 */
const HOME_KEY_READABLE_MAX = 246;

const HOME_KEY_PATTERN = /^[A-Za-z0-9-]{0,246}-[0-9a-f]{8}$/;

/**
 * The home key of a resolved startup directory: every character other than
 * an ASCII letter or digit becomes `-`, then `-` and the first 8 hex digits of
 * the path's sha256 keep two paths with the same encoding apart. An encoding
 * longer than 246 characters keeps only its last 246, where the project's
 * directory name is; the digest is still of the full path, so two paths cut
 * to the same tail stay apart.
 */
export function encodeHomeKey(realPath: string): string {
  const digest = createHash('sha256').update(realPath).digest('hex').slice(0, 8);
  const readable = realPath.replace(/[^A-Za-z0-9]/g, '-');
  return `${readable.slice(-HOME_KEY_READABLE_MAX)}-${digest}`;
}

/**
 * The name of the home a run uses: the override when given (it must be a
 * valid home name), else the key of the startup directory resolved with
 * `realpath`, else `default`.
 */
export async function resolveHomeName(options: {
  readonly override?: string | undefined;
  readonly projectDir?: string | undefined;
}): Promise<string> {
  const { override, projectDir } = options;
  if (override !== undefined && override !== '') {
    if (!isValidHomeName(override)) {
      throw new TypeError(`Invalid home name ${JSON.stringify(override)}`);
    }
    return override;
  }
  if (projectDir !== undefined && projectDir !== '') {
    return encodeHomeKey(await realpath(projectDir));
  }
  return DEFAULT_HOME;
}

/** True for a valid home name or a home key: either is one safe path segment. */
export function isHomeDirName(name: string): boolean {
  return isValidHomeName(name) || HOME_KEY_PATTERN.test(name);
}

export interface HomePaths {
  readonly dir: string;
  readonly skills: string;
  readonly steering: string;
}

export function homePaths(stateDir: string, home: string): HomePaths {
  if (!isHomeDirName(home)) {
    throw new TypeError(`Invalid home ${JSON.stringify(home)}`);
  }
  const dir = join(stateDir, 'homes', home);
  return { dir, skills: join(dir, 'skills'), steering: join(dir, 'steering') };
}

const LAUNCH_ID_PATTERN = /^ks_[0-9a-f]{12}$/;
const TOOL_USE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** A new run id: `ks_` and 12 random hex digits. */
export function newLaunchId(): string {
  return `ks_${randomBytes(6).toString('hex')}`;
}

export function isLaunchId(value: string): boolean {
  return LAUNCH_ID_PATTERN.test(value);
}

/** A tool use id that may name a `calls/` record. */
export function isValidToolUseId(value: string): boolean {
  return TOOL_USE_ID_PATTERN.test(value);
}

export function runsDir(stateDir: string): string {
  return join(stateDir, 'runs');
}

export function callsDir(stateDir: string): string {
  return join(stateDir, 'calls');
}

export interface RunPaths {
  readonly dir: string;
  readonly meta: string;
  readonly lock: string;
  readonly claudeSessions: string;
  readonly acpLog: string;
  readonly stderrLog: string;
  readonly turns: string;
  /** The run's own skill copies, mounted over the home's `skills/` in docker mode. */
  readonly skills: string;
  /** The run's own steering copies, mounted over the home's `steering/` in docker mode. */
  readonly steering: string;
  /** The run's copy of `prompt_file`, mounted read-only in docker mode. */
  readonly task: string;
}

export function runPaths(stateDir: string, launchId: string): RunPaths {
  if (!isLaunchId(launchId)) {
    throw new TypeError(`Invalid launch id ${JSON.stringify(launchId)}`);
  }
  const dir = join(runsDir(stateDir), launchId);
  return {
    dir,
    meta: join(dir, 'meta.json'),
    lock: join(dir, 'lock'),
    claudeSessions: join(dir, 'claude-sessions.jsonl'),
    acpLog: join(dir, 'acp.jsonl'),
    stderrLog: join(dir, 'stderr.log'),
    turns: join(dir, 'turns'),
    skills: join(dir, 'skills'),
    steering: join(dir, 'steering'),
    task: join(dir, 'task.md'),
  };
}

export interface TurnPaths {
  /** The turn result, created once when the turn ends. */
  readonly result: string;
  /** The full agent text of the turn. */
  readonly text: string;
  /** The agent text while it is still streaming. */
  readonly partial: string;
  readonly armed: string;
  readonly claimed: string;
  readonly returned: string;
  readonly pushed: string;
}

/** Paths of turn `turn` (counted from 1) of a run. */
export function turnPaths(stateDir: string, launchId: string, turn: number): TurnPaths {
  if (!Number.isSafeInteger(turn) || turn < 1) {
    throw new TypeError(`Invalid turn number ${String(turn)}`);
  }
  const base = join(runPaths(stateDir, launchId).turns, String(turn));
  return {
    result: `${base}.json`,
    text: `${base}.md`,
    partial: `${base}.md.part`,
    armed: `${base}.armed`,
    claimed: `${base}.claimed`,
    returned: `${base}.returned`,
    pushed: `${base}.pushed`,
  };
}

export function callPath(stateDir: string, toolUseId: string): string {
  if (!isValidToolUseId(toolUseId)) {
    throw new TypeError(`Invalid tool use id ${JSON.stringify(toolUseId)}`);
  }
  return join(callsDir(stateDir), `${toolUseId}.json`);
}
