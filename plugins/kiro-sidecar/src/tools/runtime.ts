/**
 * What the tools run against, resolved lazily so the server answers the MCP
 * handshake and `tools/list` before anything slow or failing runs.
 *
 * - Settings are read when the runtime is built. Invalid settings do not stop
 *   the server: every tool call answers `E_INVALID` with the settings message.
 * - The state directory, the owner and driver identities, the home and the
 *   session manager are resolved on the first tool call and kept; a failed
 *   resolution is tried again on the next call.
 * - `sweep` runs the startup sweep once after the handshake; it resolves the
 *   context itself and only logs its failures. When the resolution fails,
 *   the sweep runs once after the next resolution that succeeds.
 * - `shutdown` runs the manager's shutdown once; later calls answer `E_BUSY`.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { TOKEN_VARIABLE } from '../docker/cli.ts';
import { SidecarError } from '../errors.ts';
import { SessionManager } from '../session/manager.ts';
import type { ControlLimits, ManagerDeps, ShutdownLimits, StartLimits } from '../session/manager.ts';
import { describeError } from '../session/outcome.ts';
import type { QueryDeps } from '../session/queries.ts';
import { sweepLogLines } from '../session/sweep.ts';
import { SettingsError, envName, loadSettings } from '../settings.ts';
import type { Environment, Settings } from '../settings.ts';
import { currentDriver, currentOwner, ownerKey } from '../store/identity.ts';
import type { ProcessIdentity } from '../store/identity.ts';
import { resolveHomeName, resolveStateDir } from '../store/paths.ts';
import { buildSecretSet } from '../text/redact.ts';
import type { SecretSet } from '../text/redact.ts';

export interface RuntimeOptions {
  /** The server's environment; default `process.env`. */
  readonly env?: Environment;
  /** Overrides the state directory resolved from the environment. */
  readonly stateDir?: string;
  readonly owner?: ProcessIdentity;
  readonly driver?: ProcessIdentity;
  readonly deps?: Partial<ManagerDeps>;
  readonly startLimits?: Partial<StartLimits>;
  readonly shutdownLimits?: Partial<ShutdownLimits>;
  readonly controlLimits?: Partial<ControlLimits>;
  /** The plugin's tool server file; default: next to the server bundle. Tests from source pass it in. */
  readonly toolServerFile?: string;
  /** How often `wait` looks for a running turn's result. */
  readonly pollMs?: number;
  /** How often `wait` reports progress. */
  readonly progressMs?: number;
  /** Writes one diagnostic line; default: stderr. Lines are redacted before. */
  readonly log?: (line: string) => void;
}

export interface ToolContext {
  readonly settings: Settings;
  readonly manager: SessionManager;
  readonly deps: QueryDeps;
}

/** How long `shutdown` waits for a first-call resolution still running. */
const CONTEXT_WAIT_MS = 100;

export class Runtime {
  readonly #options: RuntimeOptions;
  readonly #env: Environment;
  readonly #settings: Settings | SettingsError;
  readonly #secrets: SecretSet;
  #context: Promise<ToolContext> | undefined;
  #closing: Promise<void> | undefined;
  #sweep: Promise<void> | undefined;
  /** True while a startup sweep skipped for a failed resolution waits for one that succeeds. */
  #sweepDeferred = false;

  constructor(options: RuntimeOptions = {}) {
    this.#options = options;
    this.#env = options.env ?? process.env;
    this.#settings = readSettings(this.#env);
    this.#secrets = replySecrets(this.#env);
  }

  /** Every secret this server knows of; tool replies and diagnostics are redacted with it. */
  get secrets(): SecretSet {
    return this.#secrets;
  }

  /** Writes one redacted diagnostic line. */
  log(line: string): void {
    const text = `kiro-sidecar: ${this.#secrets.redact(line)}`;
    if (this.#options.log !== undefined) {
      this.#options.log(text);
    } else {
      process.stderr.write(`${text}\n`);
    }
  }

  /** The tool context; resolved on the first call. */
  context(): Promise<ToolContext> {
    if (this.#closing !== undefined) {
      return Promise.reject(new SidecarError('E_BUSY', 'The server is shutting down'));
    }
    const settings = this.#settings;
    if (settings instanceof SettingsError) {
      return Promise.reject(new SidecarError('E_INVALID', settings.message));
    }
    if (this.#context === undefined) {
      const pending = this.#resolve(settings);
      this.#context = pending;
      pending.then(
        () => {
          if (this.#sweepDeferred && this.#closing === undefined) {
            this.#sweepDeferred = false;
            void this.sweep();
          }
        },
        () => {
          if (this.#context === pending) {
            this.#context = undefined;
          }
        },
      );
    }
    return this.#context;
  }

  /**
   * Runs the startup sweep once, after the MCP handshake; later calls join
   * it. It resolves the tool context first; when that fails, the sweep is
   * skipped and runs once after the next resolution that succeeds. It never
   * rejects: a failure is written to the log, and the server goes on
   * answering calls.
   */
  sweep(): Promise<void> {
    this.#sweep ??= this.#runSweep();
    return this.#sweep;
  }

  async #runSweep(): Promise<void> {
    let context: ToolContext;
    try {
      context = await this.context();
    } catch (error) {
      this.log(`startup sweep skipped: ${describeError(error)}`);
      this.#sweep = undefined;
      this.#sweepDeferred = true;
      return;
    }
    try {
      const report = await context.manager.sweep();
      for (const line of sweepLogLines(report)) {
        this.log(`startup sweep: ${line}`);
      }
    } catch (error) {
      this.log(`startup sweep failed: ${describeError(error)}`);
    }
  }

  /** Ends every session this server drives, once; resolves within the manager's budget. */
  shutdown(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  async #shutdown(): Promise<void> {
    const pending = this.#context;
    if (pending === undefined) {
      return;
    }
    const timer = new AbortController();
    const context = await Promise.race([
      pending.catch(() => undefined),
      sleep(CONTEXT_WAIT_MS, undefined, { signal: timer.signal }).catch(() => undefined),
    ]);
    timer.abort();
    await context?.manager.shutdown();
  }

  async #resolve(settings: Settings): Promise<ToolContext> {
    const options = this.#options;
    const env = this.#env;
    const stateDir = options.stateDir ?? resolveStateDir(env);
    const owner = options.owner ?? (await currentOwner());
    const driver = options.driver ?? (await currentDriver());
    const projectDir = nonEmpty(env['CLAUDE_PROJECT_DIR']);
    const home = await resolveHomeName({
      override: nonEmpty(settings.home) ?? undefined,
      projectDir: projectDir ?? undefined,
    });
    const manager = new SessionManager({
      settings,
      stateDir,
      env,
      projectDir,
      owner,
      driver,
      onError: (error, where) => this.log(`${where}: ${describeError(error)}`),
      ...(options.deps === undefined ? {} : { deps: options.deps }),
      ...(options.startLimits === undefined ? {} : { startLimits: options.startLimits }),
      ...(options.shutdownLimits === undefined ? {} : { shutdownLimits: options.shutdownLimits }),
      ...(options.controlLimits === undefined ? {} : { controlLimits: options.controlLimits }),
      ...(options.toolServerFile === undefined ? {} : { toolServerFile: options.toolServerFile }),
    });
    if (this.#closing !== undefined) {
      await manager.shutdown();
    }
    const deps: QueryDeps = {
      stateDir,
      home,
      owner: ownerKey(owner),
      live: manager,
      claim: (launchId, turn) => manager.claim(launchId, turn),
      pollMs: options.pollMs,
      progressMs: options.progressMs,
    };
    return { settings, manager, deps };
  }
}

function readSettings(env: Environment): Settings | SettingsError {
  try {
    return loadSettings(env);
  } catch (error) {
    if (error instanceof SettingsError) {
      return error;
    }
    throw error;
  }
}

/**
 * The secrets of the server's environment: the api key as given (even when
 * the settings refuse it), the server's own `KIRO_API_KEY` (no token source,
 * but a secret all the same), the messaging token, the proxy URLs and the
 * proxy setting.
 */
function replySecrets(env: Environment): SecretSet {
  // Neither is refused for its length here: replies are redacted even while the settings are invalid.
  return buildSecretSet({ env, kiroKeys: [env[envName('api_key')] ?? '', env[TOKEN_VARIABLE] ?? ''] });
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}
