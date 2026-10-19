/**
 * Builds a session manager over a temp state directory that runs the fake
 * Kiro agent in local mode.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnProcess } from '../../src/acp/process.ts';
import type { ProcessHandle } from '../../src/acp/process.ts';
import { SessionManager } from '../../src/session/manager.ts';
import type { ControlLimits, ManagerDeps, ShutdownLimits, StartLimits } from '../../src/session/manager.ts';
import type { TurnResult } from '../../src/session/types.ts';
import { DEFAULTS } from '../../src/settings.ts';
import type { Environment, Settings } from '../../src/settings.ts';
import type { ProcessIdentity } from '../../src/store/identity.ts';
import { readMeta } from '../../src/store/runs.ts';
import type { RunMeta } from '../../src/store/runs.ts';
import { createFakeWorkspace } from '../helpers/fake-kiro.ts';
import type { FakeWorkspace } from '../helpers/fake-kiro.ts';
import { endProcesses, removeTree } from '../helpers/processes.ts';

/** The built tool server: tests run from source, so they pass its path in. */
export const TOOL_SERVER_FILE = fileURLToPath(new URL('../../dist/sidecar-tools.js', import.meta.url));

export const PROCESS_TIMEOUT = { timeout: 30_000 };

/** A Kiro token for tests: long enough to pass the token check. */
export const TEST_TOKEN = 'ksk_fixture_token_0123456789abcdef';

/** A Kiro token whose URL-encoded form has percent escapes with hex letters. */
export const ESCAPED_TOKEN = 'ksk/fixture:token@0123456789abcdef';

/** The URL-encoded form of `ESCAPED_TOKEN` in lower case, to search text lower-cased. */
export const ESCAPED_TOKEN_ENCODED_LOWER = encodeURIComponent(ESCAPED_TOKEN).toLowerCase();

export interface ManagerFixture {
  readonly manager: SessionManager;
  readonly stateDir: string;
  readonly workspace: FakeWorkspace;
  /** Failures the manager reported from background work. */
  readonly errors: string[];
  /** The pid of every process the manager spawned, in order. */
  readonly spawned: readonly number[];
}

export interface ManagerFixtureOptions {
  readonly settings?: Partial<Settings>;
  readonly env?: Environment;
  readonly deps?: Partial<ManagerDeps>;
  readonly startLimits?: Partial<StartLimits>;
  readonly shutdownLimits?: Partial<ShutdownLimits>;
  readonly controlLimits?: Partial<ControlLimits>;
  readonly owner?: ProcessIdentity;
  /** The tool server file the manager checks and injects; default {@link TOOL_SERVER_FILE}. */
  readonly toolServerFile?: string;
  /**
   * A spawn returns only once the fake has written its start file. The
   * initialize step's clock starts when the spawn returns, so its limit then
   * counts from a running fake, not from the fake's own startup.
   */
  readonly waitForFakeStart?: boolean;
}

/** How long a spawn waits for the fake to start (`waitForFakeStart`). */
const FAKE_START_MS = 15_000;

const pause = new Int32Array(new SharedArrayBuffer(4));

/** Blocks until the fake in `dir` has written its start file; the spawn is synchronous, so this is too. */
function waitForFakeStartSync(dir: string, handle: ProcessHandle): void {
  const deadline = performance.now() + FAKE_START_MS;
  while (!existsSync(join(dir, 'fake-start.json'))) {
    if (performance.now() > deadline) {
      void handle.kill(0);
      throw new Error(`The fake did not start within ${FAKE_START_MS} ms`);
    }
    Atomics.wait(pause, 0, 0, 10);
  }
}

/** A small environment, so the test runner's own variables never reach the fake. */
export function testEnvironment(extra: Environment = {}): Environment {
  return { PATH: process.env['PATH'], HOME: process.env['HOME'], ...extra };
}

export async function managerFixture(
  t: TestContext,
  scenario: string,
  options: ManagerFixtureOptions = {},
): Promise<ManagerFixture> {
  const workspace = await createFakeWorkspace(scenario);
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-sidecar-state-'));
  const errors: string[] = [];
  const settings: Settings = {
    ...DEFAULTS,
    api_key: TEST_TOKEN,
    kiro_command: workspace.command,
    default_mode: 'local',
    ...options.settings,
  };
  const spawned: number[] = [];
  const handles: ProcessHandle[] = [];
  const spawn = options.deps?.spawn ?? spawnProcess;
  const deps: Partial<ManagerDeps> = {
    // The sweep never lists this host's real containers unless a test asks it to.
    listHostContainers: async () => [],
    ...options.deps,
    spawn: (spec, processOptions) => {
      const handle = spawn(spec, processOptions);
      handles.push(handle);
      if (handle.pid !== undefined) {
        spawned.push(handle.pid);
      }
      if (options.waitForFakeStart === true) {
        waitForFakeStartSync(workspace.dir, handle);
      }
      return handle;
    },
  };
  const manager = new SessionManager({
    settings,
    stateDir,
    env: options.env ?? testEnvironment(),
    projectDir: null,
    onError: (error, where) => errors.push(`${where}: ${String(error)}`),
    ...(options.owner === undefined ? {} : { owner: options.owner }),
    deps,
    ...(options.startLimits === undefined ? {} : { startLimits: options.startLimits }),
    ...(options.shutdownLimits === undefined ? {} : { shutdownLimits: options.shutdownLimits }),
    ...(options.controlLimits === undefined ? {} : { controlLimits: options.controlLimits }),
    toolServerFile: options.toolServerFile ?? TOOL_SERVER_FILE,
  });
  // One hook, children first: the shutdown returns within its budget, maybe
  // before a child has ended, so every child is ended and reaped before the
  // directories it writes into are removed. A failing step cannot skip that.
  t.after(async () => {
    try {
      await manager.shutdown();
    } finally {
      await endProcesses(handles);
      await manager.settled();
      await Promise.all([workspace.remove(), removeTree(stateDir)]);
    }
  });
  return { manager, stateDir, workspace, errors, spawned };
}

export async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await condition())) {
    if (performance.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function metaOf(stateDir: string, launchId: string): Promise<RunMeta> {
  const meta = await readMeta(stateDir, launchId);
  if (meta === undefined) {
    throw new Error(`No meta for ${launchId}`);
  }
  return meta;
}

export async function turnResultOf(stateDir: string, launchId: string, turn: number): Promise<TurnResult> {
  return JSON.parse(await readFile(join(stateDir, 'runs', launchId, 'turns', `${turn}.json`), 'utf8')) as TurnResult;
}

/** Waits until turn n has its result and the manager has finished the turn's bookkeeping. */
export async function endedTurn(fixture: ManagerFixture, launchId: string, turn: number): Promise<TurnResult> {
  const ended = fixture.manager.turnEnded(launchId, turn);
  if (ended !== undefined) {
    await ended;
  }
  await fixture.manager.settled();
  return turnResultOf(fixture.stateDir, launchId, turn);
}

/** Every `session/prompt` the fake received. */
export async function promptsReceived(workspace: FakeWorkspace): Promise<number> {
  const received = await workspace.received();
  return received.filter((message) => 'method' in message && message.method === 'session/prompt').length;
}
