import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { KiroAcpClient } from '../../src/acp/client.ts';
import { spawnProcess } from '../../src/acp/process.ts';
import { SidecarError } from '../../src/errors.ts';
import { TurnClaims } from '../../src/session/claims.ts';
import type { ManagerDeps } from '../../src/session/manager.ts';
import { currentOwner, ownerKey, processIdentity } from '../../src/store/identity.ts';
import type { ProcessIdentity } from '../../src/store/identity.ts';
import { acquireRunLock, RunLock } from '../../src/store/lock.ts';
import { turnPaths } from '../../src/store/paths.ts';
import { createRun, readCall, writeMeta } from '../../src/store/runs.ts';
import type { RunMeta } from '../../src/store/runs.ts';
import { InvalidInputError } from '../../src/text/errors.ts';
import type { FakeEvent, FakeWorkspace } from '../helpers/fake-kiro.ts';
import { deadIdentity, startIdleProcess, tempDir } from '../helpers/processes.ts';
import type { LiveProcess } from '../helpers/processes.ts';
import {
  PROCESS_TIMEOUT,
  TEST_TOKEN,
  endedTurn,
  isAlive,
  managerFixture,
  metaOf,
  promptsReceived,
  testEnvironment,
  turnResultOf,
  waitFor,
} from './manager-helpers.ts';
import type { ManagerFixture, ManagerFixtureOptions } from './manager-helpers.ts';

function assertCode(error: unknown, code: string, fragment?: string): boolean {
  assert.ok(error instanceof SidecarError || error instanceof InvalidInputError, `unexpected ${String(error)}`);
  assert.equal(error.code, code, error.message);
  if (fragment !== undefined) {
    assert.ok(error.message.includes(fragment), error.message);
  }
  return true;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Records, at the moment `session/cancel` is sent, whether the running turn's
 * `.claimed` marker is already on disk.
 */
function watchCancels(t: TestContext, stateDir: string, launchId: string, turn: number): boolean[] {
  const claimedAtCancel: boolean[] = [];
  const original = KiroAcpClient.prototype.cancel;
  t.mock.method(KiroAcpClient.prototype, 'cancel', function (this: KiroAcpClient, sessionId: string) {
    claimedAtCancel.push(existsSync(turnPaths(stateDir, launchId, turn).claimed));
    return original.call(this, sessionId);
  });
  return claimedAtCancel;
}

/**
 * The fake's events once it has logged `prompts` prompts. A turn opens when
 * its prompt is written to the agent, not when the agent has read it, so the
 * log can trail the reply. After `timeoutMs` the log is returned as it is,
 * and the assertion on it shows what is missing.
 */
async function eventsOnceLogged(workspace: FakeWorkspace, prompts: number, timeoutMs = 10_000): Promise<FakeEvent[]> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const events = await workspace.events();
    if (events.filter((entry) => entry.event === 'prompt').length >= prompts || performance.now() > deadline) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A session with turn 1 running a tool that only an interruption ends. */
async function runningSession(
  t: TestContext,
  scenario: string,
  options: ManagerFixtureOptions = {},
): Promise<{ fixture: ManagerFixture; launchId: string }> {
  const fixture = await managerFixture(t, scenario, options);
  const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: 'run a long tool' });
  await waitFor(() => fixture.manager.get(launchId)?.runningTurn?.toolCalls === 1, 'the running tool');
  return { fixture, launchId };
}

/** A docker-mode fixture: the fake runs locally, the container removal is injected. */
async function dockerFixture(
  t: TestContext,
  scenario: string,
  removeContainer: ManagerDeps['removeContainer'],
): Promise<ManagerFixture> {
  let command = '';
  const fixture = await managerFixture(t, scenario, {
    settings: { api_key: TEST_TOKEN },
    deps: {
      resolveDockerUser: async () => '0:0',
      checkImage: async () => {},
      spawn: (spec, options) =>
        spawnProcess(
          { argv: [command, 'acp', '--agent-engine', 'v3'], env: testEnvironment() as Record<string, string>, cwd: spec.cwd },
          options,
        ),
      removeContainers: () => {},
      removeContainer,
    },
  });
  command = fixture.workspace.command;
  return fixture;
}

let idleProcess: LiveProcess | undefined;
async function liveIdentity(t: TestContext): Promise<ProcessIdentity> {
  if (idleProcess === undefined) {
    idleProcess = await startIdleProcess();
    const started = idleProcess;
    t.after(async () => {
      await started.stop();
      idleProcess = undefined;
    });
  }
  return idleProcess.identity;
}

/** A run this manager does not drive, written straight to the state dir. */
async function seedRun(t: TestContext, stateDir: string, owner: ProcessIdentity, patch: Partial<RunMeta>): Promise<string> {
  const { launchId } = await createRun(stateDir);
  const attempt = await acquireRunLock(stateDir, launchId, await liveIdentity(t));
  assert.ok(attempt.acquired);
  const now = '2026-10-18T00:00:00Z';
  const meta: RunMeta = {
    launchId, kiroSessionId: 'sess_seeded', ownerKey: ownerKey(owner), driver: await deadIdentity(), home: 'default',
    projectDir: null, label: null, mode: 'local', dir: '/tmp', dirReadOnly: false, mounts: [], skills: [], steering: [],
    model: null, effort: null, kiroMode: null, permissions: 'allow', preset: null, tokenSource: null, image: null,
    dockerUser: null, containerName: null, child: null, state: 'exited', currentTurn: 0, firstPromptPreview: null,
    createdAt: now, updatedAt: now, ...patch,
  };
  await writeMeta(attempt.lock, meta);
  await attempt.lock.release();
  return launchId;
}

const FILE_RECREATOR = new URL('../fixtures/file-recreator.ts', import.meta.url);

/**
 * Runs `work` while a worker recreates `file` once, within microseconds of
 * its deletion, as the waiter's heartbeat can during a purge. Resolves to
 * what `work` gave and whether the file was recreated.
 */
async function whileRecreating<T>(t: TestContext, file: string, work: () => Promise<T>): Promise<{ value: T; recreated: boolean }> {
  const worker = new Worker(FILE_RECREATOR, { workerData: { file, recreations: 1, deadlineMs: 10_000 } });
  t.after(() => worker.terminate());
  const messages: unknown[] = [];
  worker.on('message', (message: unknown) => messages.push(message));
  const exited = once(worker, 'exit');
  await waitFor(() => messages.includes('ready'), 'the recreating worker');
  const value = await work();
  assert.deepEqual(await exited, [0]);
  return { value, recreated: messages.at(-1) === 1 };
}

describe('SessionManager.send with interrupt', () => {
  test('returns the interrupted turn and opens the next one only after it ended', PROCESS_TIMEOUT, async (t) => {
    const { fixture, launchId } = await runningSession(t, 'slow-cancel');
    const { manager, stateDir, workspace } = fixture;
    const claimedAtCancel = watchCancels(t, stateDir, launchId, 1);

    const reply = await manager.send({ launchId, text: 'next', interrupt: true });

    assert.deepEqual(claimedAtCancel, [true]);
    assert.equal(reply.turn, 2);
    assert.ok(reply.trailer.includes(`kiro-turn: ${launchId}#2`), reply.trailer);
    assert.ok(reply.interrupted !== null);
    assert.equal(reply.interrupted.turn, 1);
    assert.equal(reply.interrupted.result.outcome, 'cancelled');
    assert.equal(reply.interrupted.result.endedBy, 'interrupt');
    assert.equal(reply.interrupted.resultLine, `kiro-result: ${launchId}#1`);
    assert.equal(await exists(turnPaths(stateDir, launchId, 1).returned), true);
    assert.equal(await exists(turnPaths(stateDir, launchId, 1).claimed), false);
    assert.deepEqual(await eventsOnceLogged(workspace, 2), [
      { event: 'prompt', overlapped: false },
      { event: 'cancel' },
      { event: 'prompt', overlapped: false },
    ]);
    assert.equal(manager.get(launchId)?.state, 'running');
    assert.equal(manager.get(launchId)?.currentTurn, 2);
    assert.deepEqual(fixture.errors, []);
  });

  test('a turn that does not end in time is E_CANCEL_TIMEOUT and nothing is prompted', PROCESS_TIMEOUT, async (t) => {
    const { fixture, launchId } = await runningSession(t, 'slow-cancel', { controlLimits: { cancelWaitMs: 200 } });
    const { manager, stateDir, workspace } = fixture;

    await assert.rejects(manager.send({ launchId, text: 'next', interrupt: true }, { toolUseId: 'toolu_interrupt' }), (error) =>
      assertCode(error, 'E_CANCEL_TIMEOUT'),
    );
    assert.equal(await exists(turnPaths(stateDir, launchId, 1).claimed), false);
    assert.equal(manager.get(launchId)?.state, 'running');
    assert.equal(manager.get(launchId)?.currentTurn, 1);

    const result = await endedTurn(fixture, launchId, 1);
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.endedBy, 'interrupt');
    assert.equal(await exists(turnPaths(stateDir, launchId, 1).returned), false);
    assert.equal(await promptsReceived(workspace), 1);
    assert.equal(manager.get(launchId)?.state, 'idle');

    // The failure keeps the run, the turn the send would have opened, and the driver.
    const call = await readCall(stateDir, 'toolu_interrupt');
    const { error, ...location } = call as { error: string };
    assert.match(error, /did not end within 200 ms of session\/cancel/);
    const { driver } = await metaOf(stateDir, launchId);
    assert.deepEqual(location, { launchId, turn: 2, driver, failed: true });
  });

  test('on an idle session it only opens the turn', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir });
    const reply = await fixture.manager.send({ launchId, text: 'hello', interrupt: true });
    assert.equal(reply.turn, 1);
    assert.equal(reply.interrupted, null);
    assert.equal((await endedTurn(fixture, launchId, 1)).outcome, 'end_turn');
    assert.deepEqual(await fixture.workspace.events(), [{ event: 'prompt', overlapped: false }]);
  });

  test('without interrupt a running session stays E_BUSY', PROCESS_TIMEOUT, async (t) => {
    const { fixture, launchId } = await runningSession(t, 'cancel-tool');
    await assert.rejects(fixture.manager.send({ launchId, text: 'next' }), (error) => assertCode(error, 'E_BUSY', 'running turn 1'));
    await assert.rejects(fixture.manager.send({ launchId, text: 'next', interrupt: 'yes' as unknown as boolean }), (error) =>
      assertCode(error, 'E_INVALID'),
    );
    assert.equal(await promptsReceived(fixture.workspace), 1);
  });
});

describe('SessionManager.cancel', () => {
  test('a running turn ends cancelled and its result is in the reply', PROCESS_TIMEOUT, async (t) => {
    const { fixture, launchId } = await runningSession(t, 'cancel-tool');
    const { manager, stateDir } = fixture;
    const claimedAtCancel = watchCancels(t, stateDir, launchId, 1);

    const reply = await manager.cancel({ launchId });

    assert.deepEqual(claimedAtCancel, [true]);
    assert.equal(reply.state, 'idle');
    assert.equal(reply.turn, 1);
    assert.ok(reply.sessionId !== null);
    assert.ok(reply.ended !== null);
    assert.equal(reply.ended.result.outcome, 'cancelled');
    assert.equal(reply.ended.result.endedBy, 'cancel');
    assert.equal(reply.ended.resultLine, `kiro-result: ${launchId}#1`);
    assert.equal(await exists(turnPaths(stateDir, launchId, 1).returned), true);
    assert.equal(await exists(turnPaths(stateDir, launchId, 1).claimed), false);
    assert.equal((await metaOf(stateDir, launchId)).state, 'idle');
    assert.deepEqual(fixture.errors, []);
  });

  test('a turn whose agent asked for permission still ends', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'cancel-permission');
    const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: 'list files' });
    await waitFor(() => fixture.manager.get(launchId)?.permissionsAnswered.allowed === 1, 'the permission request');
    const reply = await fixture.manager.cancel({ launchId });
    assert.equal(reply.ended?.result.outcome, 'cancelled');
    assert.equal(reply.ended?.result.endedBy, 'cancel');
  });

  test('a turn that does not end in time is cancelling and keeps endedBy', PROCESS_TIMEOUT, async (t) => {
    const { fixture, launchId } = await runningSession(t, 'slow-cancel', { controlLimits: { cancelWaitMs: 200 } });
    const { manager, stateDir } = fixture;

    const reply = await manager.cancel({ launchId });
    assert.equal(reply.state, 'cancelling');
    assert.equal(reply.turn, 1);
    assert.equal(reply.ended, null);
    assert.equal(await exists(turnPaths(stateDir, launchId, 1).claimed), false);

    const result = await endedTurn(fixture, launchId, 1);
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.endedBy, 'cancel');
    assert.equal(await exists(turnPaths(stateDir, launchId, 1).returned), false);
  });

  test('other states answer with the state; a start is E_BUSY', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'hang-initialize');
    const { manager, stateDir } = fixture;
    const own = await currentOwner();

    const starting = manager.start({ dir: fixture.workspace.dir });
    starting.catch(() => {});
    await waitFor(() => manager.list()[0]?.state === 'starting', 'the start');
    const startingId = manager.list()[0]?.launchId as string;
    await assert.rejects(manager.cancel({ launchId: startingId }), (error) => assertCode(error, 'E_BUSY', 'starting'));
    await manager.stop({ launchId: startingId });
    await assert.rejects(starting);

    for (const state of ['exited', 'stopped', 'failed'] as const) {
      const id = await seedRun(t, stateDir, own, { state });
      assert.deepEqual(await manager.cancel({ launchId: id }), {
        launchId: id, sessionId: 'sess_seeded', state, turn: null, ended: null,
      });
    }
    const lost = await seedRun(t, stateDir, own, { state: 'running', currentTurn: 1 });
    assert.equal((await manager.cancel({ launchId: lost })).state, 'lost');
  });

  test('an idle session answers idle and nothing is sent', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir });
    const reply = await fixture.manager.cancel({ launchId });
    assert.equal(reply.state, 'idle');
    assert.equal(reply.ended, null);
    assert.deepEqual(await fixture.workspace.events(), []);
  });
});

describe('SessionManager.stop', () => {
  test('a running turn ends stopped in the reply; a second stop is idempotent', PROCESS_TIMEOUT, async (t) => {
    const { fixture, launchId } = await runningSession(t, 'cancel-tool');
    const { manager, stateDir, workspace } = fixture;
    const { pid } = await workspace.started();

    const reply = await manager.stop({ launchId });

    assert.equal(reply.state, 'stopped');
    assert.ok(reply.ended !== null);
    assert.equal(reply.ended.turn, 1);
    assert.equal(reply.ended.result.outcome, 'stopped');
    assert.equal(reply.ended.result.endedBy, 'stop');
    assert.equal(reply.ended.resultLine, `kiro-result: ${launchId}#1`);
    assert.deepEqual(reply.failures, []);
    assert.ok(reply.cleanedUp.some((line) => line.includes('closed')), reply.cleanedUp.join('; '));
    assert.ok(reply.cleanedUp.some((line) => line.includes('exited after stdin was closed')), reply.cleanedUp.join('; '));
    assert.equal(await exists(turnPaths(stateDir, launchId, 1).returned), true);
    assert.equal(await exists(turnPaths(stateDir, launchId, 1).claimed), false);
    assert.equal(isAlive(pid), false);
    assert.equal((await metaOf(stateDir, launchId)).state, 'stopped');
    assert.equal(manager.get(launchId), undefined);
    assert.equal(await exists(join(stateDir, 'runs', launchId, 'lock')), false);
    const received = await workspace.received();
    assert.ok(received.some((message) => 'method' in message && message.method === 'session/close'));

    const again = await manager.stop({ launchId });
    assert.equal(again.state, 'stopped');
    assert.equal(again.ended, null);
    assert.deepEqual(again.failures, []);
    await manager.settled();
    assert.deepEqual(fixture.errors, []);
  });

  test('a process that stays after stdin closes is killed after the grace', PROCESS_TIMEOUT, async (t) => {
    const { fixture, launchId } = await runningSession(t, 'linger', { controlLimits: { stopGraceMs: 300, killGraceMs: 300 } });
    const { pid } = await fixture.workspace.started();

    const began = performance.now();
    const reply = await fixture.manager.stop({ launchId });
    const took = performance.now() - began;

    assert.ok(took < 300 + 300 + 1_500, `stop took ${Math.round(took)} ms`);
    assert.equal(isAlive(pid), false);
    assert.ok(reply.cleanedUp.some((line) => line.includes('killed 300 ms after stdin was closed')), reply.cleanedUp.join('; '));
    assert.equal(reply.ended?.result.outcome, 'stopped');
    assert.equal(reply.ended?.result.endedBy, 'stop');
    assert.equal(reply.state, 'stopped');
  });

  test('an idle session stops', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir });
    const { pid } = await fixture.workspace.started();
    const reply = await fixture.manager.stop({ launchId });
    assert.equal(reply.state, 'stopped');
    assert.equal(reply.ended, null);
    assert.equal(isAlive(pid), false);
    assert.equal((await metaOf(fixture.stateDir, launchId)).state, 'stopped');
  });

  test('a start is aborted and cleaned up; the run stays failed', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'hang-initialize');
    const { manager, stateDir, workspace } = fixture;
    const starting = manager.start({ dir: workspace.dir, prompt: 'hello' });
    starting.catch(() => {});
    await waitFor(async () => {
      try {
        await workspace.started();
        return true;
      } catch {
        return false;
      }
    }, 'the fake to start');
    const launchId = manager.list()[0]?.launchId as string;

    const reply = await manager.stop({ launchId });

    await assert.rejects(starting, (error) => assertCode(error, 'E_STEP_INITIALIZE', 'the start was aborted'));
    assert.equal(reply.state, 'failed');
    assert.ok(reply.cleanedUp.includes('start aborted'), reply.cleanedUp.join('; '));
    await waitFor(async () => !isAlive((await workspace.started()).pid), 'the fake to be gone', 5_000);
    assert.equal((await metaOf(stateDir, launchId)).state, 'failed');
    assert.deepEqual(manager.list(), []);
    assert.equal(await exists(join(stateDir, 'runs', launchId, 'lock')), false);
    assert.equal((await manager.stop({ launchId })).state, 'failed');
  });

  test('a docker session waits for the container removal and reports its failure', PROCESS_TIMEOUT, async (t) => {
    const removed: string[] = [];
    const fixture = await dockerFixture(t, 'default', async (name) => {
      removed.push(name);
      throw new SidecarError('E_DOCKER', 'docker rm -f failed: daemon unavailable');
    });
    const { launchId } = await fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir });
    const name = `kiro-sidecar-${launchId.slice('ks_'.length)}`;

    const reply = await fixture.manager.stop({ launchId });

    assert.deepEqual(removed, [name]);
    assert.equal(reply.state, 'stopped');
    assert.ok(reply.failures.some((line) => line.includes(name) && line.includes('daemon unavailable')), reply.failures.join('; '));
  });

  test('purge deletes the run directory and nothing in homes', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const { manager, stateDir } = fixture;
    const { launchId } = await manager.start({ dir: fixture.workspace.dir });
    const homeFile = join(stateDir, 'homes', 'default', 'keep.txt');
    await mkdir(join(stateDir, 'homes', 'default'), { recursive: true });
    await writeFile(homeFile, 'kept');
    const homesBefore = await readdir(join(stateDir, 'homes'), { recursive: true });

    const reply = await manager.stop({ launchId, purge: true });

    assert.equal(reply.purged, true);
    assert.equal(await exists(join(stateDir, 'runs', launchId)), false);
    assert.deepEqual(await readdir(join(stateDir, 'homes'), { recursive: true }), homesBefore);
    assert.equal(await exists(homeFile), true);
    await assert.rejects(manager.stop({ launchId }), (error) => assertCode(error, 'E_NOT_FOUND'));
    await assert.rejects(manager.stop({ launchId, purge: 'yes' as unknown as boolean }), (error) => assertCode(error, 'E_INVALID'));
  });

  test('purge deletes the run directory while a waiter heartbeat recreates its marker', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const { manager, stateDir } = fixture;
    const own = await currentOwner();
    // A long run: removing its many turn files keeps turns/ in place well after the marker is gone.
    const turns = 100;
    let raced = false;
    for (let round = 0; round < 5 && !raced; round += 1) {
      const launchId = await seedRun(t, stateDir, own, { state: 'exited', currentTurn: turns });
      for (let turn = 1; turn <= turns; turn += 1) {
        const paths = turnPaths(stateDir, launchId, turn);
        await writeFile(paths.result, '{}');
        await writeFile(paths.text, 'Done.');
      }
      const armed = turnPaths(stateDir, launchId, turns).armed;
      await writeFile(armed, '');

      const { value: reply, recreated } = await whileRecreating(t, armed, () => manager.stop({ launchId, purge: true }));

      assert.deepEqual(reply.failures, []);
      assert.equal(reply.purged, true);
      assert.equal(await exists(join(stateDir, 'runs', launchId)), false);
      raced = recreated;
    }
    // The marker came back inside turns/ during at least one purge.
    assert.equal(raced, true);
  });

  test('what a run this server does not drive left behind is cleaned up', PROCESS_TIMEOUT, async (t) => {
    const removed: string[] = [];
    const fixture = await dockerFixture(t, 'default', async (name) => {
      removed.push(name);
      return true;
    });
    const { manager, stateDir } = fixture;
    const own = await currentOwner();

    const exited = await seedRun(t, stateDir, own, { state: 'exited', currentTurn: 1 });
    await writeFile(turnPaths(stateDir, exited, 1).result, '{}');
    assert.equal((await manager.stop({ launchId: exited })).state, 'stopped');
    assert.equal((await metaOf(stateDir, exited)).state, 'stopped');

    const failed = await seedRun(t, stateDir, own, { state: 'failed' });
    assert.equal((await manager.stop({ launchId: failed })).state, 'failed');

    const docker = await seedRun(t, stateDir, own, { state: 'exited', mode: 'docker', containerName: 'kiro-sidecar-0123456789ab' });
    const dockerReply = await manager.stop({ launchId: docker });
    assert.deepEqual(removed, ['kiro-sidecar-0123456789ab']);
    assert.ok(dockerReply.cleanedUp.includes('container kiro-sidecar-0123456789ab removed'), dockerReply.cleanedUp.join('; '));

    const child = await startIdleProcess();
    t.after(() => child.stop());
    const stranger = await startIdleProcess();
    t.after(() => stranger.stop());
    const withChild = await seedRun(t, stateDir, own, { state: 'exited', child: { pid: child.identity.pid, startTime: child.identity.startTime } });
    const reused = await seedRun(t, stateDir, own, { state: 'exited', child: { pid: stranger.identity.pid, startTime: 'not-its-start-time' } });
    await manager.stop({ launchId: withChild });
    await manager.stop({ launchId: reused });
    await waitFor(() => !isAlive(child.identity.pid), 'the leftover child to be killed', 5_000);
    assert.equal(isAlive(stranger.identity.pid), true);

    const open = await seedRun(t, stateDir, own, { state: 'running', currentTurn: 1 });
    const openReply = await manager.stop({ launchId: open });
    assert.equal(openReply.state, 'lost');
    assert.ok(
      openReply.failures.some((line) => line.includes('turn 1 has no result yet; the state stays lost')),
      openReply.failures.join('; '),
    );
    assert.equal((await metaOf(stateDir, open)).state, 'running');
    const openStatus = await manager.stop({ launchId: open });
    assert.equal(openStatus.state, 'lost');
  });

  test('a leftover container is reported removed only when docker removed one', PROCESS_TIMEOUT, async (t) => {
    // A docker stand-in for `docker rm -f <name>`: a present container is
    // removed and its name printed; an absent one prints nothing and exits 0,
    // or, as older clients do, says so on stderr and exits 1.
    const bin = await tempDir(t);
    await writeFile(
      join(bin, 'docker'),
      `#!/bin/sh
case "$3" in
  kiro-sidecar-present0001) echo "$3" ;;
  kiro-sidecar-silent0001) ;;
  kiro-sidecar-error0001) echo "Error response from daemon: No such container: $3" >&2; exit 1 ;;
  *) echo "unexpected call: $*" >&2; exit 125 ;;
esac
`,
      { mode: 0o755 },
    );
    const fixture = await managerFixture(t, 'default', {
      env: testEnvironment({ PATH: `${bin}:${process.env['PATH'] ?? ''}` }),
    });
    const { manager, stateDir } = fixture;
    const own = await currentOwner();
    const stopLeftover = async (name: string) => {
      const launchId = await seedRun(t, stateDir, own, { state: 'exited', mode: 'docker', containerName: name });
      return manager.stop({ launchId });
    };

    const present = await stopLeftover('kiro-sidecar-present0001');
    assert.deepEqual(present.cleanedUp, ['container kiro-sidecar-present0001 removed']);
    assert.deepEqual(present.failures, []);

    for (const name of ['kiro-sidecar-silent0001', 'kiro-sidecar-error0001']) {
      const absent = await stopLeftover(name);
      assert.deepEqual(absent.cleanedUp, [`container ${name} was already gone`]);
      assert.deepEqual(absent.failures, []);
    }

    const unexpected = await stopLeftover('kiro-sidecar-other0001');
    assert.deepEqual(unexpected.cleanedUp, []);
    assert.equal(unexpected.failures.length, 1);
    assert.match(unexpected.failures[0] ?? '', /^container kiro-sidecar-other0001: .*exited with code 125/);
  });

  test('a leftover child that leads a process group is ended with every process of its group', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default', { controlLimits: { killGraceMs: 300 } });
    const { manager, stateDir } = fixture;
    const group = await startGroupLeader(t);
    const launchId = await seedRun(t, stateDir, await currentOwner(), {
      state: 'exited',
      child: { pid: group.leader.pid, startTime: group.leader.startTime },
    });

    const reply = await manager.stop({ launchId });

    assert.ok(reply.cleanedUp.includes(`process ${group.leader.pid} killed`), reply.cleanedUp.join('; '));
    for (const pid of [group.leader.pid, ...group.members]) {
      await waitFor(() => isGone(pid), `process ${pid} of the leftover group to end`, 5_000);
    }
  });
});

/** True when `pid` has ended: no such process, or a zombie nobody has reaped yet. */
async function isGone(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    return !isAlive(pid);
  }
}

const GROUP_LEADER_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  "const members = process.argv.slice(1).map((script) => spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'inherit', 'ignore'] }));",
  "process.stdout.write(`pids ${members.map((member) => member.pid).join(' ')}\\n`);",
  'setInterval(() => {}, 60_000);',
].join('\n');
const MEMBER_SCRIPT = "process.stdout.write('ready\\n'); setInterval(() => {}, 60_000);";
const STUBBORN_MEMBER_SCRIPT = `process.on('SIGTERM', () => {}); ${MEMBER_SCRIPT}`;

/**
 * Starts a process group leader, as a local Kiro is started, with two
 * processes in its group: one ends on SIGTERM, one ignores it. Resolves once
 * both members run.
 */
async function startGroupLeader(t: TestContext): Promise<{ leader: ProcessIdentity; members: number[] }> {
  const leader = spawn(process.execPath, ['-e', GROUP_LEADER_SCRIPT, MEMBER_SCRIPT, STUBBORN_MEMBER_SCRIPT], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const pid = leader.pid;
  assert.ok(pid !== undefined, 'the group leader started');
  let members: number[] = [];
  t.after(() => {
    leader.stdout.destroy();
    for (const target of [-pid, pid, ...members]) {
      try {
        process.kill(target, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });
  let output = '';
  leader.stdout.setEncoding('utf8');
  leader.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  await waitFor(() => /^pids [0-9]+ [0-9]+$/m.test(output) && output.split('ready\n').length === 3, 'the group members to run');
  members = (/^pids ([0-9]+) ([0-9]+)$/m.exec(output) ?? []).slice(1).map(Number);
  const identity = await processIdentity(pid);
  assert.ok(identity !== null, 'the group leader runs');
  return { leader: identity, members };
}

/** The abort reason of a call the client cancelled. */
const CLIENT_CANCELLED = new Error('client cancelled');

function isClientCancel(error: unknown): boolean {
  assert.equal(error, CLIENT_CANCELLED);
  return true;
}

describe('control calls the client cancelled', () => {
  test('a call cancelled before it starts takes no claim and sends nothing', PROCESS_TIMEOUT, async (t) => {
    const { fixture, launchId } = await runningSession(t, 'cancel-tool');
    const { manager, stateDir, workspace } = fixture;
    const claims = t.mock.method(TurnClaims.prototype, 'claim');
    const signal = AbortSignal.abort(CLIENT_CANCELLED);

    await assert.rejects(manager.cancel({ launchId }, { signal }), isClientCancel);
    await assert.rejects(manager.send({ launchId, text: 'next', interrupt: true }, { signal }), isClientCancel);
    await assert.rejects(manager.stop({ launchId, purge: true }, { signal }), isClientCancel);

    assert.equal(claims.mock.callCount(), 0);
    assert.equal(await exists(turnPaths(stateDir, launchId, 1).claimed), false);
    assert.deepEqual(await workspace.events(), [{ event: 'prompt', overlapped: false }]);
    assert.equal(manager.get(launchId)?.state, 'running');
    assert.equal(manager.get(launchId)?.currentTurn, 1);
    assert.equal(isAlive((await workspace.started()).pid), true);
    assert.equal(await exists(join(stateDir, 'runs', launchId)), true);
  });

  test('an interrupting send cancelled while it opens the next turn does not return the interrupted one', PROCESS_TIMEOUT, async (t) => {
    const { fixture, launchId } = await runningSession(t, 'cancel-tool');
    const { manager, stateDir } = fixture;
    const abort = new AbortController();
    const prompt = KiroAcpClient.prototype.prompt;
    t.mock.method(KiroAcpClient.prototype, 'prompt', function (this: KiroAcpClient, ...args: Parameters<KiroAcpClient['prompt']>) {
      abort.abort(CLIENT_CANCELLED);
      return prompt.apply(this, args);
    });

    await assert.rejects(
      manager.send({ launchId, text: 'next', interrupt: true }, { toolUseId: 'toolu_opened', signal: abort.signal }),
      isClientCancel,
    );

    assert.equal((await turnResultOf(stateDir, launchId, 1)).endedBy, 'interrupt');
    assert.equal(await exists(turnPaths(stateDir, launchId, 1).returned), false);
    assert.equal(await exists(turnPaths(stateDir, launchId, 1).claimed), false);
    assert.equal(manager.get(launchId)?.state, 'running');
    assert.equal(manager.get(launchId)?.currentTurn, 2);
    // Turn 2 is open, so its call record stays as it was written.
    const call = await readCall(stateDir, 'toolu_opened');
    assert.ok(call !== undefined && !('failed' in call), JSON.stringify(call));
    assert.equal(call.turn, 2);
  });
});

describe('cancel and stop on runs of others', () => {
  test('another live owner is E_OWNED; another home or no run is E_NOT_FOUND', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const { manager, stateDir } = fixture;
    const own = await currentOwner();
    const live = await liveIdentity(t);

    const otherLive = await seedRun(t, stateDir, live, { state: 'idle', driver: live });
    const otherHome = await seedRun(t, stateDir, live, { state: 'idle', home: 'elsewhere' });
    const ownDriven = await seedRun(t, stateDir, own, { state: 'idle', driver: live });
    for (const call of [manager.cancel.bind(manager), manager.stop.bind(manager)]) {
      await assert.rejects(call({ launchId: 'ks_0123456789ab' }), (error) => assertCode(error, 'E_NOT_FOUND'));
      await assert.rejects(call({ launchId: otherLive }), (error) => assertCode(error, 'E_OWNED', 'another Claude session'));
      await assert.rejects(call({ launchId: otherHome }), (error) => assertCode(error, 'E_NOT_FOUND'));
      await assert.rejects(call({ launchId: ownDriven }), (error) => assertCode(error, 'E_OWNED', 'another server process'));
    }
    assert.equal((await metaOf(stateDir, otherLive)).state, 'idle');
    assert.equal((await metaOf(stateDir, ownDriven)).state, 'idle');
  });

  test('another owner that is dead is E_OWNED too, and purge deletes nothing', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const { manager, stateDir } = fixture;
    const dead = await deadIdentity();

    const exited = await seedRun(t, stateDir, dead, { state: 'exited', currentTurn: 1 });
    await writeFile(turnPaths(stateDir, exited, 1).result, '{}');
    const lost = await seedRun(t, stateDir, dead, { state: 'running', currentTurn: 1 });
    for (const launchId of [exited, lost]) {
      const before = await metaOf(stateDir, launchId);
      await assert.rejects(manager.cancel({ launchId }), (error) => assertCode(error, 'E_OWNED', 'another Claude session'));
      await assert.rejects(manager.stop({ launchId }), (error) => assertCode(error, 'E_OWNED', 'another Claude session'));
      await assert.rejects(manager.stop({ launchId, purge: true }), (error) => assertCode(error, 'E_OWNED', 'another Claude session'));
      assert.equal(await exists(join(stateDir, 'runs', launchId)), true);
      assert.deepEqual(await metaOf(stateDir, launchId), before);
    }
    assert.equal(await exists(turnPaths(stateDir, exited, 1).result), true);
  });
});

/**
 * Holds a start with a prompt between its last configuration step and the
 * opening of its first turn: the first meta write after the configuration is
 * read back waits until `release` is called.
 */
function holdFirstTurn(t: TestContext): { held: Promise<void>; release: () => void } {
  let armed = false;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const configOptions = KiroAcpClient.prototype.configOptions;
  t.mock.method(KiroAcpClient.prototype, 'configOptions', function (this: KiroAcpClient, sessionId: string) {
    armed = true;
    return configOptions.call(this, sessionId);
  });
  const assertHeld = RunLock.prototype.assertHeld;
  t.mock.method(RunLock.prototype, 'assertHeld', async function (this: RunLock) {
    if (armed) {
      armed = false;
      reached();
      await gate;
    }
    return assertHeld.call(this);
  });
  return { held, release };
}

describe('a start with a prompt before its first turn is open', () => {
  test('cancel and send are E_BUSY and the session is still starting', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'cancel-tool');
    const { manager, stateDir } = fixture;
    const hold = holdFirstTurn(t);
    const starting = manager.start({ dir: fixture.workspace.dir, prompt: 'run a long tool' });
    await hold.held;
    const [launchId] = await readdir(join(stateDir, 'runs'));
    assert.ok(launchId !== undefined);

    await assert.rejects(manager.cancel({ launchId }), (error) => assertCode(error, 'E_BUSY', 'still starting'));
    await assert.rejects(manager.send({ launchId, text: 'next' }), (error) => assertCode(error, 'E_BUSY', 'still starting'));
    assert.equal(manager.get(launchId)?.state, 'starting');

    hold.release();
    const started = await starting;
    assert.equal(started.turn, 1);
    await waitFor(() => manager.get(launchId)?.runningTurn?.toolCalls === 1, 'the running tool');
    const reply = await manager.cancel({ launchId });
    assert.equal(reply.ended?.result.endedBy, 'cancel');
    await manager.stop({ launchId });
    await manager.settled();
    assert.deepEqual(fixture.errors, []);
  });

  test('stop during the last write of the start aborts it: no prompt is sent and the run ends failed', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'cancel-tool');
    const { manager, stateDir } = fixture;
    const hold = holdFirstTurn(t);
    const starting = manager.start({ dir: fixture.workspace.dir, prompt: 'run a long tool' });
    const startError = starting.then(
      () => undefined,
      (error: unknown) => error,
    );
    await hold.held;
    const [launchId] = await readdir(join(stateDir, 'runs'));
    assert.ok(launchId !== undefined);

    const stopping = manager.stop({ launchId });
    hold.release();
    const reply = await stopping;

    assertCode(await startError, 'E_STEP_PROMPT', 'the start was aborted');
    assert.equal(reply.state, 'failed');
    assert.equal(reply.ended, null);
    assert.ok(reply.cleanedUp.includes('start aborted'), JSON.stringify(reply.cleanedUp));
    assert.equal(await promptsReceived(fixture.workspace), 0);
    assert.equal(existsSync(turnPaths(stateDir, launchId, 1).result), false);
    const meta = await metaOf(stateDir, launchId);
    assert.equal(meta.state, 'failed');
    assert.equal(meta.currentTurn, 0);
    assert.equal(manager.get(launchId), undefined);
    await manager.settled();
    assert.deepEqual(fixture.errors, []);
  });
});
