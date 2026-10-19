/**
 * The session manager: starts Kiro sessions, runs their turns, and keeps the
 * live registry of the sessions this server drives.
 *
 * - `start` validates everything before it spawns, then creates the run, takes
 *   its lock, writes `meta.json` (`starting`), records the call, runs the host
 *   checks, copies the skills and steering files (docker), writes the
 *   protocol steering, spawns Kiro, and walks
 *   `initialize`, `session/new`, model, effort, Kiro mode and `tools` (the
 *   plugin's tool server connected), all within one deadline; then the
 *   options are read back, and a prompt is sent last and not awaited. A
 *   failure or a client abort kills the process, sets `failed`,
 *   rewrites the call record as failed and answers `E_STEP_<step>` with the
 *   stderr tail (or the code of the check that failed).
 * - `send` opens the next turn of an idle session. The manager never prompts
 *   a session that is `starting` or `running`: Kiro cancels a running turn
 *   when a second prompt arrives.
 * - A turn ends when `session/prompt` settles or the process exits; its text
 *   is finalized to `turns/<n>.md` before `turns/<n>.json` is created.
 * - A session whose process is gone becomes `exited`: its lock is released
 *   and it leaves the live registry.
 * - `send {interrupt}`, `cancel` and `stop` end a running turn. Each claims
 *   the turn (`turns/<n>.claimed`) before it asks Kiro to end it, so the
 *   waiter cannot push a result the call may return; a result returned in a
 *   reply gets `turns/<n>.returned` first. `send {interrupt}` and `cancel`
 *   send `session/cancel` and wait up to 10 s for the turn to end; an
 *   interrupt prompts the new turn only after the old one has ended.
 * - `stop` sends `session/close`, closes stdin, kills the process when it is
 *   still alive after 3 s, waits for the container removal, and sets
 *   `stopped`. A start that is still running is aborted instead and keeps
 *   `failed`. A run this server does not drive gets what is left cleaned up:
 *   its container, and its local child when the pid and start time still
 *   match. `purge` deletes the run directory, never the home.
 * - `shutdown` kills local children and removes containers within 500 ms;
 *   a running turn gets its `exited` result before it returns.
 */

import { rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { KiroAcpClient } from '../acp/client.ts';
import type { StepOptions } from '../acp/client.ts';
import { missingOptionError } from '../acp/config.ts';
import { AcpClientError } from '../acp/errors.ts';
import type { LifecycleEntry, TurnEvent } from '../acp/events.ts';
import { localKiroSpec } from '../acp/local.ts';
import type { LocalEnvironmentOverrides } from '../acp/local.ts';
import { spawnProcess } from '../acp/process.ts';
import type { ProcessHandle, ProcessOptions, ProcessSpec } from '../acp/process.ts';
import { TOKEN_VARIABLE, runDocker, stderrSummary, stripClaudeVariables } from '../docker/cli.ts';
import { checkImage } from '../docker/image.ts';
import {
  TASK_FILE_PROMPT,
  assertDockerImage,
  buildDockerLaunch,
  containerName,
  resolveMountSet,
  resolveWorkDir,
} from '../docker/launch.ts';
import type { MountRequest, MountSet } from '../docker/launch.ts';
import { ensureDir } from '../store/files.ts';
import { READ_ONLY_SUFFIX, formatMountSpec, parseMountSpec } from '../docker/mounts.ts';
import type { MountSpec, ResolvedMount } from '../docker/mounts.ts';
import {
  isRemovableContainerName,
  listHostContainers,
  removeContainersById,
  removeContainersByLabel,
  removeContainersDetached,
} from '../docker/remove.ts';
import type { HostContainer } from '../docker/remove.ts';
import { resolveDockerUser } from '../docker/user.ts';
import { SidecarError } from '../errors.ts';
import { HOME_NAME_RULE, isValidHomeName } from '../home-name.ts';
import { isLoopbackProxy, proxySettingsEnvironment } from '../settings.ts';
import type { Environment, Mode, Settings } from '../settings.ts';
import { currentDriver, currentOwner, liveness, ownerKey, processIdentity } from '../store/identity.ts';
import type { ProcessIdentity } from '../store/identity.ts';
import { acquireRunLock } from '../store/lock.ts';
import type { RunLock } from '../store/lock.ts';
import { isValidToolUseId, resolveHomeName, runPaths } from '../store/paths.ts';
import type { RunPaths } from '../store/paths.ts';
import {
  createRun,
  ensureHome,
  ensureRunCopyDirs,
  observedState,
  readMeta,
  readTurnResult,
  recordCall,
  recordCallFailure,
  writeMeta,
  writeTaskCopy,
} from '../store/runs.ts';
import type { CallRecord, Permissions, RunMeta, RunState } from '../store/runs.ts';
import { InvalidInputError } from '../text/errors.ts';
import { assertLabel, formatResultLine, formatTurnTrailer } from '../text/format.ts';
import { AcpLog, StderrLog } from '../text/log-files.ts';
import { firstPromptPreview, prepareDebugFrame } from '../text/preview.ts';
import { stderrTail } from '../text/read.ts';
import { buildSecretSet } from '../text/redact.ts';
import type { SecretSet } from '../text/redact.ts';
import { TurnClaims, isoSeconds } from './claims.ts';
import type { ReleaseClaim } from './claims.ts';
import { SessionMutex } from './mutex.ts';
import { readPromptFile } from './prompt-file.ts';
import type { PromptTask } from './prompt-file.ts';
import { sweepRuns } from './sweep.ts';
import type { SweepReport } from './sweep.ts';
import { decideOutcome, describeError } from './outcome.ts';
import { writeProtocolSteering } from './protocol-steering.ts';
import { copySkills, copySteering } from './run-copies.ts';
import { isOwnToolRequest } from './sidecar-calls.ts';
import { resolveSkills, skillSourcesFromEnv } from './skills.ts';
import type { ResolvedSkill } from './skills.ts';
import { resolveSteering } from './steering.ts';
import type { ResolvedSteering } from './steering.ts';
import type { TurnEnding } from './outcome.ts';
import { TurnRecorder } from './turn.ts';
import { SHUTDOWN_ERROR } from './turn-result.ts';
import {
  TOOL_SERVER_NAME,
  toolServerNotConnected,
  TOOL_SERVER_TOOLS,
  bundledToolServerFile,
  checkToolServerFile,
  toolServerConfig,
} from './tool-server.ts';
import type { EndedBy, LiveRegistry, LiveSession, TurnResult } from './types.ts';

/** Effort levels a `start` may ask for; Kiro decides which it offers per model. */
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'] as const);

/** `start` parameters that a later version handles. */
export const UNAVAILABLE_START_PARAMS = Object.freeze(['preset'] as const);

/** Kiro config option ids. */
const MODEL_OPTION = 'model';
const EFFORT_OPTION = 'effortLevel';
const KIRO_MODE_OPTION = 'mode';

export interface StartLimits {
  /** The whole `start` call, host checks included. */
  readonly deadlineMs: number;
  /** Spawn and `initialize`. */
  readonly initializeMs: number;
  readonly sessionNewMs: number;
  /** Each of the steps model, effort and kiro_mode: the wait for Kiro to offer the option, then its change. */
  readonly configMs: number;
  /** The step `tools`: until Kiro reports the plugin's tool server connected. */
  readonly toolsMs: number;
}

export const DEFAULT_START_LIMITS: StartLimits = Object.freeze({
  deadlineMs: 90_000,
  initializeMs: 45_000,
  sessionNewMs: 30_000,
  configMs: 15_000,
  toolsMs: 15_000,
});

export interface ShutdownLimits {
  /** Between SIGTERM and SIGKILL. */
  readonly graceMs: number;
  /** How long `shutdown` waits for the children before it returns. */
  readonly budgetMs: number;
}

export const DEFAULT_SHUTDOWN_LIMITS: ShutdownLimits = Object.freeze({ graceMs: 250, budgetMs: 450 });

/** Between SIGTERM and SIGKILL when a failed start or a dead stream ends a process. */
export const CLEANUP_KILL_GRACE_MS = 2_000;

export interface ControlLimits {
  /** How long `cancel` and `send {interrupt}` wait for the turn to end after `session/cancel`. */
  readonly cancelWaitMs: number;
  /** How long `stop` gives `session/close` and the exit after stdin is closed, together. */
  readonly stopGraceMs: number;
  /** Between SIGTERM and SIGKILL when `stop` kills a process. */
  readonly killGraceMs: number;
}

export const DEFAULT_CONTROL_LIMITS: ControlLimits = Object.freeze({
  cancelWaitMs: 10_000,
  stopGraceMs: 3_000,
  killGraceMs: CLEANUP_KILL_GRACE_MS,
});

/** How long `stop` waits for a session to finish ending once its process is gone. */
const SESSION_END_WAIT_MS = 10_000;

/** How long `stop` waits for `docker rm -f`. */
const CONTAINER_REMOVE_TIMEOUT_MS = 30_000;

/** The host operations the manager uses; tests replace them. */
export interface ManagerDeps {
  readonly spawn: (spec: ProcessSpec, options: ProcessOptions) => ProcessHandle;
  readonly resolveDockerUser: (setting: string, env: Environment) => Promise<string>;
  readonly checkImage: (image: string, env: Environment) => Promise<void>;
  /** Starts a removal and returns at once (shutdown, a failed start). */
  readonly removeContainers: (names: readonly string[], env: Environment) => void;
  /**
   * Removes one container and waits (`stop`): resolves true when docker
   * removed it, false when there was none; rejects when it could not be removed.
   */
  readonly removeContainer: (name: string, env: Environment) => Promise<boolean>;
  /** Removes every container labelled with a launch id and waits (the startup sweep). */
  readonly removeContainersByLabel: (launchId: string, env: Environment) => Promise<readonly string[]>;
  /** Lists every container labelled with a host id (the startup sweep). */
  readonly listHostContainers: (hostId: string, env: Environment) => Promise<readonly HostContainer[]>;
  /** Removes containers by id and waits; resolves to the ids docker removed (the startup sweep). */
  readonly removeContainersById: (ids: readonly string[], env: Environment) => Promise<readonly string[]>;
}

const DEFAULT_DEPS: ManagerDeps = Object.freeze({
  spawn: spawnProcess,
  resolveDockerUser,
  checkImage,
  removeContainers: removeContainersDetached,
  removeContainer: removeContainerNow,
  removeContainersByLabel,
  listHostContainers,
  removeContainersById,
});

export interface SessionManagerOptions {
  readonly settings: Settings;
  readonly stateDir: string;
  /** The server's own environment. */
  readonly env?: Environment;
  /** Claude's startup directory: the default home and `meta.projectDir`. */
  readonly projectDir?: string | null;
  /** The owner (the Claude process); default: this process's parent. */
  readonly owner?: ProcessIdentity;
  /** The driver (this server); default: this process. */
  readonly driver?: ProcessIdentity;
  readonly deps?: Partial<ManagerDeps>;
  readonly startLimits?: Partial<StartLimits>;
  readonly shutdownLimits?: Partial<ShutdownLimits>;
  readonly controlLimits?: Partial<ControlLimits>;
  /**
   * The plugin's tool server `sidecar-tools.js`; default: the file next to
   * the server bundle. Tests from source pass the path in.
   */
  readonly toolServerFile?: string;
  /** Failures of background work (turn ends, exits), which have no caller. */
  readonly onError?: (error: unknown, where: string) => void;
}

/** `start` parameters as the tool receives them. */
export interface StartParams {
  readonly mode?: string;
  readonly dir: string;
  readonly prompt?: string;
  readonly label?: string;
  readonly home?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly permissions?: string;
  readonly kiro_mode?: string;
  readonly image?: string;
  readonly preset?: unknown;
  readonly skills?: unknown;
  readonly steering?: unknown;
  readonly mounts?: unknown;
  readonly prompt_file?: unknown;
}

/** What a tool call brings besides its arguments. */
export interface CallContext {
  /** `_meta["claudecode/toolUseId"]`; ignored unless it is a valid id. */
  readonly toolUseId?: string;
  /** Aborts the call when the client cancels it. */
  readonly signal?: AbortSignal;
}

export interface StartResult {
  readonly launchId: string;
  readonly sessionId: string;
  readonly label: string | null;
  readonly mode: Mode;
  readonly dir: string;
  readonly home: string;
  /** As read back from Kiro. */
  readonly model: string | null;
  readonly effort: string | null;
  readonly kiroMode: string | null;
  readonly skills: readonly string[];
  readonly steering: readonly string[];
  readonly permissions: Permissions;
  /** The turn the prompt opened, or null without a prompt. */
  readonly turn: number | null;
  /** `kiro-turn: <launchId>#<n>` when a prompt was sent. */
  readonly trailer: string | null;
}

/** A turn whose result a call returns in its reply. */
export interface ReturnedTurn {
  readonly turn: number;
  readonly result: TurnResult;
  /** `kiro-result: <launchId>#<n>` */
  readonly resultLine: string;
}

export interface SendParams {
  readonly launchId: string;
  readonly text: string;
  /** Ends a running turn first (`session/cancel`) instead of answering `E_BUSY`. */
  readonly interrupt?: boolean;
}

export interface SendResult {
  readonly launchId: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly trailer: string;
  /** The turn the interrupt ended, returned in this reply; null when no turn was running. */
  readonly interrupted: ReturnedTurn | null;
}

export interface CancelParams {
  readonly launchId: string;
}

export interface CancelResult {
  readonly launchId: string;
  readonly sessionId: string | null;
  /** The state after the call; `cancelling` while the cancelled turn has not ended. */
  readonly state: RunState | 'cancelling';
  /** The turn that was cancelled; null when none was running. */
  readonly turn: number | null;
  /** Its result, when it ended within the wait. */
  readonly ended: ReturnedTurn | null;
}

export interface StopParams {
  readonly launchId: string;
  /** Also deletes the run directory; the home is never touched. */
  readonly purge?: boolean;
}

export interface StopResult {
  readonly launchId: string;
  readonly sessionId: string | null;
  /**
   * The state `status` reports after the stop: the recorded state, or `lost`
   * for a run recorded `idle` or `running` whose driver is dead.
   */
  readonly state: RunState;
  /** The running turn the stop ended, returned in this reply. */
  readonly ended: ReturnedTurn | null;
  /** What was cleaned up, in order. */
  readonly cleanedUp: readonly string[];
  /** What could not be cleaned up or changed. */
  readonly failures: readonly string[];
  /** The run directory was deleted. */
  readonly purged: boolean;
}

interface StopReport {
  readonly cleanedUp: string[];
  readonly failures: string[];
}

/** A turn that ended while this call held its claim. */
interface HeldTurn {
  readonly turn: number;
  readonly result: TurnResult;
  readonly release: ReleaseClaim;
}

/** A one-way gate: `promise` resolves once `open` is called. */
interface Latch {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

interface StartPlan {
  readonly mode: Mode;
  /** Resolved. */
  readonly dir: string;
  /** Docker only; false in local mode. */
  readonly dirReadOnly: boolean;
  /** Docker only, with resolved paths; empty in local mode. */
  readonly mounts: readonly MountSpec[];
  /**
   * Docker only: the mount set resolved at validation, which `docker run`
   * gets as it is once the same request resolves to it again right before
   * the command is built; null in local mode.
   */
  readonly mountSet: MountSet | null;
  /** Docker only: the request `mountSet` was resolved from; null in local mode. */
  readonly mountRequest: MountRequest | null;
  /** The text the first `session/prompt` sends, or null for an idle start. */
  readonly prompt: string | null;
  /** The `prompt_file` as read at validation, or null without one. */
  readonly task: PromptTask | null;
  readonly label: string | null;
  readonly home: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly kiroMode: string | null;
  readonly permissions: Permissions;
  readonly image: string | null;
  /** Docker only: the resolved skills, copied into the run at the spawn; empty in local mode. */
  readonly skills: readonly ResolvedSkill[];
  /** Docker only: the resolved steering files, copied into the run at the spawn; empty in local mode. */
  readonly steering: readonly ResolvedSteering[];
  readonly token: string;
  readonly secrets: SecretSet;
}

interface Session {
  readonly launchId: string;
  readonly paths: RunPaths;
  readonly lock: RunLock;
  readonly secrets: SecretSet;
  readonly label: string | null;
  readonly mode: Mode;
  readonly acpLog: AcpLog;
  readonly stderrLog: StderrLog;
  /** Aborts a start that is still running. */
  readonly startAbort: AbortController;
  meta: RunMeta;
  metaChain: Promise<void>;
  state: RunState;
  currentTurn: number;
  sessionId: string | null;
  containerName: string | null;
  handle: ProcessHandle | undefined;
  client: KiroAcpClient | undefined;
  turn: TurnRecorder | null;
  allowed: number;
  denied: number;
  /** Permission requests decided as the plugin's own tools and not answered yet, by tool call id. */
  readonly ownToolRequests: Map<string, number>;
  /** Set once the session has failed or ended; it leaves the registry. */
  ended: boolean;
  /** Set once `acp.jsonl` is closed; later lifecycle entries are dropped. */
  acpClosed: boolean;
  /** Opens when the start has returned or failed. */
  readonly startDone: Latch;
  /** Opens when the session has left the registry. */
  readonly gone: Latch;
  /** Settles when the running turn has ended and the session state follows it. */
  turnDone: Promise<void> | null;
  /** Set by `stop`: the session ends `stopped` instead of `exited`. */
  stopping: boolean;
  /** Kiro offers `session/close`. */
  canClose: boolean;
}

/** A start step that failed in a way of its own (deadline, abort). */
class StepFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepFailure';
  }
}

/** Keeps the awaited operations of one start within its deadline and its abort. */
interface StartGuard {
  /** Aborted by the client, by `stop` and by shutdown. */
  readonly signal: AbortSignal;
  /** Settles with `operation`, or fails the step once the deadline passes or the start is aborted. */
  guard<T>(operation: Promise<T>): Promise<T>;
}

/** A `calls/` record this process wrote: a failure rewrites it with the same fields. */
interface RecordedCall {
  readonly toolUseId: string;
  readonly record: CallRecord;
}

/** What one start has set in motion, for the cleanup when it fails. */
interface StartWork {
  /** The `calls/` record of the start, once written. */
  recordedCall: RecordedCall | undefined;
  /** Every guarded operation, settled or not: the cleanup waits for them. */
  readonly pending: Promise<void>[];
  /** How many guarded operations have not settled yet. */
  unsettled: number;
}

export class SessionManager implements LiveRegistry {
  readonly #settings: Settings;
  readonly #stateDir: string;
  readonly #env: Environment;
  readonly #projectDir: string | null;
  readonly #deps: ManagerDeps;
  readonly #startLimits: StartLimits;
  readonly #shutdownLimits: ShutdownLimits;
  readonly #controlLimits: ControlLimits;
  readonly #toolServerFile: string;
  readonly #onError: (error: unknown, where: string) => void;
  readonly #ownerOption: ProcessIdentity | undefined;
  readonly #driverOption: ProcessIdentity | undefined;
  readonly #sessions = new Map<string, Session>();
  readonly #reservedLabels = new Set<string>();
  readonly #mutex = new SessionMutex();
  readonly #claims: TurnClaims;
  readonly #background = new Set<Promise<void>>();
  #identity: Promise<{ owner: string; driver: ProcessIdentity; home: string }> | undefined;
  #closing: Promise<void> | undefined;
  /** Turns that were running when the shutdown killed their process. */
  readonly #shutDownTurns = new WeakSet<TurnRecorder>();
  #sweep: Promise<SweepReport> | undefined;

  constructor(options: SessionManagerOptions) {
    this.#settings = options.settings;
    this.#stateDir = options.stateDir;
    this.#env = options.env ?? process.env;
    this.#projectDir = options.projectDir ?? null;
    this.#deps = { ...DEFAULT_DEPS, ...options.deps };
    this.#startLimits = { ...DEFAULT_START_LIMITS, ...options.startLimits };
    this.#shutdownLimits = { ...DEFAULT_SHUTDOWN_LIMITS, ...options.shutdownLimits };
    this.#controlLimits = { ...DEFAULT_CONTROL_LIMITS, ...options.controlLimits };
    this.#toolServerFile = options.toolServerFile ?? bundledToolServerFile();
    this.#onError =
      options.onError ??
      ((error, where) => {
        process.stderr.write(`kiro-sidecar: ${where}: ${describeError(error)}\n`);
      });
    this.#ownerOption = options.owner;
    this.#driverOption = options.driver;
    this.#claims = new TurnClaims(options.stateDir);
  }

  // --- live registry ----------------------------------------------------------

  get(launchId: string): LiveSession | undefined {
    const session = this.#sessions.get(launchId);
    return session === undefined ? undefined : snapshot(session);
  }

  list(): readonly LiveSession[] {
    return [...this.#sessions.values()].map(snapshot);
  }

  // --- delivery markers -------------------------------------------------------

  /** Claims turn n for a blocked call; see `TurnClaims.claim`. */
  claim(launchId: string, turn: number): Promise<ReleaseClaim> {
    return this.#claims.claim(launchId, turn);
  }

  /** Writes `turns/<n>.returned` before a reply carrying that result is sent. */
  markReturned(launchId: string, turn: number): Promise<void> {
    return this.#claims.markReturned(launchId, turn);
  }

  /** The result of turn n of a driven session, once it ends; undefined if it is not running. */
  turnEnded(launchId: string, turn: number): Promise<TurnResult> | undefined {
    const running = this.#sessions.get(launchId)?.turn;
    return running !== null && running !== undefined && running.turn === turn ? running.ended : undefined;
  }

  /** Resolves when the background work started so far (turn ends, exits) is done. */
  async settled(): Promise<void> {
    while (this.#background.size > 0) {
      await Promise.allSettled([...this.#background]);
    }
  }

  // --- startup sweep ------------------------------------------------------------

  /**
   * Settles the runs of dead servers on this host (see `sweep.ts`), once:
   * a later call gets the first call's report. Each run is swept under its
   * session mutex, so a `send`, `cancel` or `stop` of a run being swept
   * answers `E_BUSY`. The sweep stops between runs once the manager shuts
   * down, and `settled` waits for it.
   */
  sweep(): Promise<SweepReport> {
    if (this.#sweep === undefined) {
      const work = this.#runSweep();
      this.#sweep = work;
      this.#track(
        work.then(
          () => undefined,
          () => undefined,
        ),
        'startup sweep',
      );
    }
    return this.#sweep;
  }

  async #runSweep(): Promise<SweepReport> {
    const { owner, driver } = await this.#identities();
    return sweepRuns({
      stateDir: this.#stateDir,
      owner,
      driver,
      exclusive: async (launchId, body) => {
        const holder = this.#mutex.holder(launchId);
        if (holder !== undefined) {
          return { ran: false, holder };
        }
        return { ran: true, value: await this.#mutex.run(launchId, 'sweep', body) };
      },
      removeContainers: (launchId) => this.#deps.removeContainersByLabel(launchId, this.#env),
      // The host id this server writes into the labels of its containers.
      listHostContainers: () => this.#deps.listHostContainers(driver.hostId, this.#env),
      removeContainersById: (ids) => this.#deps.removeContainersById(ids, this.#env),
      killChild: (child, report) => this.#killLeftoverChild(child, report),
      claimHeld: (launchId, turn) => this.#claims.holders(launchId, turn) > 0,
      stopped: () => this.#closing !== undefined,
      retentionDays: this.#settings.retention_days,
    });
  }

  // --- start ------------------------------------------------------------------

  async start(params: StartParams, call: CallContext = {}): Promise<StartResult> {
    const deadline = performance.now() + this.#startLimits.deadlineMs;
    this.#assertOpen();
    const giveUp = startGiveUp(this.#startLimits.deadlineMs, call.signal);
    const plan = await beforeSteps('validate', this.#validateStart(params), giveUp);
    if (plan.label !== null) {
      if (this.#labelTaken(plan.label)) {
        throw new InvalidInputError('label', `${JSON.stringify(plan.label)} is already used by a live session`);
      }
      this.#reservedLabels.add(plan.label);
    }
    try {
      return await this.#runStart(plan, call, deadline, giveUp);
    } finally {
      if (plan.label !== null) {
        this.#reservedLabels.delete(plan.label);
      }
    }
  }

  async #validateStart(params: StartParams): Promise<StartPlan> {
    for (const field of UNAVAILABLE_START_PARAMS) {
      const value = params[field];
      if (value !== undefined) {
        throw new InvalidInputError(field, 'is not available in this version');
      }
    }
    const mode = params.mode ?? this.#settings.default_mode;
    if (mode !== 'local' && mode !== 'docker') {
      throw new InvalidInputError('mode', `must be "local" or "docker", got ${JSON.stringify(mode)}`);
    }
    if (typeof params.dir !== 'string' || params.dir === '') {
      throw new InvalidInputError('dir', 'is required');
    }
    // An empty list is the same as none.
    const skillNames = stringList(params.skills, 'skills');
    const steeringPaths = stringList(params.steering, 'steering');
    let dir: string;
    let dirReadOnly = false;
    let mounts: readonly MountSpec[] = [];
    let mountSet: MountSet | null = null;
    let mountRequest: MountRequest | null = null;
    if (mode === 'local') {
      if (params.dir.endsWith(READ_ONLY_SUFFIX)) {
        throw new InvalidInputError('dir', `with "${READ_ONLY_SUFFIX}" is available in docker mode only`);
      }
      if (params.mounts !== undefined) {
        throw new InvalidInputError('mounts', 'is available in docker mode only');
      }
      // Local runs of one home share its `skills/` and `steering/` until each run gets its own view (spec 2.1 P4-6).
      for (const [field, list] of [
        ['skills', skillNames],
        ['steering', steeringPaths],
      ] as const) {
        if (list.length > 0) {
          throw new InvalidInputError(field, 'is available in docker mode only in this version');
        }
      }
      dir = await resolveWorkDir(params.dir);
    } else {
      // Inside the container a loopback address is the container itself; the value may hold credentials.
      if (isLoopbackProxy(this.#settings.proxy)) {
        throw new InvalidInputError(
          'proxy',
          'names a loopback host, which inside the container is the container itself: ' +
            'set the proxy setting to an address the container reaches (host.docker.internal on Docker Desktop) ' +
            'or start in local mode',
        );
      }
      const given = parseMountSpec(params.dir);
      // The state directory must exist to be resolved; a first start may come before anything else made it.
      await ensureDir(this.#stateDir);
      mountRequest = {
        dir: given.path,
        dirReadOnly: given.readOnly,
        mounts: mountSpecs(params.mounts),
        stateDir: this.#stateDir,
      };
      mountSet = await resolveMountSet(mountRequest);
      ({ dir, dirReadOnly, mounts } = mountSet);
    }
    const given = optionalText(params.prompt, 'prompt');
    if (given !== null && params.prompt_file !== undefined) {
      throw new InvalidInputError('prompt_file', 'cannot be given together with prompt');
    }
    const task = params.prompt_file === undefined ? null : await readPromptFile(params.prompt_file);
    // Docker: Kiro reads the task from the mounted copy. Local: the file's content is the prompt.
    const prompt = task === null ? given : mode === 'docker' ? TASK_FILE_PROMPT : task.text;
    let label: string | null = null;
    if (params.label !== undefined) {
      assertLabel(params.label);
      label = params.label;
    }
    if (params.home !== undefined && !isValidHomeName(params.home)) {
      throw new InvalidInputError('home', `must be ${HOME_NAME_RULE}`);
    }
    const home = await this.#homeFor(params.home);
    const model = optionalText(params.model, 'model');
    const effort = optionalText(params.effort, 'effort');
    if (effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
      throw new InvalidInputError('effort', `must be one of ${EFFORT_LEVELS.join(', ')}, got ${JSON.stringify(effort)}`);
    }
    const permissions = params.permissions ?? 'allow';
    if (permissions !== 'allow' && permissions !== 'deny') {
      throw new InvalidInputError('permissions', `must be "allow" or "deny", got ${JSON.stringify(permissions)}`);
    }
    const kiroMode = optionalText(params.kiro_mode, 'kiro_mode');
    let image: string | null = null;
    if (mode === 'local') {
      if (params.image !== undefined) {
        throw new InvalidInputError('image', 'is available in docker mode only');
      }
    } else {
      image = params.image ?? this.#settings.docker_image;
      assertDockerImage(image);
    }
    // Both lists are empty in local mode, refused above otherwise; an empty list reads no file.
    const skills = await resolveSkills(skillNames, skillSourcesFromEnv(this.#env));
    const steering = await resolveSteering(steeringPaths);
    // The token is api_key in every mode; the settings refuse an empty one before a manager exists.
    const token = this.#settings.api_key;
    if (token === '') {
      throw new InvalidInputError('api_key', 'is not set: Kiro needs a token');
    }
    const secrets = runSecrets(token, this.#env);
    return {
      mode,
      dir,
      dirReadOnly,
      mounts,
      mountSet,
      mountRequest,
      prompt,
      task,
      label,
      home,
      model,
      effort,
      kiroMode,
      permissions,
      image,
      skills,
      steering,
      token,
      secrets,
    };
  }

  async #runStart(plan: StartPlan, call: CallContext, deadline: number, giveUp: AbortSignal): Promise<StartResult> {
    const { owner, driver, launchId, paths, lock } = await beforeSteps('create_run', this.#newRun(giveUp), giveUp);
    const now = isoSeconds();
    const meta: RunMeta = {
      launchId,
      kiroSessionId: null,
      ownerKey: owner,
      driver,
      home: plan.home,
      projectDir: this.#projectDir,
      label: plan.label,
      mode: plan.mode,
      dir: plan.dir,
      dirReadOnly: plan.dirReadOnly,
      mounts: plan.mounts.map(formatMountSpec),
      // As given, so that they can be resolved again from their sources.
      skills: plan.skills.map((skill) => skill.requested),
      steering: plan.steering.map((file) => file.requested),
      model: plan.model,
      effort: plan.effort,
      kiroMode: plan.kiroMode,
      permissions: plan.permissions,
      preset: null,
      tokenSource: 'api_key',
      image: plan.image,
      dockerUser: null,
      containerName: null,
      child: null,
      state: 'starting',
      currentTurn: 0,
      firstPromptPreview: null,
      createdAt: now,
      updatedAt: now,
    };
    const session: Session = {
      launchId,
      paths,
      lock,
      secrets: plan.secrets,
      label: plan.label,
      mode: plan.mode,
      acpLog: AcpLog.open(paths.acpLog, { secrets: plan.secrets }),
      stderrLog: StderrLog.open(paths.stderrLog, { secrets: plan.secrets }),
      startAbort: new AbortController(),
      meta,
      metaChain: Promise.resolve(),
      state: 'starting',
      currentTurn: 0,
      sessionId: null,
      containerName: null,
      handle: undefined,
      client: undefined,
      turn: null,
      allowed: 0,
      denied: 0,
      ownToolRequests: new Map(),
      ended: false,
      acpClosed: false,
      startDone: latch(),
      gone: latch(),
      turnDone: null,
      stopping: false,
      canClose: false,
    };
    this.#sessions.set(launchId, session);
    const abort = session.startAbort;
    const onCallAbort = () => abort.abort(call.signal?.reason);
    call.signal?.addEventListener('abort', onCallAbort, { once: true });
    if (call.signal?.aborted === true) {
      abort.abort(call.signal.reason);
    }
    let step = 'meta';
    const work: StartWork = { recordedCall: undefined, pending: [], unsettled: 0 };
    const start: StartGuard = {
      signal: abort.signal,
      guard: (operation) => {
        work.unsettled += 1;
        const counted = () => {
          work.unsettled -= 1;
        };
        // Attached before the race, so the count is current when a give-up is handled.
        work.pending.push(operation.then(counted, counted));
        return withinStart(operation, deadline, abort.signal);
      },
    };
    const { guard } = start;
    let failed = false;
    try {
      await guard(this.#persist(session, {}));
      step = 'call_record';
      const toolUseId = call.toolUseId;
      if (toolUseId !== undefined && isValidToolUseId(toolUseId)) {
        const record: CallRecord = { launchId, turn: plan.prompt === null ? null : 1, driver };
        const recording = recordCall(this.#stateDir, toolUseId, record);
        // Set even when the record lands after the start was given up, so the cleanup marks it failed.
        recording.then(
          (created) => {
            if (created) {
              work.recordedCall = { toolUseId, record };
            }
          },
          () => {},
        );
        await guard(recording);
      }
      const options = (cap: number): StepOptions => stepOptions(step, cap, deadline, abort.signal);

      let spec: ProcessSpec;
      // Checked after the host checks and before anything is written or spawned (4.11).
      let toolServerFile: string;
      if (plan.mode === 'docker') {
        step = 'docker_user';
        const user = await bounded(
          this.#deps.resolveDockerUser(this.#settings.docker_user, this.#env),
          options(this.#startLimits.deadlineMs),
        );
        session.meta = { ...session.meta, dockerUser: user };
        step = 'docker_image';
        const image = plan.image as string;
        await bounded(this.#deps.checkImage(image, this.#env), options(this.#startLimits.deadlineMs));
        step = 'tool_server';
        toolServerFile = await guard(checkToolServerFile(this.#toolServerFile));
        step = 'spawn';
        const taskFile = plan.task === null ? null : await guard(writeTaskCopy(this.#stateDir, launchId, plan.task.content));
        // Every mount source and target exists before `docker run`, so the daemon creates none of them.
        const home = await guard(ensureHome(this.#stateDir, plan.home));
        const copies = await guard(ensureRunCopyDirs(this.#stateDir, launchId));
        // The run's own skills and steering files, which Kiro sees through the read-only mounts of the copy dirs.
        // The copy itself stops at the start deadline or abort, not only the wait for it.
        const copyStop = AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(0, Math.ceil(deadline - performance.now())))]);
        await guard(copySkills(plan.skills, copies.skills, { signal: copyStop }));
        await guard(copySteering(plan.steering, copies.steering));
        // Into the run's steering copies, which are mounted over the home's `steering/`.
        await guard(writeProtocolSteering(copies.steering));
        const mountSet = plan.mountSet as MountSet;
        await guard(assertMountsUnchanged(plan.mountRequest as MountRequest, mountSet));
        const launch = await guard(
          buildDockerLaunch({
            launchId,
            mountSet,
            user,
            image,
            token: plan.token,
            env: this.#env,
            proxy: proxySettingsEnvironment(this.#settings),
            kiroHome: { home: home.dir, skills: copies.skills, steering: copies.steering },
            ...(taskFile === null ? {} : { taskFile }),
            toolServerFile,
            owner: { ownerKey: owner, driver },
            secrets: plan.secrets,
          }),
        );
        spec = { argv: [launch.command, ...launch.args], env: launch.env, cwd: launch.dir };
        session.containerName = launch.containerName;
      } else {
        step = 'tool_server';
        toolServerFile = await guard(checkToolServerFile(this.#toolServerFile));
        step = 'spawn';
        if (plan.task !== null) {
          await guard(writeTaskCopy(this.#stateDir, launchId, plan.task.content));
        }
        const home = await guard(ensureHome(this.#stateDir, plan.home));
        // Kiro reads the home's own `steering/`, shared by every local run of the home.
        await guard(writeProtocolSteering(home.steering));
        const overrides: LocalEnvironmentOverrides = {
          KIRO_API_KEY: plan.token,
          KIRO_HOME: home.dir,
          proxy: proxySettingsEnvironment(this.#settings),
        };
        spec = localKiroSpec({
          kiroCommand: this.#settings.kiro_command,
          dir: plan.dir,
          serverEnv: this.#env,
          overrides,
        });
      }
      if (abort.signal.aborted) {
        throw new StepFailure('the start was aborted');
      }

      step = 'initialize';
      const initializeOptions = options(this.#startLimits.initializeMs);
      const client = this.#spawn(session, spec, plan.permissions);
      const initialized = await client.initialize(initializeOptions);
      const close = initialized.agentCapabilities?.sessionCapabilities?.close;
      session.canClose = close !== undefined && close !== null;

      step = 'session_new';
      const { sessionId } = await client.newSession(
        { cwd: plan.dir, mcpServers: toolServerConfig(plan.mode, toolServerFile) },
        options(this.#startLimits.sessionNewMs),
      );
      assertNoSecret(session.secrets, step, 'session id', sessionId);
      session.sessionId = sessionId;
      const child =
        plan.mode === 'local' && session.handle?.pid !== undefined
          ? await guard(processIdentity(session.handle.pid))
          : null;
      await guard(
        this.#persist(session, {
          kiroSessionId: sessionId,
          containerName: session.containerName,
          child: child === null ? null : { pid: child.pid, startTime: child.startTime },
        }),
      );

      const settings: Array<[string, string, string | null]> = [
        ['model', MODEL_OPTION, plan.model],
        ['effort', EFFORT_OPTION, plan.effort],
        ['kiro_mode', KIRO_MODE_OPTION, plan.kiroMode],
      ];
      for (const [field, configId, value] of settings) {
        if (value === null) {
          continue;
        }
        step = field;
        await setOfferedOption(
          client,
          sessionId,
          field,
          configId,
          value,
          options(this.#startLimits.configMs),
          session.secrets,
          configId === EFFORT_OPTION ? effortNeverOffered : undefined,
        );
      }

      step = 'tools';
      await waitForToolServer(client, sessionId, options(this.#startLimits.toolsMs));

      // Read back last, so an option Kiro offered late is in the reply.
      const offered = client.configOptions(sessionId);
      const readBack = {
        model: currentValue(offered, MODEL_OPTION),
        effort: currentValue(offered, EFFORT_OPTION),
        kiroMode: currentValue(offered, KIRO_MODE_OPTION),
      };
      for (const [field, value] of [
        ['model', readBack.model],
        ['effort', readBack.effort],
        ['kiro_mode', readBack.kiroMode],
      ] as const) {
        step = field;
        assertNoSecret(session.secrets, step, `${field} value`, value);
      }

      step = 'prompt';
      if (abort.signal.aborted) {
        throw new StepFailure('the start was aborted');
      }
      let turn: number | null = null;
      if (plan.prompt === null) {
        session.state = 'idle';
        await guard(this.#persist(session, { ...readBack, state: 'idle' }));
      } else {
        turn = await this.#openTurn(session, plan.prompt, readBack, start, plan.task?.text);
      }
      return {
        launchId,
        sessionId,
        label: plan.label,
        mode: plan.mode,
        dir: plan.dir,
        home: plan.home,
        model: readBack.model,
        effort: readBack.effort,
        kiroMode: readBack.kiroMode,
        // The names Kiro sees in its `skills/` and `steering/`; the protocol steering is not listed.
        skills: plan.skills.map((skill) => skill.name),
        steering: plan.steering.map((file) => file.name),
        permissions: plan.permissions,
        turn,
        trailer: turn === null ? null : formatTurnTrailer(launchId, turn),
      };
    } catch (error) {
      failed = true;
      throw await this.#failStart(session, step, error, work);
    } finally {
      call.signal?.removeEventListener('abort', onCallAbort);
      // A failed start opens it once its cleanup is done (`#finishFailedStart`).
      if (!failed) {
        session.startDone.open();
      }
    }
  }

  /** Spawns Kiro and wires the client to the session's sinks. */
  #spawn(session: Session, spec: ProcessSpec, permissions: Permissions): KiroAcpClient {
    const handle = this.#deps.spawn(spec, {
      // Raw bytes: stderr.log decodes, redacts and caps them as one stream.
      onStderr: (chunk) => session.stderrLog.write(chunk),
      killGraceMs: CLEANUP_KILL_GRACE_MS,
    });
    session.handle = handle;
    const client = new KiroAcpClient(handle, {
      // The plugin's own tools are allowed whatever the policy (4.5).
      decidePermission: (request) => {
        if (!isOwnToolRequest(request)) {
          return permissions;
        }
        // Noted so that its answer is not counted (`#onEvent`).
        const id = request.toolCall.toolCallId;
        session.ownToolRequests.set(id, (session.ownToolRequests.get(id) ?? 0) + 1);
        return 'allow';
      },
      events: (event) => this.#onEvent(session, event),
      lifecycle: (entry) => this.#onLifecycle(session, entry),
      debugFrames: this.#settings.debug_acp,
    });
    session.client = client;
    // Tracked only once the process has exited, so `settled` does not wait for live processes.
    void handle.exited.then(() => this.#track(this.#onExit(session), 'process exit'));
    return client;
  }

  /**
   * Cleans up a start that failed: the process is killed, the state set to
   * `failed`, the call record rewritten as failed, the lock released. Returns
   * the error to answer with; while an operation the start gave up on is
   * still running, that recording finishes in the background.
   */
  async #failStart(session: Session, step: string, error: unknown, work: StartWork): Promise<Error> {
    session.state = 'failed';
    session.ended = true;
    if (session.client !== undefined) {
      await session.client.terminate(CLEANUP_KILL_GRACE_MS).catch(() => undefined);
    } else if (session.handle !== undefined) {
      await session.handle.kill(CLEANUP_KILL_GRACE_MS).catch(() => undefined);
    }
    if (session.mode === 'docker' && session.containerName !== null && session.handle !== undefined) {
      this.#removeContainers([session.containerName]);
    }
    session.stderrLog.close();
    let answer: Error;
    if (error instanceof SidecarError) {
      const message = session.secrets.redact(error.message);
      answer = message === error.message ? error : new SidecarError(error.code, message);
    } else {
      const tail = stderrTail(session.paths.stderrLog);
      const reason = error instanceof AcpClientError && error.code === 'aborted' ? 'the start was aborted' : describeError(error);
      const text = `start step ${step} failed: ${reason}${tail === null ? '' : `\nKiro stderr (last lines):\n${tail}`}`;
      answer = new SidecarError(`E_STEP_${step.toUpperCase()}`, session.secrets.redact(text));
    }
    const code = (answer as { code?: string }).code ?? 'E_INTERNAL';
    this.#logLine(session, { event: 'start_failed', step, code }, true);
    const cleanup = this.#finishFailedStart(session, work, `${code} ${answer.message}`);
    if (work.unsettled === 0) {
      await cleanup;
    } else {
      // The call answers now; the run is recorded failed once what it gave up on has settled.
      this.#track(cleanup, `failed start of ${session.launchId}`);
    }
    return answer;
  }

  /**
   * Records a failed start and lets its run go: the state `failed`, the call
   * record rewritten as failed, the lock released. Waits first for every
   * operation the start gave up on, so none of them lands after the cleanup.
   */
  async #finishFailedStart(session: Session, work: StartWork, failure: string): Promise<void> {
    try {
      await Promise.all(work.pending);
      try {
        // A turn that was never opened is not left as the current turn.
        await this.#persist(session, { state: 'failed', currentTurn: session.currentTurn });
      } catch (persistError) {
        this.#onError(persistError, `failed start of ${session.launchId}: meta`);
      }
      if (work.recordedCall !== undefined) {
        try {
          const { toolUseId, record } = work.recordedCall;
          await recordCallFailure(this.#stateDir, toolUseId, session.secrets.redact(failure), record);
        } catch (recordError) {
          this.#onError(recordError, `failed start of ${session.launchId}: call record`);
        }
      }
      closeAcpLog(session);
      await session.lock.release().catch((releaseError: unknown) => this.#onError(releaseError, 'lock release'));
    } finally {
      this.#sessions.delete(session.launchId);
      session.gone.open();
      session.startDone.open();
    }
  }

  // --- send -------------------------------------------------------------------

  async send(params: SendParams, call: CallContext = {}): Promise<SendResult> {
    if (typeof params.text !== 'string' || params.text === '') {
      throw new InvalidInputError('text', 'must not be empty');
    }
    if (params.interrupt !== undefined && typeof params.interrupt !== 'boolean') {
      throw new InvalidInputError('interrupt', 'must be true or false');
    }
    this.#assertOpen();
    const { launchId } = params;
    return this.#mutex.run(launchId, 'send', async () => {
      const { driver } = await this.#identities();
      const session = this.#sessions.get(launchId);
      if (session === undefined) {
        throw await this.#notDriven(launchId);
      }
      if (session.state === 'completed') {
        throw completedError(launchId);
      }
      if (session.state === 'starting') {
        throw new SidecarError('E_BUSY', `Session ${launchId} is still starting`);
      }
      const interrupting = session.state === 'running' && params.interrupt === true;
      if (session.state === 'running' && !interrupting) {
        throw new SidecarError('E_BUSY', `Session ${launchId} is running turn ${session.currentTurn}; wait for it to end`);
      }
      const sessionId = session.sessionId;
      if (sessionId === null || (!interrupting && session.state !== 'idle')) {
        throw new InvalidInputError('session', `${launchId} is ${session.state}`);
      }
      const turn = session.currentTurn + 1;
      let before: RunMeta | null = null;
      if (!interrupting) {
        before = session.meta;
        session.state = 'running';
      }
      let recordedCall: RecordedCall | undefined;
      let held: HeldTurn | null = null;
      try {
        try {
          const toolUseId = call.toolUseId;
          if (toolUseId !== undefined && isValidToolUseId(toolUseId)) {
            const record: CallRecord = { launchId, turn, driver };
            if (await recordCall(this.#stateDir, toolUseId, record)) {
              recordedCall = { toolUseId, record };
            }
          }
          if (interrupting) {
            held = await this.#cancelRunningTurn(session, 'interrupt', call.signal);
            if (held === null) {
              throw new SidecarError(
                'E_CANCEL_TIMEOUT',
                `Turn ${session.currentTurn} of ${launchId} did not end within ${this.#controlLimits.cancelWaitMs} ms of session/cancel; the session is still running`,
              );
            }
            // The interrupted turn holds a completion: it is delivered by its own push.
            if (held.result.completion !== null) {
              throw completedError(launchId);
            }
            if (session.ended || session.state !== 'idle') {
              throw new InvalidInputError(
                'session',
                `${launchId} is ${session.state} after turn ${held.turn} ended; read that turn with wait`,
              );
            }
            // A call the client cancelled opens no next turn; the interrupted one stays undelivered.
            call.signal?.throwIfAborted();
            before = session.meta;
            session.state = 'running';
          }
          await this.#openTurn(session, params.text, {});
        } catch (error) {
          if (before !== null && session.turn === null && !session.ended) {
            session.state = 'idle';
            session.meta = before;
          }
          if (recordedCall !== undefined) {
            const failure = session.secrets.redact(describeError(error));
            await recordCallFailure(this.#stateDir, recordedCall.toolUseId, failure, recordedCall.record).catch(
              (recordError: unknown) => this.#onError(recordError, 'call record'),
            );
          }
          throw error;
        }
        let interrupted: ReturnedTurn | null = null;
        if (held !== null) {
          call.signal?.throwIfAborted();
          interrupted = await this.#returnTurn(launchId, held);
        }
        return { launchId, sessionId, turn, trailer: formatTurnTrailer(launchId, turn), interrupted };
      } finally {
        await held?.release();
      }
    });
  }

  /** The answer for a launch id this manager does not drive. */
  async #notDriven(launchId: string): Promise<Error> {
    let meta: RunMeta;
    try {
      meta = await this.#ownRun(launchId);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    const state = await observedState(meta);
    const ended = new InvalidInputError('session', `${launchId} is ${state}; the session has ended, start a new session`);
    switch (state) {
      case 'exited':
      case 'stopped':
      case 'lost':
        return ended;
      case 'completed':
        return completedError(launchId);
      case 'failed':
        return meta.kiroSessionId === null
          ? new InvalidInputError('session', `${launchId} failed to start; start a new session`)
          : ended;
      default: {
        if ((await liveness(meta.driver)) === 'dead') {
          return meta.kiroSessionId === null
            ? new InvalidInputError('session', `${launchId} did not finish starting; start a new session`)
            : new InvalidInputError('session', `${launchId} is no longer driven; the session has ended, start a new session`);
        }
        return new SidecarError('E_OWNED', `Session ${launchId} is driven by another server process`);
      }
    }
  }

  /**
   * The meta of an own run: `send`, `cancel` and `stop` act on own runs only.
   * No run, or a run of another home: `E_NOT_FOUND`; a run of another owner
   * of this home, whether that owner is alive or dead: `E_OWNED`.
   */
  async #ownRun(launchId: string): Promise<RunMeta> {
    const meta = await readMeta(this.#stateDir, launchId);
    const notFound = new SidecarError('E_NOT_FOUND', `No session ${launchId}`);
    if (meta === undefined) {
      throw notFound;
    }
    const { owner, home } = await this.#identities();
    if (meta.ownerKey !== owner) {
      if (meta.home !== home) {
        throw notFound;
      }
      throw new SidecarError('E_OWNED', `Session ${launchId} belongs to another Claude session`);
    }
    return meta;
  }

  /**
   * A run this manager does not drive, for `cancel` and `stop`: its meta and
   * observed state. A run another live server drives is `E_OWNED`; a start
   * whose driver is gone is `lost`.
   */
  async #foreignRun(launchId: string): Promise<{ meta: RunMeta; state: RunState }> {
    const meta = await this.#ownRun(launchId);
    const state = await observedState(meta);
    if (state === 'starting' && (await liveness(meta.driver)) === 'dead') {
      return { meta, state: 'lost' };
    }
    if (state === 'starting' || state === 'idle' || state === 'running') {
      throw new SidecarError('E_OWNED', `Session ${launchId} is driven by another server process`);
    }
    return { meta, state };
  }

  // --- cancel and interrupt ---------------------------------------------------

  /**
   * `cancel {launchId}`: ends the running turn with `session/cancel`. Its
   * result is returned when it ends within the wait; otherwise the answer is
   * `cancelling` and the result, written later, carries `endedBy: cancel`.
   * A call the client cancelled releases its claim without returning the turn.
   */
  async cancel(params: CancelParams, call: CallContext = {}): Promise<CancelResult> {
    this.#assertOpen();
    const { launchId } = params;
    return this.#mutex.run(launchId, 'cancel', async () => {
      const session = this.#sessions.get(launchId);
      if (session === undefined) {
        const run = await this.#foreignRun(launchId);
        return { launchId, sessionId: run.meta.kiroSessionId, state: run.state, turn: null, ended: null };
      }
      if (session.state === 'starting') {
        throw new SidecarError('E_BUSY', `Session ${launchId} is still starting`);
      }
      if (session.state !== 'running') {
        return { launchId, sessionId: session.sessionId, state: session.state, turn: null, ended: null };
      }
      const turn = session.currentTurn;
      const held = await this.#cancelRunningTurn(session, 'cancel', call.signal);
      if (held === null) {
        return { launchId, sessionId: session.sessionId, state: 'cancelling', turn, ended: null };
      }
      try {
        call.signal?.throwIfAborted();
        const ended = await this.#returnTurn(launchId, held);
        return { launchId, sessionId: session.sessionId, state: session.state, turn, ended };
      } finally {
        await held.release();
      }
    });
  }

  /**
   * Ends the running turn with `session/cancel`. The turn is claimed BEFORE
   * the cancel is sent, so the waiter cannot push a result this call may
   * return. Returns the held claim once the turn has ended and the session
   * state follows it; null, with the claim released, when it did not end
   * within the cancel wait (the result still carries `endedBy`). A call the
   * client cancelled before the cancel is sent takes no claim and sends nothing.
   */
  async #cancelRunningTurn(
    session: Session,
    by: Extract<EndedBy, 'cancel' | 'interrupt'>,
    signal: AbortSignal | undefined,
  ): Promise<HeldTurn | null> {
    const { client, sessionId, turn: recorder, turnDone } = session;
    if (client === undefined || sessionId === null || recorder === null || turnDone === null) {
      throw new SidecarError('E_INTERNAL', `Session ${session.launchId} has no running turn`);
    }
    signal?.throwIfAborted();
    const release = await this.#claims.claim(session.launchId, recorder.turn);
    let ended = false;
    try {
      signal?.throwIfAborted();
      recorder.requested = by;
      this.#logLine(session, { event: by, turn: recorder.turn }, true);
      try {
        await client.cancel(sessionId);
      } catch (error) {
        // A closed connection ends the turn on its own.
        if (!isClosedError(error)) {
          throw error;
        }
      }
      // The result is awaited with a cap too, so the claim and the session lock are never held forever.
      ended =
        (await settlesWithin(turnDone, this.#controlLimits.cancelWaitMs)) &&
        (await settlesWithin(recorder.ended, SESSION_END_WAIT_MS));
    } finally {
      if (!ended) {
        await release();
      }
    }
    if (!ended) {
      return null;
    }
    return { turn: recorder.turn, result: await recorder.ended, release };
  }

  /** Writes `turns/<n>.returned` for a held turn and builds its part of the reply. */
  async #returnTurn(launchId: string, held: HeldTurn): Promise<ReturnedTurn> {
    await this.#claims.markReturned(launchId, held.turn);
    return { turn: held.turn, result: held.result, resultLine: formatResultLine(launchId, held.turn) };
  }

  // --- stop -------------------------------------------------------------------

  /**
   * `stop {launchId, purge?}`, idempotent. A running start is aborted (the run
   * keeps `failed`); a driven session is closed, its process ended and its
   * container removed, and it becomes `stopped` with the running turn's
   * result in the reply; a session that completed by itself is waited for
   * while it closes and stays `completed`; what a run this server does not
   * drive left behind is cleaned up. `purge` then deletes the run directory. A call the client
   * cancelled returns no turn and purges nothing; what it already sent to
   * Kiro still completes.
   */
  async stop(params: StopParams, call: CallContext = {}): Promise<StopResult> {
    if (params.purge !== undefined && typeof params.purge !== 'boolean') {
      throw new InvalidInputError('purge', 'must be true or false');
    }
    this.#assertOpen();
    const { launchId } = params;
    return this.#mutex.run(launchId, 'stop', async () => {
      call.signal?.throwIfAborted();
      const report: StopReport = { cleanedUp: [], failures: [] };
      let session = this.#sessions.get(launchId);
      if (session !== undefined && (session.state === 'starting' || session.state === 'failed')) {
        const aborting = session.state === 'starting';
        if (aborting) {
          session.startAbort.abort(new Error('the session was stopped'));
        }
        // A failed start finishes recording its run before the stop looks at it.
        await session.startDone.promise;
        session = this.#sessions.get(launchId);
        if (aborting && session === undefined) {
          report.cleanedUp.push('start aborted');
        }
      }
      let ended: ReturnedTurn | null = null;
      let meta: RunMeta;
      let state: RunState;
      if (session !== undefined) {
        ended = await this.#stopDriven(session, report, call.signal);
        meta = session.meta;
        state = meta.state;
      } else {
        ({ meta, state } = await this.#stopLeftover(launchId, report));
      }
      if (params.purge === true) {
        // The run stays readable until a stop whose reply can arrive purges it.
        call.signal?.throwIfAborted();
      }
      const purged = params.purge === true && (await this.#purge(launchId, report));
      return {
        launchId,
        sessionId: meta.kiroSessionId,
        state,
        ended,
        cleanedUp: report.cleanedUp,
        failures: report.failures,
        purged,
      };
    });
  }

  /** Stops a session this manager drives; returns the running turn's result. */
  async #stopDriven(session: Session, report: StopReport, signal: AbortSignal | undefined): Promise<ReturnedTurn | null> {
    const { launchId } = session;
    const recorder = session.state === 'running' ? session.turn : null;
    signal?.throwIfAborted();
    const release = recorder === null ? null : await this.#claims.claim(launchId, recorder.turn);
    try {
      signal?.throwIfAborted();
      // A session that completed by itself closes on its own (4.11): the stop waits for the close.
      const closing = session.state === 'completed';
      if (!closing) {
        if (recorder !== null) {
          recorder.requested = 'stop';
        }
        session.stopping = true;
        this.#logLine(session, { event: 'stop', turn: recorder?.turn ?? null }, true);
        await this.#endProcess(session, report);
      }
      if (!(await settlesWithin(session.gone.promise, SESSION_END_WAIT_MS))) {
        report.failures.push(`the session did not finish ending within ${SESSION_END_WAIT_MS} ms`);
      }
      if (!closing && session.mode === 'docker' && session.containerName !== null) {
        await this.#removeContainer(session.containerName, report);
      }
      if (recorder === null) {
        return null;
      }
      if (!(await settlesWithin(recorder.ended, SESSION_END_WAIT_MS))) {
        report.failures.push(`turn ${recorder.turn} has no result yet`);
        return null;
      }
      signal?.throwIfAborted();
      return await this.#returnTurn(launchId, { turn: recorder.turn, result: await recorder.ended, release: async () => {} });
    } finally {
      await release?.();
    }
  }

  /**
   * Sends `session/close` when Kiro offers it, closes stdin, and kills the
   * process when it has not exited when the stop grace is over.
   */
  async #endProcess(session: Session, report: StopReport): Promise<void> {
    const { client, handle, sessionId } = session;
    const grace = this.#controlLimits.stopGraceMs;
    const deadline = performance.now() + grace;
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    if (client !== undefined && sessionId !== null && session.canClose && client.closeError === undefined) {
      try {
        await client.closeSession(sessionId, { timeoutMs: left() });
        report.cleanedUp.push(`Kiro session ${sessionId} closed`);
      } catch (error) {
        if (!isClosedError(error)) {
          report.failures.push(session.secrets.redact(`session/close: ${describeError(error)}`));
        }
      }
    }
    if (handle === undefined || handle.exit !== undefined) {
      return;
    }
    try {
      handle.stdin.end();
    } catch {
      // The pipe is already closed; the exit wait below decides.
    }
    const name = handle.pid === undefined ? 'Kiro process' : `Kiro process ${handle.pid}`;
    if (await settlesWithin(handle.exited, left())) {
      report.cleanedUp.push(`${name} exited after stdin was closed`);
      return;
    }
    const killGrace = this.#controlLimits.killGraceMs;
    await (client === undefined ? handle.kill(killGrace) : client.terminate(killGrace)).catch(() => undefined);
    report.cleanedUp.push(`${name} killed ${grace} ms after stdin was closed`);
  }

  /**
   * Cleans up a run this manager does not drive: its container, and its
   * local child when the pid and start time still match. The run becomes
   * `stopped`; a start that never finished becomes `failed`; `failed` and
   * `completed` stay (a completed run is never rewritten to `stopped`).
   * A run whose last turn has no result yet keeps its recorded state, so the
   * turn can still be ended `lost`; the answer then carries the observed state.
   */
  async #stopLeftover(launchId: string, report: StopReport): Promise<{ meta: RunMeta; state: RunState }> {
    const { meta, state } = await this.#foreignRun(launchId);
    const { driver } = await this.#identities();
    const attempt = await acquireRunLock(this.#stateDir, launchId, driver);
    if (!attempt.acquired) {
      throw attempt.reason === 'taking-over'
        ? new SidecarError('E_BUSY', `Session ${launchId} is being taken over by another server process`)
        : new SidecarError('E_OWNED', `Session ${launchId} is held by another server process`);
    }
    const { lock } = attempt;
    try {
      if (meta.mode === 'docker') {
        await this.#removeContainer(meta.containerName ?? containerName(launchId), report);
      }
      if (meta.child !== null) {
        await this.#killLeftoverChild(meta.child, report);
      }
      let next: RunState = meta.state;
      if (meta.state === 'starting') {
        next = 'failed';
      } else if (meta.state !== 'failed' && meta.state !== 'stopped' && meta.state !== 'completed') {
        const open = meta.currentTurn > 0 && (await readTurnResult(this.#stateDir, launchId, meta.currentTurn)) === undefined;
        if (open) {
          report.failures.push(`turn ${meta.currentTurn} has no result yet; the state stays ${state}`);
        } else {
          next = 'stopped';
        }
      }
      if (next === meta.state) {
        return { meta, state };
      }
      const updated: RunMeta = { ...meta, state: next, updatedAt: isoSeconds() };
      await writeMeta(lock, updated);
      return { meta: updated, state: next };
    } finally {
      await lock.release().catch((error: unknown) => this.#onError(error, 'lock release'));
    }
  }

  /**
   * Kills a leftover local child, only while its pid still has the recorded
   * start time. A local Kiro leads its own process group (POSIX), so the
   * group gets SIGTERM and, when anything of it is left after the grace
   * period, SIGKILL. A child that leads no group is signalled alone.
   */
  async #killLeftoverChild(child: { readonly pid: number; readonly startTime: string }, report: StopReport): Promise<void> {
    const same = async () => (await processIdentity(child.pid))?.startTime === child.startTime;
    if (!(await same())) {
      return;
    }
    // A running process whose pid is also a process group id leads that group.
    let target = process.platform === 'win32' ? child.pid : -child.pid;
    try {
      try {
        process.kill(target, 'SIGTERM');
      } catch (error) {
        if (target > 0 || errorCodeOf(error) !== 'ESRCH') {
          throw error;
        }
        target = child.pid;
        process.kill(target, 'SIGTERM');
      }
    } catch (error) {
      if (errorCodeOf(error) !== 'ESRCH') {
        report.failures.push(`process ${child.pid}: ${describeError(error)}`);
      }
      return;
    }
    // The group id stays taken while any process of the group runs, so it cannot name another group then.
    const groupLeft = () => target < 0 && trySignal(target, 0);
    const deadline = performance.now() + this.#controlLimits.killGraceMs;
    while (performance.now() < deadline) {
      if (!(await same()) && !groupLeft()) {
        report.cleanedUp.push(`process ${child.pid} killed`);
        return;
      }
      await sleep(50);
    }
    if ((await same()) || groupLeft()) {
      // Ignored when everything ended between the check and the kill.
      trySignal(target, 'SIGKILL');
    }
    report.cleanedUp.push(`process ${child.pid} killed`);
  }

  /** Waits for `docker rm -f` and reports the outcome: a removal only when docker made one. */
  async #removeContainer(name: string, report: StopReport): Promise<void> {
    try {
      const removed = await this.#deps.removeContainer(name, this.#env);
      report.cleanedUp.push(removed ? `container ${name} removed` : `container ${name} was already gone`);
    } catch (error) {
      report.failures.push(`container ${name}: ${describeError(error)}`);
    }
  }

  /** Deletes the run directory of a run that is no longer driven; never the home. */
  async #purge(launchId: string, report: StopReport): Promise<boolean> {
    if (this.#sessions.has(launchId)) {
      report.failures.push('run directory kept: the session is still live');
      return false;
    }
    try {
      // Retried: a waiter's heartbeat can recreate `turns/<n>.armed` while the tree goes.
      await rm(runPaths(this.#stateDir, launchId).dir, { recursive: true, force: true, maxRetries: 3 });
      report.cleanedUp.push(`run directory of ${launchId} deleted`);
      return true;
    } catch (error) {
      report.failures.push(`run directory: ${describeError(error)}`);
      return false;
    }
  }

  // --- turns ------------------------------------------------------------------

  /**
   * Opens the next turn: writes the meta, opens the turn text, marks the
   * session `running`, and sends the prompt without awaiting it. A start
   * stays `starting` until the turn recorder is attached, so a parallel
   * `cancel`, `send` or `stop` never sees a running session without a turn.
   * The first prompt preview is taken from `previewText`, which is the prompt
   * itself unless a `prompt_file` start gives the file's content.
   */
  async #openTurn(
    session: Session,
    text: string,
    metaPatch: Partial<RunMeta>,
    start?: StartGuard,
    previewText: string = text,
  ): Promise<number> {
    const client = session.client;
    const sessionId = session.sessionId;
    if (client === undefined || sessionId === null) {
      throw new SidecarError('E_INTERNAL', `Session ${session.launchId} has no Kiro session`);
    }
    const turn = session.currentTurn + 1;
    const write = this.#persist(session, {
      ...metaPatch,
      state: 'running',
      currentTurn: turn,
      firstPromptPreview: session.meta.firstPromptPreview ?? firstPromptPreview(previewText, session.secrets),
    });
    await (start === undefined ? write : start.guard(write));
    // A start aborted while its last write ran sends no prompt: the turn is never opened.
    if (start?.signal.aborted === true) {
      throw new StepFailure('the start was aborted');
    }
    const recorder = TurnRecorder.open({
      stateDir: this.#stateDir,
      turnsDir: session.paths.turns,
      launchId: session.launchId,
      sessionId,
      label: session.label,
      turn,
      secrets: session.secrets,
    });
    session.currentTurn = turn;
    session.turn = recorder;
    session.state = 'running';
    this.#logLine(session, { event: 'turn_start', turn }, true);
    const ending: Promise<TurnEnding> = client.prompt(sessionId, text).then(
      (response) => ({ kind: 'stop', stopReason: response.stopReason }),
      (error: unknown) => ({ kind: 'failure', error }),
    );
    const done = ending.then((settled) => this.#endTurn(session, recorder, settled));
    session.turnDone = done.then(
      () => undefined,
      () => undefined,
    );
    this.#track(done, `turn ${turn} of ${session.launchId}`);
    return turn;
  }

  async #endTurn(session: Session, recorder: TurnRecorder, ending: TurnEnding): Promise<void> {
    let completed = false;
    try {
      const requested = decideOutcome(ending, recorder.requested);
      // A turn holding a completion that the cancel of `send {interrupt}` ended has no
      // `endedBy`: that call answers E_INVALID without the turn, so the push is its only
      // delivery (4.11).
      const decided =
        requested.endedBy === 'interrupt' && recorder.completion !== null ? { ...requested, endedBy: null } : requested;
      // The shutdown closed the connection: the result says so, not how the connection ended.
      const shutDown = decided.outcome === 'exited' && this.#shutDownTurns.has(recorder);
      const decision = shutDown ? { ...decided, error: SHUTDOWN_ERROR } : decided;
      if (this.#connectionDead(session) || decision.outcome === 'exited') {
        await this.#stopProcess(session);
      }
      // A completion decides the final state whatever ended the turn (4.11). Step 1:
      // the session is completed in memory before its result exists.
      completed = recorder.completion !== null;
      if (completed) {
        session.state = 'completed';
        this.#logLine(session, { event: 'completed', turn: recorder.turn }, true);
      }
      // Step 2 of a completion: the result, which holds it.
      const result = await recorder.finish(decision, session.paths.stderrLog);
      if (recorder.textError !== undefined) {
        this.#onError(recorder.textError, `turn ${recorder.turn} of ${session.launchId}: text`);
      }
      if (recorder.resultError !== undefined) {
        this.#onError(recorder.resultError, `turn ${recorder.turn} of ${session.launchId}: result`);
      }
      this.#logLine(session, { event: 'turn_end', turn: recorder.turn, outcome: result.outcome }, true);
    } finally {
      // The session leaves `running` even when the turn's files could not be written.
      if (session.turn === recorder) {
        session.turn = null;
      }
      if (completed) {
        // Step 3, then step 4 in the background: the turn has ended once its result exists.
        try {
          await this.#persist(session, { state: 'completed' });
        } finally {
          this.#track(this.#closeCompleted(session), `close of ${session.launchId}`);
        }
      } else if (this.#connectionDead(session)) {
        await this.#endSession(session);
      } else {
        session.state = 'idle';
        await this.#persist(session, { state: 'idle' });
      }
    }
  }

  #connectionDead(session: Session): boolean {
    return session.client?.closeError !== undefined || session.handle?.exit !== undefined;
  }

  /** Kills the process of a session whose stream is dead, and flushes its stderr. */
  async #stopProcess(session: Session): Promise<void> {
    if (session.client !== undefined) {
      await session.client.terminate(CLEANUP_KILL_GRACE_MS).catch(() => undefined);
    }
    session.stderrLog.close();
  }

  /** The process exited: an idle session becomes `exited`; a running turn ends on its own. */
  async #onExit(session: Session): Promise<void> {
    if (session.ended || session.state !== 'idle') {
      return;
    }
    await this.#stopProcess(session);
    await this.#endSession(session);
  }

  /**
   * Step 4 of a completion (4.11): closes the session as `stop` does (process
   * ended, container removed, lock released); the state stays `completed`. A
   * stop that raced the completion, or the shutdown, ends the process and
   * removes the container itself; the close then waits for the process.
   */
  async #closeCompleted(session: Session): Promise<void> {
    const report: StopReport = { cleanedUp: [], failures: [] };
    try {
      if (session.stopping || this.#closing !== undefined) {
        const exited = session.handle?.exited;
        if (exited !== undefined && !(await settlesWithin(exited, SESSION_END_WAIT_MS))) {
          report.failures.push(`the Kiro process did not end within ${SESSION_END_WAIT_MS} ms`);
        }
      } else {
        await this.#endProcess(session, report);
        if (session.mode === 'docker' && session.containerName !== null) {
          await this.#removeContainer(session.containerName, report);
        }
      }
      await this.#stopProcess(session);
    } finally {
      await this.#endSession(session);
    }
    for (const failure of report.failures) {
      this.#onError(new Error(failure), `close of ${session.launchId}`);
    }
  }

  /**
   * The session's process is gone: `exited` (`stopped` after a stop; a
   * completed session stays `completed`), lock released, out of the registry.
   */
  async #endSession(session: Session): Promise<void> {
    if (session.ended) {
      return;
    }
    const state: RunState = session.state === 'completed' ? 'completed' : session.stopping ? 'stopped' : 'exited';
    session.state = state;
    try {
      await this.#persist(session, { state });
    } finally {
      session.ended = true;
      session.stderrLog.close();
      closeAcpLog(session);
      this.#sessions.delete(session.launchId);
      try {
        await session.lock.release();
      } finally {
        session.gone.open();
      }
    }
  }

  // --- events -----------------------------------------------------------------

  #onEvent(session: Session, event: TurnEvent): void {
    switch (event.kind) {
      case 'agent_text':
        if (!event.replay) {
          session.turn?.text(event.text);
        }
        return;
      case 'tool_call':
        if (!event.replay) {
          session.turn?.toolCall(event.title, event.toolCallId, event.update);
        }
        return;
      case 'tool_call_update':
        if (!event.replay && session.turn?.toolCallUpdate(event.toolCallId, event.status) === 'ignored') {
          // Only the turn's first complete_task is its completion (4.11).
          this.#logLine(session, { event: 'complete_task_ignored', turn: session.turn.turn }, true);
        }
        return;
      case 'permission_answered':
        // A request for the plugin's own tools is not one of the policy's answers.
        if (this.#takeOwnToolRequest(session, event.toolCallId) || event.via === 'withdrawn') {
          return;
        }
        if (event.optionKind === 'allow_once' || event.optionKind === 'allow_always') {
          session.allowed += 1;
        } else {
          session.denied += 1;
        }
        return;
      default:
        return;
    }
  }

  /** Whether the answered request `toolCallId` was decided as an own tool's; forgets one such decision. */
  #takeOwnToolRequest(session: Session, toolCallId: string): boolean {
    const open = session.ownToolRequests.get(toolCallId);
    if (open === undefined) {
      return false;
    }
    if (open > 1) {
      session.ownToolRequests.set(toolCallId, open - 1);
    } else {
      session.ownToolRequests.delete(toolCallId);
    }
    return true;
  }

  #onLifecycle(session: Session, entry: LifecycleEntry): void {
    if (entry.event === 'frame') {
      this.#logLine(session, { event: 'frame', dir: entry.dir, message: prepareDebugFrame(entry.message, session.secrets) }, false);
      return;
    }
    this.#logLine(
      session,
      entry,
      entry.event !== 'update' && entry.event !== 'notification' && entry.event !== 'mcp_status',
    );
  }

  #logLine(session: Session, entry: object, lifecycle: boolean): void {
    if (session.acpClosed) {
      return;
    }
    try {
      session.acpLog.write(JSON.stringify({ at: isoSeconds(), ...entry }), { lifecycle });
    } catch (error) {
      this.#onError(error, `acp log of ${session.launchId}`);
    }
  }

  // --- shutdown ---------------------------------------------------------------

  /**
   * Kills local children (SIGTERM, then SIGKILL) and starts one detached
   * `docker rm -f` for the containers, then waits for each session to end: a
   * running turn gets its result (`exited`, saying the server shut down) and
   * every run its final state before this resolves. Resolves within the
   * shutdown budget, ended or not; the startup sweep settles what was left.
   * Later `start` and `send` calls answer `E_BUSY`.
   */
  shutdown(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  async #shutdown(): Promise<void> {
    const began = performance.now();
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) {
      session.startAbort.abort(new Error('the server is shutting down'));
    }
    const names = sessions.flatMap((session) =>
      session.mode === 'docker' && session.containerName !== null && session.handle !== undefined
        ? [session.containerName]
        : [],
    );
    this.#removeContainers(names);
    for (const session of sessions) {
      if (session.turn !== null && !this.#connectionDead(session)) {
        this.#shutDownTurns.add(session.turn);
      }
    }
    const kills = sessions.flatMap((session) =>
      session.client === undefined ? [] : [session.client.terminate(this.#shutdownLimits.graceMs)],
    );
    // A session has ended once its turn result and its final state are written.
    const ends = sessions.map((session) => session.gone.promise);
    const left = Math.max(0, this.#shutdownLimits.budgetMs - (performance.now() - began));
    const timer = new AbortController();
    await Promise.race([
      Promise.allSettled([...kills, ...ends]),
      sleep(left, undefined, { signal: timer.signal }).catch(() => {}),
    ]);
    timer.abort();
  }

  #removeContainers(names: readonly string[]): void {
    if (names.length === 0) {
      return;
    }
    try {
      this.#deps.removeContainers(names, this.#env);
    } catch (error) {
      this.#onError(error, 'container removal');
    }
  }

  // --- helpers ----------------------------------------------------------------

  #assertOpen(): void {
    if (this.#closing !== undefined) {
      throw new SidecarError('E_BUSY', 'The server is shutting down');
    }
  }

  #labelTaken(label: string): boolean {
    if (this.#reservedLabels.has(label)) {
      return true;
    }
    for (const session of this.#sessions.values()) {
      if (session.label === label && !session.ended) {
        return true;
      }
    }
    return false;
  }

  /**
   * Creates the run directory of a new start and takes its lock. When the
   * start was given up meanwhile, the lock is released and the directory,
   * which holds nothing yet, is removed.
   */
  async #newRun(
    giveUp: AbortSignal,
  ): Promise<{ owner: string; driver: ProcessIdentity; launchId: string; paths: RunPaths; lock: RunLock }> {
    const { owner, driver } = await this.#identities();
    const { launchId, paths } = await createRun(this.#stateDir);
    let lock: RunLock | undefined;
    try {
      const attempt = await acquireRunLock(this.#stateDir, launchId, driver);
      if (!attempt.acquired) {
        throw new SidecarError('E_INTERNAL', `Could not take the lock of the new run ${launchId}`);
      }
      lock = attempt.lock;
      if (giveUp.aborted) {
        throw new SidecarError('E_INTERNAL', `The start was given up before run ${launchId} was set up`);
      }
      return { owner, driver, launchId, paths, lock };
    } catch (error) {
      await lock?.release().catch(() => undefined);
      await rm(paths.dir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  #identities(): Promise<{ owner: string; driver: ProcessIdentity; home: string }> {
    this.#identity ??= (async () => {
      const owner = this.#ownerOption ?? (await currentOwner());
      const driver = this.#driverOption ?? (await currentDriver());
      const home = await this.#homeFor(undefined);
      return { owner: ownerKey(owner), driver, home };
    })();
    return this.#identity;
  }

  async #homeFor(override: string | undefined): Promise<string> {
    const chosen = override ?? (this.#settings.home === '' ? undefined : this.#settings.home);
    try {
      return await resolveHomeName({ override: chosen, projectDir: this.#projectDir ?? undefined });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new InvalidInputError('home', `must be ${HOME_NAME_RULE}`);
      }
      throw error;
    }
  }

  /**
   * Writes `meta.json` with `patch`, in the order the changes were made.
   * Every string of the record passes the run's secret set first.
   */
  #persist(session: Session, patch: Partial<RunMeta>): Promise<void> {
    session.meta = { ...session.meta, ...patch, updatedAt: isoSeconds() };
    const meta = redactStrings(session.meta, session.secrets);
    const write = session.metaChain.then(() => writeMeta(session.lock, meta));
    session.metaChain = write.catch(() => {});
    return write;
  }

  #track(work: Promise<void>, where: string): void {
    const task = work.catch((error: unknown) => this.#onError(error, where));
    this.#background.add(task);
    void task.finally(() => this.#background.delete(task));
  }
}

function latch(): Latch {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * The secret set of a run: the server's secrets, `api_key` (the value the
 * Kiro process receives as `KIRO_API_KEY`) and the server's own
 * `KIRO_API_KEY`, which Kiro never gets but stays a secret whatever its
 * length. Throws `InvalidInputError` when `api_key` is too short.
 */
function runSecrets(apiKey: string, env: Environment): SecretSet {
  return buildSecretSet({ apiKey, env, kiroKeys: [env[TOKEN_VARIABLE] ?? ''] });
}

/** True when `work` settles (either way) within `ms`. */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      sleep(ms, false, { signal: timer.signal }).catch(() => false),
    ]);
  } finally {
    timer.abort();
  }
}

function isClosedError(error: unknown): boolean {
  return error instanceof AcpClientError && error.code === 'closed';
}

function errorCodeOf(error: unknown): unknown {
  return error instanceof Error ? (error as { code?: unknown }).code : undefined;
}

/** Sends `signal` to `target`, a pid or a negated process group id; false when nothing could be signalled. */
function trySignal(target: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes one container and waits: `docker rm -f <name>`. Resolves true when
 * docker removed it (it prints the name), false when there was none: an empty
 * output, or the "no such container" error of older clients. Throws
 * `TypeError` for a name outside this plugin's prefix.
 */
async function removeContainerNow(name: string, env: Environment): Promise<boolean> {
  if (!isRemovableContainerName(name)) {
    throw new TypeError(`Refusing to remove container ${JSON.stringify(name)}`);
  }
  const result = await runDocker(['rm', '-f', name], {
    env: stripClaudeVariables(env),
    timeoutMs: CONTAINER_REMOVE_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    if (/no such container/i.test(result.stderr)) {
      return false;
    }
    throw new SidecarError('E_DOCKER', `docker rm -f ${name} exited with code ${result.code}: ${stderrSummary(result.stderr)}`);
  }
  return result.stdout.trim() !== '';
}

/** The answer of `send` for a session that completed by itself: never resumable. */
function completedError(launchId: string): InvalidInputError {
  return new InvalidInputError('session', `${launchId}: the session completed by itself; start a new session`);
}

function closeAcpLog(session: Session): void {
  if (!session.acpClosed) {
    session.acpClosed = true;
    session.acpLog.close();
  }
}

function snapshot(session: Session): LiveSession {
  return {
    launchId: session.launchId,
    state: session.state,
    currentTurn: session.currentTurn,
    // A completed session's turn still runs until its result exists (4.11, steps 1 and 2).
    runningTurn:
      (session.state === 'running' || session.state === 'completed') && session.turn !== null
        ? session.turn.live()
        : null,
    permissionsAnswered: { allowed: session.allowed, denied: session.denied },
  };
}

function optionalText(value: string | undefined, field: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value === '') {
    throw new InvalidInputError(field, 'must not be empty');
  }
  return value;
}

/** The `mounts` argument of a docker `start`, each entry `path` or `path:ro`; omitted is none. */
function mountSpecs(value: unknown): MountSpec[] {
  return stringList(value, 'mounts').map(parseMountSpec);
}

/** A list argument of strings; omitted is an empty list. */
function stringList(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new InvalidInputError(field, 'must be an array of strings');
  }
  return value;
}

/** Why a docker start fails when its mount sources resolve otherwise at the spawn than at validation. */
const MOUNTS_CHANGED = 'the mount sources changed after validation';

/**
 * Resolves the mount request of a docker start again and fails the step
 * unless it gives the set validation resolved: every mount with the same
 * role, path and mode, and the same state directory mask. `docker run` gets
 * the paths by name, so a source replaced since then (by a symlink, say)
 * would mount what it names now. A request that is now refused fails the
 * step too. This narrows the window before `docker run`; it does not close it.
 */
async function assertMountsUnchanged(request: MountRequest, validated: MountSet): Promise<void> {
  let current: MountSet;
  try {
    current = await resolveMountSet(request);
  } catch (error) {
    throw new StepFailure(`${MOUNTS_CHANGED}: ${describeError(error)}`);
  }
  const same = (mount: ResolvedMount, index: number): boolean => {
    const before = validated.all[index];
    return before !== undefined && mount.role === before.role && mount.path === before.path && mount.readOnly === before.readOnly;
  };
  if (current.all.length !== validated.all.length || !current.all.every(same) || current.stateMask !== validated.stateMask) {
    throw new StepFailure(MOUNTS_CHANGED);
  }
}

/** The model whose effort levels Kiro does not offer (measured, spec 3.2). */
const AUTO_MODEL = 'auto';

/**
 * Why `effortLevel` will not be offered, when the session's model is `auto`
 * (offered so, or just set): the step `effort` fails at once instead of
 * waiting out its cap.
 */
function effortNeverOffered(offered: readonly SessionConfigOption[]): string | null {
  return currentValue(offered, MODEL_OPTION) === AUTO_MODEL ? `model "${AUTO_MODEL}" has no effort levels` : null;
}

function currentValue(options: readonly SessionConfigOption[] | undefined, id: string): string | null {
  const option = options?.find((candidate) => candidate.id === id);
  if (option === undefined || option.currentValue === undefined || option.currentValue === null) {
    return null;
  }
  return String(option.currentValue);
}

/** Aborts when the start deadline is reached or the client aborts the call. */
function startGiveUp(deadlineMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(0, deadlineMs));
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

/**
 * Runs a part of `start` that comes before its steps (the checks, creating
 * the run) within the start deadline and the client abort. When either comes
 * first the call answers `E_STEP_<part>` at once; `work` finishes on its own.
 */
async function beforeSteps<T>(part: string, work: Promise<T>, giveUp: AbortSignal): Promise<T> {
  work.catch(() => {});
  let onGiveUp = (): void => {};
  const givenUp = new Promise<never>((_resolve, reject) => {
    onGiveUp = () => {
      const timedOut = giveUp.reason instanceof DOMException && giveUp.reason.name === 'TimeoutError';
      const reason = timedOut ? 'the start deadline was reached' : 'the start was aborted';
      reject(new SidecarError(`E_STEP_${part.toUpperCase()}`, `start step ${part} failed: ${reason}`));
    };
  });
  if (giveUp.aborted) {
    onGiveUp();
  } else {
    giveUp.addEventListener('abort', onGiveUp, { once: true });
  }
  try {
    return await Promise.race([work, givenUp]);
  } finally {
    giveUp.removeEventListener('abort', onGiveUp);
  }
}

/** A step's limits: its cap, never more than what is left of the start deadline. */
function stepOptions(step: string, capMs: number, deadline: number, signal: AbortSignal): StepOptions {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) {
    throw new StepFailure(`the start deadline was reached before step ${step}`);
  }
  return { timeoutMs: Math.min(capMs, remaining), signal };
}

/**
 * The step `tools`: waits until Kiro reports the plugin's tool server
 * connected with both its tools, which may already be so. Every other status
 * is logged by the client and waited through; the cap fails the step, so
 * `E_STEP_TOOLS` names the last status seen and carries the stderr tail.
 */
async function waitForToolServer(client: KiroAcpClient, sessionId: string, options: StepOptions): Promise<void> {
  try {
    await client.waitForMcpServer(sessionId, TOOL_SERVER_NAME, TOOL_SERVER_TOOLS, options);
  } catch (error) {
    if (error instanceof AcpClientError && error.code === 'timeout') {
      throw new StepFailure(toolServerNotConnected(client.mcpServerStatus(sessionId, TOOL_SERVER_NAME)));
    }
    throw error;
  }
}

/**
 * A step `model`, `effort` or `kiro_mode`: waits until Kiro offers the
 * option, which may already be so (Kiro can answer `session/new` before it
 * offers `model`), then sets it; the wait and the change share the step's
 * limits. An option still missing at the cap, or a value the offered option
 * does not list, is `E_INVALID`; so is a missing option `never` gives a reason
 * for, at once: it will not be offered.
 */
async function setOfferedOption(
  client: KiroAcpClient,
  sessionId: string,
  field: string,
  configId: string,
  value: string,
  limits: StepOptions,
  secrets: SecretSet,
  never: (offered: readonly SessionConfigOption[]) => string | null = () => null,
): Promise<void> {
  const started = performance.now();
  try {
    let reason: string | null;
    try {
      reason = await client.waitForConfig(
        sessionId,
        `${configId} option`,
        (offered) => (offered.some((option) => option.id === configId) ? null : (never(offered) ?? undefined)),
        limits,
      );
    } catch (error) {
      if (error instanceof AcpClientError && error.code === 'timeout') {
        throw missingOptionError(client.configOptions(sessionId), configId);
      }
      throw error;
    }
    if (reason !== null) {
      const missing = missingOptionError(client.configOptions(sessionId), configId);
      throw new AcpClientError('invalid_config', `${missing.message}; ${reason}`);
    }
    const left =
      limits.timeoutMs === undefined ? undefined : Math.max(1, Math.ceil(limits.timeoutMs - (performance.now() - started)));
    await client.setConfig(sessionId, configId, value, { ...limits, timeoutMs: left });
  } catch (error) {
    if (error instanceof AcpClientError && error.code === 'invalid_config') {
      throw new InvalidInputError(field, `is not offered by Kiro: ${secrets.redact(error.message)}`);
    }
    throw error;
  }
}

/**
 * Fails the start step when a value Kiro returned holds a secret: such a
 * value is never kept, so the run is not recorded with it.
 */
function assertNoSecret(secrets: SecretSet, step: string, what: string, value: string | null): void {
  if (value !== null && secrets.redact(value) !== value) {
    throw new SidecarError(
      `E_STEP_${step.toUpperCase()}`,
      `start step ${step} failed: Kiro returned a ${what} holding a secret`,
    );
  }
}

/** A copy of `value` with every string in it, at any depth, redacted. */
function redactStrings<T>(value: T, secrets: SecretSet): T {
  if (typeof value === 'string') {
    return secrets.redact(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactStrings(item, secrets)) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactStrings(item as unknown, secrets)]),
    ) as T;
  }
  return value;
}

/**
 * Races an awaited operation of `start` against the start deadline and the
 * start abort: when either comes first the step fails at once, while
 * `work` goes on by itself.
 */
async function withinStart<T>(work: Promise<T>, deadline: number, signal: AbortSignal): Promise<T> {
  work.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  let onAbort = (): void => {};
  const givenUp = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new StepFailure('the start was aborted'));
      return;
    }
    onAbort = () => reject(new StepFailure('the start was aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () => reject(new StepFailure('the start deadline was reached')),
      Math.max(0, deadline - performance.now()),
    );
  });
  givenUp.catch(() => {});
  try {
    return await Promise.race([work, givenUp]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** Bounds a host check by step options: a timeout or an abort fails the step. */
async function bounded<T>(work: Promise<T>, options: StepOptions): Promise<T> {
  const { timeoutMs, signal } = options;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const guards: Promise<never>[] = [];
  if (timeoutMs !== undefined) {
    guards.push(
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StepFailure(`did not finish within ${timeoutMs} ms`)), timeoutMs);
      }),
    );
  }
  if (signal !== undefined) {
    if (signal.aborted) {
      throw new StepFailure('the start was aborted');
    }
    guards.push(
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new StepFailure('the start was aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    );
  }
  work.catch(() => {});
  try {
    return await Promise.race([work, ...guards]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
