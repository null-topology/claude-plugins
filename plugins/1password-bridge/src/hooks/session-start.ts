/**
 * SessionStart: prepares the session directory and records where the
 * session started, tells the session's shells where `op-bridge`, the state
 * directory and the exit trap are, removes 0.1.0 leftovers, sweeps
 * directories of sessions long gone, and reports missing dependencies.
 *
 * Claude Code runs `CLAUDE_ENV_FILE` before every Bash command, so the lines
 * appended here put `<plugin root>/bin` on PATH, export OP_BRIDGE_STATE_DIR
 * (Bash commands do not get CLAUDE_PLUGIN_DATA) and source the static EXIT
 * trap of `bin/exit-trap.sh` in every later command.
 */

import { appendFileSync, chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isSessionId, lastSeenPath, sessionDir, sessionsDir } from '../paths.ts';
import { touchLastSeen, writeSessionInfo } from '../session-files.ts';
import { SWEEP_AGE_MS } from '../session-lifetime.ts';
import { liveSessionId, type HookContext, type HookOutput } from './common.ts';
import { diagnosticsOutput, missingDependencies, SYSTEM_PROBE, type SystemProbe } from './diagnostics.ts';
import { logHookError } from './log.ts';

export { SWEEP_AGE_MS };

/** What 0.1.0 kept per session: the grants and the env file its shells sourced. */
const LEGACY_FILES = ['grants.json', 'env'];

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** `s` safe inside double quotes: `\`, `"`, `$` and backquote escaped. */
function inDoubleQuotes(s: string): string {
  return s.replace(/[\\"$`]/g, '\\$&');
}

/** The line that puts `<pluginRoot>/bin` first on PATH. */
export function pathLine(pluginRoot: string): string {
  return `export PATH="${inDoubleQuotes(pluginRoot)}/bin:$PATH"`;
}

/** The line that tells the CLI and the exit trap where the state directory is. */
export function stateDirLine(stateDir: string): string {
  return `export OP_BRIDGE_STATE_DIR=${shellQuote(stateDir)}`;
}

/** The line that sources `<pluginRoot>/bin/exit-trap.sh` when it exists. */
export function exitTrapLine(pluginRoot: string): string {
  const quoted = shellQuote(join(pluginRoot, 'bin', 'exit-trap.sh'));
  return `[ -f ${quoted} ] && . ${quoted}`;
}

function errCode(err: unknown): unknown {
  return err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
}

/**
 * Whether `content` holds `statement` whole: starting the content or right
 * after a `\n`, and ending the content or right before one. A statement spans
 * several lines when a path in it holds a line break.
 */
function holdsStatement(content: string, statement: string): boolean {
  return `\n${content}\n`.includes(`\n${statement}\n`);
}

/** Appends `statement` to `file` unless it already holds that statement. */
function appendLine(file: string, statement: string): void {
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch (err) {
    if (errCode(err) !== 'ENOENT') throw err;
  }
  if (holdsStatement(current, statement)) return;
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  appendFileSync(file, `${separator}${statement}\n`);
}

/** When the session was last seen: its `last-seen` file, else its directory (a 0.1.0 one has no `last-seen`). */
function lastSeen(stateDir: string, id: string, dirMtimeMs: number): number {
  try {
    return statSync(lastSeenPath(stateDir, id)).mtimeMs;
  } catch {
    return dirMtimeMs;
  }
}

/** Removes 0.1.0 leftovers from every session directory, and every directory but `keep` not seen for SWEEP_AGE_MS. */
export function sweepSessions(stateDir: string, keep: string | undefined, now: number): void {
  let names: string[];
  try {
    names = readdirSync(sessionsDir(stateDir));
  } catch (err) {
    if (errCode(err) === 'ENOENT') return;
    throw err;
  }
  for (const name of names) {
    if (!isSessionId(name)) continue;
    const dir = sessionDir(stateDir, name);
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory()) continue;
      // A leftover that cannot be deleted (a directory, say) blocks neither the other one nor the age check.
      for (const file of LEGACY_FILES) {
        try {
          rmSync(join(dir, file), { force: true });
        } catch (err) {
          logHookError(stateDir, 'SessionStart', 'legacy', err);
        }
      }
      if (name !== keep && now - lastSeen(stateDir, name, stat.mtimeMs) > SWEEP_AGE_MS) rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      logHookError(stateDir, 'SessionStart', 'sweep', err);
    }
  }
}

export function sessionStart(ctx: HookContext, probe: SystemProbe = SYSTEM_PROBE, now: number = Date.now()): HookOutput | undefined {
  const id = liveSessionId(ctx.input);
  if (id !== undefined) {
    try {
      const dir = sessionDir(ctx.stateDir, id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      // A resumed session is marked live, so the sweep spares it.
      touchLastSeen(ctx.stateDir, id, now);
      const cwd = ctx.input['cwd'];
      if (typeof cwd === 'string' && cwd !== '') writeSessionInfo(ctx.stateDir, id, { cwd });
      const envFile = ctx.env['CLAUDE_ENV_FILE'];
      if (envFile !== undefined && envFile !== '') {
        appendLine(envFile, stateDirLine(ctx.stateDir));
        if (ctx.pluginRoot !== '') {
          appendLine(envFile, pathLine(ctx.pluginRoot));
          appendLine(envFile, exitTrapLine(ctx.pluginRoot));
        }
      }
    } catch (err) {
      logHookError(ctx.stateDir, 'SessionStart', 'session', err);
    }
  }
  try {
    sweepSessions(ctx.stateDir, id, now);
  } catch (err) {
    logHookError(ctx.stateDir, 'SessionStart', 'sweep', err);
  }
  return diagnosticsOutput(missingDependencies(ctx.env, probe));
}
