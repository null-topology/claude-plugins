/**
 * Local mode: Kiro CLI runs on the host as a direct child of the server.
 *
 * The child gets an allowlisted environment built from the server's own
 * environment. Nothing else is inherited, and no `CLAUDE_*` variable ever
 * reaches the child. `KIRO_API_KEY` is never copied from the server: the
 * child gets the token only as an override.
 */
import { readProxyEnvironment } from '../settings.ts';
import type { Environment, ProxyEnvironment } from '../settings.ts';
import { spawnProcess } from './process.ts';
import type { ProcessHandle, ProcessOptions, ProcessSpec } from './process.ts';

/** Arguments after `kiro_command` that start Kiro's ACP agent on the v3 engine. */
export const LOCAL_KIRO_ARGS: readonly string[] = Object.freeze(['acp', '--agent-engine', 'v3']);

/** Variables copied from the server environment when they are set. */
export const LOCAL_ENV_NAMES: readonly string[] = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'TERM',
  'TMPDIR',
  'KIRO_HOME',
]);

/** Prefixes of variables copied from the server environment. */
export const LOCAL_ENV_PREFIXES: readonly string[] = Object.freeze(['LC_']);

/** Variables with this prefix are never passed to the child. */
export const STRIPPED_ENV_PREFIX = 'CLAUDE_';

/** Values the caller sets for the child instead of the server's own. */
export interface LocalEnvironmentOverrides {
  readonly KIRO_HOME?: string;
  readonly KIRO_API_KEY?: string;
  /**
   * The proxy variables of the `proxy` and `no_proxy` settings; each one
   * replaces the server's own variable of that name.
   */
  readonly proxy?: ProxyEnvironment;
}

/**
 * Builds the child environment: the allowlisted names and prefixes, plus the
 * proxy variables that are set in the server environment, passed unchanged
 * unless a proxy override replaces them.
 */
export function buildLocalEnvironment(
  serverEnv: Environment,
  overrides: LocalEnvironmentOverrides = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(serverEnv)) {
    if (value === undefined || name.startsWith(STRIPPED_ENV_PREFIX)) {
      continue;
    }
    if (LOCAL_ENV_NAMES.includes(name) || LOCAL_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      env[name] = value;
    }
  }
  for (const [name, value] of Object.entries({ ...readProxyEnvironment(serverEnv), ...overrides.proxy })) {
    if (value !== undefined) {
      env[name] = value;
    }
  }
  if (overrides.KIRO_HOME !== undefined) {
    env.KIRO_HOME = overrides.KIRO_HOME;
  }
  if (overrides.KIRO_API_KEY !== undefined) {
    env.KIRO_API_KEY = overrides.KIRO_API_KEY;
  }
  return env;
}

export interface LocalKiroOptions {
  /** The `kiro_command` setting: the executable to run. */
  readonly kiroCommand: string;
  /** The session's working directory; the child's cwd. */
  readonly dir: string;
  /** The server's own environment, filtered by {@link buildLocalEnvironment}. */
  readonly serverEnv: Environment;
  readonly overrides?: LocalEnvironmentOverrides;
}

/** The process spec for a local Kiro ACP agent. */
export function localKiroSpec(options: LocalKiroOptions): ProcessSpec {
  if (options.kiroCommand === '') {
    throw new TypeError('kiroCommand must not be empty');
  }
  return Object.freeze({
    argv: Object.freeze([options.kiroCommand, ...LOCAL_KIRO_ARGS]),
    env: Object.freeze(buildLocalEnvironment(options.serverEnv, options.overrides)),
    cwd: options.dir,
    processGroup: true,
  });
}

/** Starts a local Kiro ACP agent. */
export function spawnLocalKiro(options: LocalKiroOptions, processOptions: ProcessOptions = {}): ProcessHandle {
  return spawnProcess(localKiroSpec(options), processOptions);
}
