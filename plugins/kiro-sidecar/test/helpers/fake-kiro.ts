/**
 * Starts the fake Kiro agent (`test/fixtures/fake-kiro.ts`) through the same
 * local spawn path the server uses, and wires a `KiroAcpClient` to it.
 *
 * The launcher is a node script with a shebang, so the child is started
 * directly, with no shell adding variables to its environment.
 */
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AnyMessage } from '@agentclientprotocol/sdk';
import { KiroAcpClient } from '../../src/acp/client.ts';
import type { AcpClientOptions, PermissionDecider } from '../../src/acp/client.ts';
import type { LifecycleEntry, TurnEvent } from '../../src/acp/events.ts';
import { spawnLocalKiro } from '../../src/acp/local.ts';
import type { Environment } from '../../src/settings.ts';
import { removeTree } from './processes.ts';

export const FAKE_KIRO = fileURLToPath(new URL('../fixtures/fake-kiro.ts', import.meta.url));
export const TURN_RECORDING = fileURLToPath(new URL('../fixtures/kiro-v3-turn.jsonl', import.meta.url));

export interface FakeKiroOptions {
  readonly decidePermission?: PermissionDecider;
  readonly serverEnv?: Environment;
  readonly debugFrames?: boolean;
  readonly maxMessageBytes?: number;
  readonly oversizeBytes?: number;
  readonly killGraceMs?: number;
}

export interface FakeStart {
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly pid: number;
}

export interface FakeKiro {
  readonly client: KiroAcpClient;
  readonly dir: string;
  readonly events: TurnEvent[];
  readonly lifecycle: LifecycleEntry[];
  /** The fake's stderr chunks, as received. */
  readonly stderr: Buffer[];
  /** What the fake wrote about its own start. */
  started(): Promise<FakeStart>;
  /** Every message the fake received, in order. */
  received(): Promise<AnyMessage[]>;
}

export async function startFakeKiro(
  t: TestContext,
  scenario: string,
  options: FakeKiroOptions = {},
): Promise<FakeKiro> {
  const dir = await mkdtemp(join(tmpdir(), 'kiro-sidecar-fake-'));
  const launcher = await writeLauncher(dir, scenario, options.oversizeBytes);

  const stderr: Buffer[] = [];
  const events: TurnEvent[] = [];
  const lifecycle: LifecycleEntry[] = [];
  const handle = spawnLocalKiro(
    { kiroCommand: launcher, dir, serverEnv: options.serverEnv ?? process.env },
    {
      onStderr: (chunk) => stderr.push(chunk),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    },
  );
  const clientOptions: AcpClientOptions = {
    decidePermission: options.decidePermission ?? (() => 'allow'),
    events: (event) => events.push(event),
    lifecycle: (entry) => lifecycle.push(entry),
    ...(options.debugFrames === undefined ? {} : { debugFrames: options.debugFrames }),
    ...(options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes }),
  };
  const client = new KiroAcpClient(handle, clientOptions);
  t.after(async () => {
    try {
      await client.terminate(500);
    } finally {
      await removeTree(dir);
    }
  });

  return {
    client,
    dir,
    events,
    lifecycle,
    stderr,
    started: () => readStarted(dir),
    received: () => readReceived(dir),
  };
}

/** A work directory set up for the fake agent, not started yet. */
export interface FakeWorkspace {
  /** The work directory: the agent's cwd, where it reads its scenario. */
  readonly dir: string;
  /** The launcher to use as `kiro_command`. */
  readonly command: string;
  /** What the fake wrote about its own start. */
  started(): Promise<FakeStart>;
  /** Every message the fake received, in order. */
  received(): Promise<AnyMessage[]>;
  /** The prompts and cancels the fake handled, in order. */
  events(): Promise<FakeEvent[]>;
  /** Removes the work directory. */
  remove(): Promise<void>;
}

/** A prompt (and whether a turn was running when it arrived) or a cancel. */
export type FakeEvent = { readonly event: 'prompt'; readonly overlapped: boolean } | { readonly event: 'cancel' };

/**
 * Prepares a work directory and a launcher for the fake agent, for code that
 * spawns Kiro itself (the session manager runs `command` in `dir`). The
 * directory is removed when the test ends.
 *
 * `t.after` hooks run in the order they were added and a hook that throws
 * skips the rest, so this removal runs before any cleanup added later. A
 * fixture that also starts the agent uses `createFakeWorkspace` instead and
 * removes the directory itself, once the agent has ended.
 */
export async function prepareFakeKiro(t: TestContext, scenario: string): Promise<FakeWorkspace> {
  const workspace = await createFakeWorkspace(scenario);
  t.after(() => workspace.remove());
  return workspace;
}

/** Like `prepareFakeKiro`, but the caller removes the directory with `remove()`. */
export async function createFakeWorkspace(scenario: string): Promise<FakeWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), 'kiro-sidecar-fake-'));
  let command: string;
  try {
    command = await writeLauncher(dir, scenario, undefined);
  } catch (error) {
    await removeTree(dir);
    throw error;
  }
  return {
    dir,
    command,
    started: () => readStarted(dir),
    received: () => readReceived(dir),
    events: () => readLines<FakeEvent>(dir, 'fake-events.jsonl'),
    remove: () => removeTree(dir),
  };
}

async function writeLauncher(dir: string, scenario: string, oversizeBytes: number | undefined): Promise<string> {
  await writeFile(join(dir, 'fake-scenario.json'), JSON.stringify({ scenario, fixture: TURN_RECORDING, oversizeBytes }));
  const launcher = join(dir, 'kiro-cli.mjs');
  await writeFile(launcher, `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(FAKE_KIRO).href)});\n`);
  await chmod(launcher, 0o755);
  return launcher;
}

async function readStarted(dir: string): Promise<FakeStart> {
  return JSON.parse(await readFile(join(dir, 'fake-start.json'), 'utf8')) as FakeStart;
}

function readReceived(dir: string): Promise<AnyMessage[]> {
  return readLines<AnyMessage>(dir, 'fake-received.jsonl');
}

async function readLines<T>(dir: string, name: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(join(dir, name), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T);
}

/** The text of every agent message chunk, joined. */
export function agentText(events: readonly TurnEvent[], replay = false): string {
  return events
    .filter((event) => event.kind === 'agent_text' && event.replay === replay)
    .map((event) => (event.kind === 'agent_text' ? event.text : ''))
    .join('');
}
