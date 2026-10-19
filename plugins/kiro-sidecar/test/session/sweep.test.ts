import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { LABEL_LAUNCH, containerLabels } from '../../src/docker/launch.ts';
import { listHostContainers } from '../../src/docker/remove.ts';
import { SidecarError } from '../../src/errors.ts';
import { hooksLogPath, rotatedHooksLogPath } from '../../src/hooks/log.ts';
import { pollTurn } from '../../src/hooks/waiter-loop.ts';
import type { WaiterTurn } from '../../src/hooks/waiter-setup.ts';
import { isoSeconds } from '../../src/session/claims.ts';
import { SessionManager } from '../../src/session/manager.ts';
import type { ManagerDeps } from '../../src/session/manager.ts';
import { HOOKS_LOG_MAX_BYTES, sweepLogLines } from '../../src/session/sweep.ts';
import type { SweepReport, SweepRunReport } from '../../src/session/sweep.ts';
import { DEFAULTS } from '../../src/settings.ts';
import type { Settings } from '../../src/settings.ts';
import { ADOPTED_ERROR, LOST_ERROR, parseTurnResult } from '../../src/session/turn-result.ts';
import { currentDriver, currentOwner, ownerKey, processIdentity } from '../../src/store/identity.ts';
import type { ProcessIdentity } from '../../src/store/identity.ts';
import { acquireRunLock } from '../../src/store/lock.ts';
import { callPath, callsDir, newLaunchId, runPaths, turnPaths } from '../../src/store/paths.ts';
import { createRun, createTurnResult, writeMeta } from '../../src/store/runs.ts';
import type { RunMeta } from '../../src/store/runs.ts';
import { buildSecretSet } from '../../src/text/redact.ts';
import { SKIP_WITHOUT_IMAGE, TEST_CONTAINER_PREFIX, TEST_IMAGE, docker } from '../docker/live.ts';
import { deadIdentity, startIdleProcess, tempDir } from '../helpers/processes.ts';
import { OTHER_HOST_DRIVER, OWNER as OTHER_OWNER, sampleResult } from './helpers-runs.ts';
import { PROCESS_TIMEOUT, TEST_TOKEN, managerFixture, metaOf, testEnvironment, waitFor } from './manager-helpers.ts';
import type { ManagerFixture } from './manager-helpers.ts';

/** Recent, so a run seeded with it is never past retention. */
const OPENED_AT = isoSeconds(new Date());

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 10;

function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}

/** Sets the mtime of `path` to `ms` before now. */
async function age(path: string, ms: number): Promise<void> {
  const at = ago(ms);
  await utimes(path, at, at);
}

async function writeAged(path: string, text: string, ms: number): Promise<void> {
  await writeFile(path, text, 'utf8');
  await age(path, ms);
}

/** The owner key of the manager under test: this process's parent, as the manager resolves it by default. */
async function ownKey(): Promise<string> {
  return ownerKey(await currentOwner());
}

/**
 * A run left by a server whose driver identity is `driver`, written as that
 * server would have: it holds the run lock (naming the driver) and wrote
 * `meta.json` under it. A running turn by default.
 */
async function seedRun(
  stateDir: string,
  driver: ProcessIdentity,
  patch: Partial<RunMeta> = {},
  options: { readonly releaseLock?: boolean } = {},
): Promise<RunMeta> {
  const { launchId } = await createRun(stateDir);
  const attempt = await acquireRunLock(stateDir, launchId, driver);
  assert.ok(attempt.acquired, 'the seeded lock is taken');
  const meta: RunMeta = {
    launchId, kiroSessionId: 'sess_seeded', ownerKey: OTHER_OWNER, driver, home: 'default',
    projectDir: null, label: 'docs', mode: 'local', dir: '/tmp', dirReadOnly: false, mounts: [], skills: [], steering: [],
    model: null, effort: null, kiroMode: null, permissions: 'allow', preset: null, tokenSource: null, image: null,
    dockerUser: null, containerName: null, child: null, state: 'running', currentTurn: 1, firstPromptPreview: null,
    createdAt: OPENED_AT, updatedAt: OPENED_AT, ...patch,
  };
  await writeMeta(attempt.lock, meta);
  if (options.releaseLock === true) {
    await attempt.lock.release();
  }
  return meta;
}

/**
 * Two runs of `driver`: a running one whose lock it holds, and one that
 * ended, whose lock it released, with a claim of turn 1 still on disk.
 */
async function seedHeldAndEnded(stateDir: string, driver: ProcessIdentity, patch: Partial<RunMeta> = {}): Promise<RunMeta[]> {
  const running = await seedRun(stateDir, driver, { mode: 'docker', ...patch });
  const ended = await seedRun(stateDir, driver, { mode: 'docker', state: 'exited', ...patch }, { releaseLock: true });
  for (const meta of [running, ended]) {
    await writeClaimed(stateDir, meta.launchId, 1);
  }
  return [running, ended];
}

/** A label removal that records each launch id and removes nothing. */
function recordedRemovals(): { calls: string[]; dep: ManagerDeps['removeContainersByLabel'] } {
  const calls: string[] = [];
  return {
    calls,
    dep: async (launchId) => {
      calls.push(launchId);
      return [];
    },
  };
}

async function fixtureWithRemovals(
  t: TestContext,
  extra: Partial<ManagerDeps> = {},
  settings: Partial<Settings> = {},
): Promise<{ fixture: ManagerFixture; calls: string[] }> {
  const removals = recordedRemovals();
  const fixture = await managerFixture(t, 'harness', {
    owner: await currentOwner(),
    settings,
    deps: { removeContainersByLabel: removals.dep, removeContainer: async () => true, ...extra },
  });
  return { fixture, calls: removals.calls };
}

function runReport(report: SweepReport, launchId: string): SweepRunReport {
  const run = report.runs.find((entry) => entry.launchId === launchId);
  assert.ok(run !== undefined, `the sweep reports ${launchId}`);
  return run;
}

/**
 * Writes the claim marker of a turn. Without `holder` it is a marker written
 * before markers recorded their holder.
 */
async function writeClaimed(stateDir: string, launchId: string, turn: number, holder?: ProcessIdentity): Promise<string> {
  const path = turnPaths(stateDir, launchId, turn).claimed;
  await writeFile(path, JSON.stringify(holder === undefined ? { at: OPENED_AT } : { at: OPENED_AT, holder }), 'utf8');
  return path;
}

/** Every file of a run directory with its content. */
async function runFiles(stateDir: string, launchId: string): Promise<Map<string, string>> {
  const dir = runPaths(stateDir, launchId).dir;
  const files = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = `${entry.parentPath}/${entry.name}`;
      files.set(path, await readFile(path, 'utf8'));
    }
  }
  return files;
}

async function resultFiles(stateDir: string, launchId: string): Promise<string[]> {
  const names = await readdir(runPaths(stateDir, launchId).turns);
  return names.filter((name) => name.endsWith('.json')).sort();
}

async function storedResult(stateDir: string, launchId: string, turn: number) {
  const text = await readFile(turnPaths(stateDir, launchId, turn).result, 'utf8');
  return parseTurnResult(JSON.parse(text), launchId, turn);
}

describe('SessionManager.sweep: runs it leaves alone', () => {
  test('a run whose driver is alive keeps every file as it was', PROCESS_TIMEOUT, async (t) => {
    const { fixture, calls } = await fixtureWithRemovals(t);
    const otherServer = await startIdleProcess();
    t.after(() => otherServer.stop());
    const runs = await seedHeldAndEnded(fixture.stateDir, otherServer.identity, { ownerKey: await ownKey() });
    const before = await Promise.all(runs.map((meta) => runFiles(fixture.stateDir, meta.launchId)));

    const report = await fixture.manager.sweep();

    for (const [index, meta] of runs.entries()) {
      assert.deepEqual(await runFiles(fixture.stateDir, meta.launchId), before[index]);
    }
    for (const meta of runs) {
      assert.equal(runReport(report, meta.launchId).skipped, 'driver alive');
      assert.equal(runReport(report, meta.launchId).action, 'untouched');
    }
    assert.deepEqual(calls, [], 'no container removal');
  });

  test('a run of another host keeps every file as it was', PROCESS_TIMEOUT, async (t) => {
    const { fixture, calls } = await fixtureWithRemovals(t);
    const runs = await seedHeldAndEnded(fixture.stateDir, OTHER_HOST_DRIVER);
    const before = await Promise.all(runs.map((meta) => runFiles(fixture.stateDir, meta.launchId)));

    const report = await fixture.manager.sweep();

    for (const [index, meta] of runs.entries()) {
      assert.deepEqual(await runFiles(fixture.stateDir, meta.launchId), before[index]);
    }
    for (const meta of runs) {
      assert.equal(runReport(report, meta.launchId).skipped, 'driver other-host');
    }
    assert.deepEqual(calls, []);
  });
});

describe('SessionManager.sweep: runs of a dead driver', () => {
  test('an own run is adopted: one exited result, state exited, this server drives it', PROCESS_TIMEOUT, async (t) => {
    const { fixture, calls } = await fixtureWithRemovals(t);
    const { stateDir } = fixture;
    const meta = await seedRun(stateDir, await deadIdentity(), {
      ownerKey: await ownKey(), mode: 'docker', containerName: 'kiro-sidecar-0123456789ab', currentTurn: 2,
    });
    const first = sampleResult(meta, 1);
    assert.ok(await createTurnResult(stateDir, meta.launchId, 1, first));
    await writeFile(runPaths(stateDir, meta.launchId).stderrLog, 'agent started\nconnection reset\n', 'utf8');

    const report = await fixture.manager.sweep();

    const run = runReport(report, meta.launchId);
    assert.equal(run.action, 'adopted');
    assert.equal(run.resultCreated, 2);
    assert.deepEqual(calls, [meta.launchId], 'the containers of the run are removed by its label');
    assert.deepEqual(await resultFiles(stateDir, meta.launchId), ['1.json', '2.json']);
    assert.deepEqual(await storedResult(stateDir, meta.launchId, 1), first);
    const result = await storedResult(stateDir, meta.launchId, 2);
    assert.equal(result.outcome, 'exited');
    assert.equal(result.endedBy, null);
    assert.equal(result.error, ADOPTED_ERROR);
    assert.equal(result.startedAt, OPENED_AT);
    assert.equal(result.sessionId, 'sess_seeded');
    assert.equal(result.stderrTail, 'agent started\nconnection reset');
    const after = await metaOf(stateDir, meta.launchId);
    assert.equal(after.state, 'exited');
    assert.deepEqual(after.driver, await currentDriver());
    assert.equal(existsSync(runPaths(stateDir, meta.launchId).lock), false, 'the lock is released');
  });

  test("another owner's run is lost: one lost result, state lost, lock released", PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await fixtureWithRemovals(t);
    const { stateDir } = fixture;
    const dead = await deadIdentity();
    const meta = await seedRun(stateDir, dead, { ownerKey: OTHER_OWNER });

    const report = await fixture.manager.sweep();

    const run = runReport(report, meta.launchId);
    assert.equal(run.action, 'lost');
    assert.equal(run.resultCreated, 1);
    assert.deepEqual(await resultFiles(stateDir, meta.launchId), ['1.json']);
    const result = await storedResult(stateDir, meta.launchId, 1);
    assert.equal(result.outcome, 'lost');
    assert.equal(result.error, LOST_ERROR);
    assert.equal(result.stderrTail, null);
    const after = await metaOf(stateDir, meta.launchId);
    assert.equal(after.state, 'lost');
    assert.deepEqual(after.driver, dead, 'the driver of a lost run is not replaced');
    assert.equal(existsSync(runPaths(stateDir, meta.launchId).lock), false, 'the lock is released');
    const otherServer = await startIdleProcess();
    t.after(() => otherServer.stop());
    const attempt = await acquireRunLock(stateDir, meta.launchId, otherServer.identity);
    assert.ok(attempt.acquired, 'another server can take the run');
    await attempt.lock.release();
  });

  test('a result already present is never overwritten, for either kind', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await fixtureWithRemovals(t);
    const { stateDir } = fixture;
    const own = await seedRun(stateDir, await deadIdentity(), { ownerKey: await ownKey() });
    const other = await seedRun(stateDir, await deadIdentity(), { ownerKey: OTHER_OWNER });
    const texts = new Map<string, string>();
    for (const meta of [own, other]) {
      assert.ok(await createTurnResult(stateDir, meta.launchId, 1, sampleResult(meta, 1, { outcome: 'end_turn' })));
      texts.set(meta.launchId, await readFile(turnPaths(stateDir, meta.launchId, 1).result, 'utf8'));
    }

    const report = await fixture.manager.sweep();

    for (const meta of [own, other]) {
      assert.equal(runReport(report, meta.launchId).resultCreated, null);
      assert.equal(await readFile(turnPaths(stateDir, meta.launchId, 1).result, 'utf8'), texts.get(meta.launchId));
      assert.deepEqual(await resultFiles(stateDir, meta.launchId), ['1.json']);
    }
    assert.equal((await metaOf(stateDir, own.launchId)).state, 'exited');
    assert.equal((await metaOf(stateDir, other.launchId)).state, 'lost');
  });

  test('a run that already ended keeps its state', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await fixtureWithRemovals(t);
    const { stateDir } = fixture;
    const meta = await seedRun(stateDir, await deadIdentity(), { ownerKey: OTHER_OWNER, state: 'stopped' });
    const before = await metaOf(stateDir, meta.launchId);

    const report = await fixture.manager.sweep();

    assert.equal(runReport(report, meta.launchId).skipped, 'state stopped');
    assert.deepEqual(await metaOf(stateDir, meta.launchId), before);
    assert.deepEqual(await resultFiles(stateDir, meta.launchId), []);
  });

  test('an own completed run keeps its state and its result; it is never adopted', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await fixtureWithRemovals(t);
    const { stateDir } = fixture;
    const meta = await seedRun(stateDir, await deadIdentity(), { ownerKey: await ownKey(), state: 'completed' }, { releaseLock: true });
    const completion = { result: 'The task is done.', at: OPENED_AT };
    assert.ok(await createTurnResult(stateDir, meta.launchId, 1, sampleResult(meta, 1, { outcome: 'end_turn', completion })));
    const before = await runFiles(stateDir, meta.launchId);

    const report = await fixture.manager.sweep();

    assert.equal(runReport(report, meta.launchId).skipped, 'state completed');
    assert.deepEqual(await runFiles(stateDir, meta.launchId), before);
    assert.equal(fixture.manager.get(meta.launchId), undefined);
    assert.deepEqual((await storedResult(stateDir, meta.launchId, 1)).completion, completion);
  });
});

describe('SessionManager.sweep: a start of a dead driver', () => {
  test('without a Kiro session id it fails, for an own run and for another owner', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await fixtureWithRemovals(t);
    const { stateDir } = fixture;
    const dead = await deadIdentity();
    const own = await seedRun(stateDir, dead, { ownerKey: await ownKey(), state: 'starting', kiroSessionId: null, currentTurn: 0 });
    const other = await seedRun(stateDir, dead, { ownerKey: OTHER_OWNER, state: 'starting', kiroSessionId: null, currentTurn: 0 });

    const report = await fixture.manager.sweep();

    for (const meta of [own, other]) {
      assert.equal(runReport(report, meta.launchId).action, 'failed');
      assert.equal(runReport(report, meta.launchId).resultCreated, null);
      const after = await metaOf(stateDir, meta.launchId);
      assert.equal(after.state, 'failed');
      assert.deepEqual(after.driver, dead, 'a failed start is not adopted');
      assert.deepEqual(await resultFiles(stateDir, meta.launchId), []);
      assert.equal(existsSync(runPaths(stateDir, meta.launchId).lock), false, 'the lock is released');
    }
  });

  test('without a Kiro session id its open turn still gets one result', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await fixtureWithRemovals(t);
    const { stateDir } = fixture;
    const meta = await seedRun(stateDir, await deadIdentity(), {
      ownerKey: OTHER_OWNER, state: 'starting', kiroSessionId: null, currentTurn: 1,
    });

    const report = await fixture.manager.sweep();

    assert.equal(runReport(report, meta.launchId).action, 'failed');
    assert.equal(runReport(report, meta.launchId).resultCreated, 1);
    assert.equal((await storedResult(stateDir, meta.launchId, 1)).outcome, 'lost');
    assert.equal((await metaOf(stateDir, meta.launchId)).state, 'failed');
  });

  test('with a Kiro session id an own run is adopted and another owner\'s is lost', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await fixtureWithRemovals(t);
    const { stateDir } = fixture;
    const own = await seedRun(stateDir, await deadIdentity(), { ownerKey: await ownKey(), state: 'starting', currentTurn: 0 });
    const other = await seedRun(stateDir, await deadIdentity(), { ownerKey: OTHER_OWNER, state: 'starting', currentTurn: 0 });

    const report = await fixture.manager.sweep();

    assert.equal(runReport(report, own.launchId).action, 'adopted');
    assert.equal((await metaOf(stateDir, own.launchId)).state, 'exited');
    assert.deepEqual((await metaOf(stateDir, own.launchId)).driver, await currentDriver());
    assert.equal(runReport(report, other.launchId).action, 'lost');
    assert.equal((await metaOf(stateDir, other.launchId)).state, 'lost');
  });
});

describe('SessionManager.sweep: reaping a local child', () => {
  test('kills the recorded child when its pid and start time match', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await fixtureWithRemovals(t);
    const child = await startIdleProcess();
    t.after(() => child.stop());
    const meta = await seedRun(fixture.stateDir, await deadIdentity(), {
      child: { pid: child.identity.pid, startTime: child.identity.startTime },
    });

    const report = await fixture.manager.sweep();

    assert.equal(await processIdentity(child.identity.pid), null, 'the child is gone');
    assert.ok(runReport(report, meta.launchId).cleanedUp.includes(`process ${child.identity.pid} killed`));
  });

  test('leaves a process alive whose start time differs from the record', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await fixtureWithRemovals(t);
    const unrelated = await startIdleProcess();
    t.after(() => unrelated.stop());
    const meta = await seedRun(fixture.stateDir, await deadIdentity(), {
      child: { pid: unrelated.identity.pid, startTime: `${unrelated.identity.startTime}1` },
    });

    const report = await fixture.manager.sweep();

    assert.deepEqual(await processIdentity(unrelated.identity.pid), unrelated.identity, 'the process still runs');
    assert.equal(runReport(report, meta.launchId).action, 'lost');
    assert.deepEqual(runReport(report, meta.launchId).cleanedUp, []);
  });
});

/** Another server on the same state directory, for a second sweep. */
function nextManager(t: TestContext, stateDir: string, deps: Partial<ManagerDeps>): SessionManager {
  const manager = new SessionManager({
    settings: { ...DEFAULTS, api_key: TEST_TOKEN, default_mode: 'local' },
    stateDir,
    env: testEnvironment(),
    projectDir: null,
    onError: () => {},
    deps: { listHostContainers: async () => [], ...deps },
  });
  t.after(() => manager.shutdown());
  return manager;
}

/** A docker stand-in whose daemon does not answer: every command fails as the CLI does then. */
const DAEMON_DOWN_STUB = `#!/bin/sh
echo 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' >&2
exit 1
`;

describe('SessionManager.sweep: container removal', () => {
  test('a run whose containers could not be removed stays unsettled; the next sweep removes them and settles it', PROCESS_TIMEOUT, async (t) => {
    let failing = true;
    const removals: string[] = [];
    const removeContainersByLabel: ManagerDeps['removeContainersByLabel'] = async (launchId) => {
      removals.push(launchId);
      if (failing) {
        throw new SidecarError('E_DOCKER', 'docker ps exited with code 1: the daemon is not reachable');
      }
      return ['0123456789abcdef0123456789abcdef'];
    };
    const { fixture } = await fixtureWithRemovals(t, { removeContainersByLabel });
    const { stateDir } = fixture;
    const meta = await seedRun(stateDir, await deadIdentity(), { mode: 'docker' });

    const first = runReport(await fixture.manager.sweep(), meta.launchId);

    assert.equal(first.action, 'untouched');
    assert.equal(first.resultCreated, null);
    assert.equal(first.skipped, 'state running, not settled: its containers could not be removed');
    assert.equal(first.failures.length, 1);
    assert.match(first.failures[0] ?? '', /^containers: .*the daemon is not reachable/);
    assert.equal((await metaOf(stateDir, meta.launchId)).state, 'running');
    assert.deepEqual(await resultFiles(stateDir, meta.launchId), []);

    failing = false;
    const second = runReport(await nextManager(t, stateDir, { removeContainersByLabel }).sweep(), meta.launchId);

    assert.equal(second.action, 'lost');
    assert.equal(second.resultCreated, 1);
    assert.ok(second.cleanedUp.includes('container 0123456789ab removed'));
    assert.equal((await metaOf(stateDir, meta.launchId)).state, 'lost');
    assert.deepEqual(removals, [meta.launchId, meta.launchId]);
  });

  test('removes the containers of this host whose labelled driver is dead, whatever the run; keeps the others', PROCESS_TIMEOUT, async (t) => {
    const live = await startIdleProcess();
    t.after(() => live.stop());
    const dead = await deadIdentity();
    const ids = { gone: 'a'.repeat(64), alive: 'b'.repeat(64), unlabelled: 'c'.repeat(64), raced: 'd'.repeat(64) };
    const orphan = newLaunchId();
    const hostIds: string[] = [];
    const asked: string[][] = [];
    const { fixture } = await fixtureWithRemovals(t, {
      listHostContainers: async (hostId) => {
        hostIds.push(hostId);
        return [
          { id: ids.gone, launchId: orphan, driver: { pid: dead.pid, startTime: dead.startTime } },
          { id: ids.alive, launchId: null, driver: { pid: live.identity.pid, startTime: live.identity.startTime } },
          { id: ids.unlabelled, launchId: null, driver: null },
          { id: ids.raced, launchId: null, driver: { pid: dead.pid, startTime: dead.startTime } },
        ];
      },
      // The raced container was gone before docker got to it.
      removeContainersById: async (requested) => {
        asked.push([...requested]);
        return requested.filter((id) => id !== ids.raced);
      },
    });

    const report = await fixture.manager.sweep();

    assert.deepEqual(hostIds, [(await currentDriver()).hostId], 'the host id the labels carry');
    assert.deepEqual(asked, [[ids.gone, ids.raced]]);
    const removed = `container aaaaaaaaaaaa of ${orphan} removed: its driver is dead`;
    assert.deepEqual(report.containers, { cleanedUp: [removed], failures: [] });
    assert.ok(sweepLogLines(report).includes(`host containers: ${removed}`));
  });

  test('without a docker CLI on PATH the host containers pass reports nothing and the runs are still swept', PROCESS_TIMEOUT, async (t) => {
    const empty = await tempDir(t);
    const { fixture } = await fixtureWithRemovals(t, {
      listHostContainers: (hostId) => listHostContainers(hostId, { PATH: empty }),
    });
    const meta = await seedRun(fixture.stateDir, await deadIdentity());

    const report = await fixture.manager.sweep();

    assert.deepEqual(report.containers, { cleanedUp: [], failures: [] });
    assert.equal(sweepLogLines(report).some((line) => line.startsWith('host containers:')), false);
    assert.equal(runReport(report, meta.launchId).action, 'lost');
  });

  test('a docker daemon that does not answer is reported and the runs are still swept', PROCESS_TIMEOUT, async (t) => {
    const bin = await tempDir(t);
    await writeFile(join(bin, 'docker'), DAEMON_DOWN_STUB, { mode: 0o755 });
    const { fixture } = await fixtureWithRemovals(t, {
      listHostContainers: (hostId) => listHostContainers(hostId, { PATH: bin }),
    });
    const meta = await seedRun(fixture.stateDir, await deadIdentity());

    const report = await fixture.manager.sweep();

    assert.equal(report.containers.failures.length, 1);
    assert.match(
      report.containers.failures[0] ?? '',
      /^containers: docker ps --filter label=kiro-sidecar\.host=\S+ exited with code 1: Cannot connect to the Docker daemon/,
    );
    assert.ok(sweepLogLines(report).some((line) => line.startsWith('host containers: failed: containers: docker ps')));
    assert.equal(runReport(report, meta.launchId).action, 'lost');
  });
});

describe('SessionManager.sweep: stale claims', () => {
  test('removes the claim a dead server left, also on a run that ended', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await fixtureWithRemovals(t);
    const { stateDir } = fixture;
    const meta = await seedRun(stateDir, await deadIdentity(), { state: 'exited', currentTurn: 3 });
    assert.ok(await createTurnResult(stateDir, meta.launchId, 3, sampleResult(meta, 3, { outcome: 'exited' })));
    const claimed = await writeClaimed(stateDir, meta.launchId, 3);

    const report = await fixture.manager.sweep();

    assert.equal(existsSync(claimed), false, 'the stale claim is removed');
    assert.ok(runReport(report, meta.launchId).cleanedUp.includes('turns/3.claimed removed'));
    assert.equal((await metaOf(stateDir, meta.launchId)).state, 'exited');
  });

  test('keeps a claim whose recorded holder is alive or on another host; removes one whose holder is dead', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await fixtureWithRemovals(t);
    const { stateDir } = fixture;
    const holder = await startIdleProcess();
    t.after(() => holder.stop());
    const meta = await seedRun(stateDir, await deadIdentity(), { state: 'exited', currentTurn: 3 });
    const alive = await writeClaimed(stateDir, meta.launchId, 1, holder.identity);
    const elsewhere = await writeClaimed(stateDir, meta.launchId, 2, OTHER_HOST_DRIVER);
    const dead = await writeClaimed(stateDir, meta.launchId, 3, await deadIdentity());

    const report = await fixture.manager.sweep();

    assert.equal(existsSync(alive), true, 'the live holder keeps its claim');
    assert.equal(existsSync(elsewhere), true, 'a holder on another host keeps its claim');
    assert.equal(existsSync(dead), false, 'the dead holder\'s claim is removed');
    assert.deepEqual([...runReport(report, meta.launchId).cleanedUp].sort(), [
      'turns/1.claimed kept: holder alive',
      'turns/2.claimed kept: holder on another host',
      'turns/3.claimed removed',
    ]);
  });

  test('removes an empty or unparseable claim marker as one that records no holder', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await fixtureWithRemovals(t);
    const { stateDir } = fixture;
    const meta = await seedRun(stateDir, await deadIdentity(), { state: 'exited', currentTurn: 2 });
    const empty = turnPaths(stateDir, meta.launchId, 1).claimed;
    const broken = turnPaths(stateDir, meta.launchId, 2).claimed;
    await writeFile(empty, '');
    await writeFile(broken, '{"at":');

    const report = await fixture.manager.sweep();

    assert.equal(existsSync(empty), false);
    assert.equal(existsSync(broken), false);
    assert.deepEqual([...runReport(report, meta.launchId).cleanedUp].sort(), ['turns/1.claimed removed', 'turns/2.claimed removed']);
  });

  test('keeps a claim a call of this server holds', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await fixtureWithRemovals(t);
    const { stateDir } = fixture;
    const meta = await seedRun(stateDir, await deadIdentity(), { state: 'exited', currentTurn: 2 });
    const release = await fixture.manager.claim(meta.launchId, 2);
    t.after(() => release());

    await fixture.manager.sweep();

    assert.equal(existsSync(turnPaths(stateDir, meta.launchId, 2).claimed), true, 'the held claim stays');
  });
});

const CLAIM_HOLDER = fileURLToPath(new URL('../fixtures/claim-holder.ts', import.meta.url));

/** How long the other server's wait lasts; it returns the turn only at its end. */
const HOLDER_WAIT_S = 3;

/** A waiter clock that polls every 50 ms instead of every two seconds. */
const FAST_CLOCK = { now: () => Date.now(), sleep: (ms: number) => delay(Math.min(ms, 50)) };

interface ClaimHolder {
  /** The wait's result as the other server returned it; null when it printed nothing. */
  readonly result: Promise<unknown>;
  readonly kill: () => Promise<void>;
}

/** Another server process, waiting on turn 1 of `meta` as the run's owner. */
function startClaimHolder(t: TestContext, stateDir: string, meta: RunMeta): ClaimHolder {
  const child = spawn(
    process.execPath,
    [CLAIM_HOLDER, stateDir, meta.launchId, meta.ownerKey, meta.home, String(HOLDER_WAIT_S)],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  const exited = once(child, 'exit');
  const kill = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await exited;
  };
  t.after(kill);
  return {
    result: exited.then(() => (output.trim() === '' ? null : (JSON.parse(output) as unknown))),
    kill,
  };
}

/** The waiter's view of turn 1 of `meta`, as the reply's trailer named it. */
function waiterTurn(stateDir: string, meta: RunMeta): WaiterTurn {
  return {
    kind: 'turn', stateDir, launchId: meta.launchId, turn: 1, source: 'trailer', run: meta,
    sessionId: '3f1c9a7e-2b4d-4e6f-8a1b-5c7d9e0f2a4b', agentType: null, agentId: null, toolUseId: null,
  };
}

describe('SessionManager.sweep: a claim another server holds', () => {
  test('a claim of another live server survives the sweep, so only its wait returns the turn', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await fixtureWithRemovals(t);
    const { stateDir } = fixture;
    const driver = await startIdleProcess();
    t.after(() => driver.stop());
    const meta = await seedRun(stateDir, driver.identity);
    const paths = turnPaths(stateDir, meta.launchId, 1);
    const holder = startClaimHolder(t, stateDir, meta);
    await waitFor(() => existsSync(paths.claimed), 'the other server to claim turn 1');
    await driver.stop();

    const report = await fixture.manager.sweep();

    assert.equal(runReport(report, meta.launchId).resultCreated, 1, 'the sweep settles the dead driver\'s turn');
    const outcome = await pollTurn(waiterTurn(stateDir, meta), { deadlineMs: 20_000, clock: FAST_CLOCK, env: {} });
    const returned = (await holder.result) as { readonly state?: unknown } | null;
    assert.equal(returned?.state, 'finished', 'the other server\'s wait returned the turn');
    assert.equal(outcome.reason, 'returned', 'the waiter leaves the turn to the wait that returned it');
    assert.equal(existsSync(paths.pushed), false, 'the waiter delivered nothing');
    assert.ok(runReport(report, meta.launchId).cleanedUp.includes('turns/1.claimed kept: holder alive'));
  });

  test('a claim of a server that died is removed by the sweep, so the waiter pushes the turn', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await fixtureWithRemovals(t);
    const { stateDir } = fixture;
    const driver = await startIdleProcess();
    t.after(() => driver.stop());
    const meta = await seedRun(stateDir, driver.identity);
    const paths = turnPaths(stateDir, meta.launchId, 1);
    const holder = startClaimHolder(t, stateDir, meta);
    await waitFor(() => existsSync(paths.claimed), 'the other server to claim turn 1');
    await holder.kill();
    await driver.stop();

    const report = await fixture.manager.sweep();

    assert.ok(runReport(report, meta.launchId).cleanedUp.includes('turns/1.claimed removed'));
    assert.equal(existsSync(paths.claimed), false);
    const outcome = await pollTurn(waiterTurn(stateDir, meta), { deadlineMs: 20_000, clock: FAST_CLOCK, env: {} });
    assert.equal(outcome.reason, 'pushed');
    assert.equal(await holder.result, null, 'the killed server returned nothing');
  });
});

describe('SessionManager.sweep: calls during the sweep', () => {
  test('a stop of the run being swept answers E_BUSY; after the sweep it stops the adopted run', PROCESS_TIMEOUT, async (t) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const removing: string[] = [];
    const { fixture } = await fixtureWithRemovals(t, {
      removeContainersByLabel: async (launchId) => {
        removing.push(launchId);
        await gate;
        return [];
      },
    });
    const { stateDir, manager } = fixture;
    const meta = await seedRun(stateDir, await deadIdentity(), { ownerKey: await ownKey(), mode: 'docker', state: 'idle' });
    assert.ok(await createTurnResult(stateDir, meta.launchId, 1, sampleResult(meta, 1)));

    const sweeping = manager.sweep();
    await waitFor(() => removing.length === 1, 'the sweep to reach the run');
    await assert.rejects(
      manager.stop({ launchId: meta.launchId }),
      (error: unknown) => error instanceof SidecarError && error.code === 'E_BUSY',
    );
    release();
    const report = await sweeping;

    assert.equal(runReport(report, meta.launchId).action, 'adopted');
    assert.equal((await metaOf(stateDir, meta.launchId)).state, 'exited');
    const stopped = await manager.stop({ launchId: meta.launchId });
    assert.equal(stopped.state, 'stopped');
  });
});

/** A manager whose `retention_days` is `RETENTION_DAYS`. */
function retentionFixture(t: TestContext): Promise<{ fixture: ManagerFixture; calls: string[] }> {
  return fixtureWithRemovals(t, {}, { retention_days: RETENTION_DAYS });
}

const PAST_RETENTION = (RETENTION_DAYS + 1) * DAY_MS;
const WITHIN_RETENTION = (RETENTION_DAYS - 1) * DAY_MS;

describe('SessionManager.sweep: retention of runs', () => {
  test('an ended run past retention is deleted, a younger one and one settled now are kept', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await retentionFixture(t);
    const { stateDir } = fixture;
    const dead = await deadIdentity();
    const old = await seedRun(stateDir, dead, { state: 'exited', updatedAt: isoSeconds(ago(PAST_RETENTION)) }, { releaseLock: true });
    const young = await seedRun(stateDir, dead, { state: 'stopped', updatedAt: isoSeconds(ago(WITHIN_RETENTION)) }, { releaseLock: true });
    const settled = await seedRun(stateDir, dead, { state: 'running', updatedAt: isoSeconds(ago(PAST_RETENTION)) });

    const report = await fixture.manager.sweep();

    assert.equal(runReport(report, old.launchId).action, 'deleted');
    assert.equal(existsSync(runPaths(stateDir, old.launchId).dir), false, 'the old run directory is gone');
    assert.ok(sweepLogLines(report).includes(`${old.launchId}: past retention, run directory deleted`));
    assert.equal(runReport(report, young.launchId).skipped, 'state stopped');
    assert.equal((await metaOf(stateDir, young.launchId)).state, 'stopped');
    assert.equal(runReport(report, settled.launchId).action, 'lost');
    assert.equal((await metaOf(stateDir, settled.launchId)).state, 'lost', 'a run settled now has a fresh updatedAt');
  });

  test('an ended run past retention whose driver is alive keeps every file', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await retentionFixture(t);
    const otherServer = await startIdleProcess();
    t.after(() => otherServer.stop());
    const meta = await seedRun(
      fixture.stateDir, otherServer.identity, { state: 'exited', updatedAt: isoSeconds(ago(PAST_RETENTION)) }, { releaseLock: true },
    );
    const before = await runFiles(fixture.stateDir, meta.launchId);

    const report = await fixture.manager.sweep();

    assert.equal(runReport(report, meta.launchId).skipped, 'driver alive');
    assert.deepEqual(await runFiles(fixture.stateDir, meta.launchId), before);
  });

  test('an ended run past retention is kept while a call of this server holds a claim on it', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await retentionFixture(t);
    const { stateDir } = fixture;
    const meta = await seedRun(
      stateDir, await deadIdentity(), { state: 'exited', currentTurn: 2, updatedAt: isoSeconds(ago(PAST_RETENTION)) }, { releaseLock: true },
    );
    const release = await fixture.manager.claim(meta.launchId, 2);
    t.after(() => release());

    const report = await fixture.manager.sweep();

    assert.equal(runReport(report, meta.launchId).action, 'untouched');
    assert.equal(runReport(report, meta.launchId).skipped, 'state exited, past retention, kept while a call holds turn 2');
    assert.equal(existsSync(turnPaths(stateDir, meta.launchId, 2).claimed), true);
  });

  test('an ended run past retention is kept while another live server holds a claim on it', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await retentionFixture(t);
    const { stateDir } = fixture;
    const holder = await startIdleProcess();
    t.after(() => holder.stop());
    const meta = await seedRun(
      stateDir, await deadIdentity(), { state: 'exited', currentTurn: 2, updatedAt: isoSeconds(ago(PAST_RETENTION)) }, { releaseLock: true },
    );
    await writeClaimed(stateDir, meta.launchId, 2, holder.identity);

    const report = await fixture.manager.sweep();

    assert.equal(runReport(report, meta.launchId).action, 'untouched');
    assert.equal(runReport(report, meta.launchId).skipped, 'state exited, past retention, kept while a call holds turn 2');
    assert.deepEqual(runReport(report, meta.launchId).cleanedUp, ['turns/2.claimed kept: holder alive']);
    assert.equal(existsSync(turnPaths(stateDir, meta.launchId, 2).claimed), true);
  });

  test('homes/ is never cleaned, also for the home of a deleted run', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await retentionFixture(t);
    const { stateDir } = fixture;
    const home = join(stateDir, 'homes', 'default');
    await mkdir(join(home, 'skills'), { recursive: true });
    const files = [join(home, 'settings.json'), join(home, 'skills', 'notes.md'), join(home, '.settings.json.0123456789ab.tmp')];
    for (const path of files) {
      await writeAged(path, 'kept\n', PAST_RETENTION);
    }
    const meta = await seedRun(
      stateDir, await deadIdentity(), { state: 'exited', home: 'default', updatedAt: isoSeconds(ago(PAST_RETENTION)) }, { releaseLock: true },
    );
    // A run that is kept, so the sweep also cleans inside a run of that home.
    const kept = await seedRun(stateDir, await deadIdentity(), { state: 'exited', home: 'default' }, { releaseLock: true });

    const report = await fixture.manager.sweep();

    assert.equal(runReport(report, meta.launchId).action, 'deleted');
    assert.equal(runReport(report, kept.launchId).skipped, 'state exited');
    for (const path of files) {
      assert.equal(await readFile(path, 'utf8'), 'kept\n', `${path} stays`);
    }
  });
});

describe('SessionManager.sweep: retention outside the runs', () => {
  test('call records past retention are deleted, younger ones and other names kept', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await retentionFixture(t);
    const { stateDir } = fixture;
    await mkdir(callsDir(stateDir), { recursive: true });
    const record = { launchId: 'ks_0123456789ab', turn: 1, driver: await deadIdentity() };
    const old = callPath(stateDir, 'toolu_old_01');
    const young = callPath(stateDir, 'toolu_young_01');
    const fresh = callPath(stateDir, 'toolu_fresh_01');
    const other = join(callsDir(stateDir), 'notes.txt');
    await writeAged(old, JSON.stringify(record), PAST_RETENTION);
    await writeAged(young, JSON.stringify(record), RETENTION_DAYS * DAY_MS - 60 * 60 * 1000);
    await writeFile(fresh, JSON.stringify(record), 'utf8');
    await writeAged(other, 'kept\n', PAST_RETENTION);

    const report = await fixture.manager.sweep();

    assert.equal(existsSync(old), false, 'the old record is deleted');
    for (const path of [young, fresh, other]) {
      assert.equal(existsSync(path), true, `${path} stays`);
    }
    assert.deepEqual(report.state.cleanedUp, [`calls: 1 records older than ${RETENTION_DAYS} days removed`]);
    assert.ok(sweepLogLines(report).includes(`state directory: calls: 1 records older than ${RETENTION_DAYS} days removed`));
  });

  test('call records past retention whose driver is on another host are kept; ones without a driver go by age', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await retentionFixture(t);
    const { stateDir } = fixture;
    await mkdir(callsDir(stateDir), { recursive: true });
    const foreign = callPath(stateDir, 'toolu_foreign_01');
    const local = callPath(stateDir, 'toolu_local_01');
    const failed = callPath(stateDir, 'toolu_failed_01');
    const broken = callPath(stateDir, 'toolu_broken_01');
    await writeAged(foreign, JSON.stringify({ launchId: 'ks_0123456789ab', turn: 1, driver: OTHER_HOST_DRIVER }), PAST_RETENTION);
    await writeAged(local, JSON.stringify({ launchId: 'ks_0123456789ab', turn: 1, driver: await currentDriver() }), PAST_RETENTION);
    await writeAged(failed, JSON.stringify({ failed: true, error: 'the turn could not be opened' }), PAST_RETENTION);
    await writeAged(broken, '{"launchId":', PAST_RETENTION);

    const report = await fixture.manager.sweep();

    assert.equal(existsSync(foreign), true, 'the other host\'s record stays');
    for (const path of [local, failed, broken]) {
      assert.equal(existsSync(path), false, `${path} is deleted`);
    }
    assert.deepEqual(report.state.cleanedUp, [
      `calls: 3 records older than ${RETENTION_DAYS} days removed`,
      `calls: 1 records older than ${RETENTION_DAYS} days kept: their driver is on another host`,
    ]);
  });

  test('hooks.log larger than the cap is rotated to hooks.log.1', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await retentionFixture(t);
    const { stateDir } = fixture;
    const text = 'x'.repeat(HOOKS_LOG_MAX_BYTES + 1);
    await writeFile(hooksLogPath(stateDir), text, 'utf8');
    await writeFile(rotatedHooksLogPath(stateDir), 'previous generation\n', 'utf8');

    const report = await fixture.manager.sweep();

    assert.equal(existsSync(hooksLogPath(stateDir)), false);
    assert.equal(await readFile(rotatedHooksLogPath(stateDir), 'utf8'), text, 'the log replaced the previous generation');
    assert.deepEqual(report.state.cleanedUp, ['hooks.log rotated to hooks.log.1']);
  });

  test('hooks.log past retention is rotated and deleted; an old hooks.log.1 is deleted', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await retentionFixture(t);
    const { stateDir } = fixture;
    await writeAged(hooksLogPath(stateDir), '{"at":"old"}\n', PAST_RETENTION);

    const first = await fixture.manager.sweep();

    assert.equal(existsSync(hooksLogPath(stateDir)), false);
    assert.equal(existsSync(rotatedHooksLogPath(stateDir)), false);
    assert.deepEqual(first.state.cleanedUp, ['hooks.log rotated to hooks.log.1', 'hooks.log.1 removed']);
  });

  test('an old hooks.log.1 alone is deleted', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await retentionFixture(t);
    const { stateDir } = fixture;
    await writeAged(rotatedHooksLogPath(stateDir), '{"at":"old"}\n', PAST_RETENTION);

    const report = await fixture.manager.sweep();

    assert.equal(existsSync(rotatedHooksLogPath(stateDir)), false);
    assert.deepEqual(report.state.cleanedUp, ['hooks.log.1 removed']);
  });

  test('a small hooks.log and a hooks.log.1 within retention stay as they are', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await retentionFixture(t);
    const { stateDir } = fixture;
    await writeAged(hooksLogPath(stateDir), 'current\n', WITHIN_RETENTION);
    await writeAged(rotatedHooksLogPath(stateDir), 'previous\n', WITHIN_RETENTION);

    const report = await fixture.manager.sweep();

    assert.equal(await readFile(hooksLogPath(stateDir), 'utf8'), 'current\n');
    assert.equal(await readFile(rotatedHooksLogPath(stateDir), 'utf8'), 'previous\n');
    assert.deepEqual(report.state.cleanedUp, []);
  });
});

describe('SessionManager.sweep: stale temp files', () => {
  const STALE = 2 * DAY_MS;
  const FRESH = 23 * 60 * 60 * 1000;

  test('deletes temp files a day old in a dead run and in calls/, keeps fresh ones and other names', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await retentionFixture(t);
    const { stateDir } = fixture;
    const meta = await seedRun(stateDir, await deadIdentity(), { state: 'exited' }, { releaseLock: true });
    const { dir, turns } = runPaths(stateDir, meta.launchId);
    await mkdir(callsDir(stateDir), { recursive: true });
    const stale = [
      join(dir, '.meta.json.0123456789ab.tmp'),
      join(turns, '.1.json.abcdef012345.tmp'),
      join(callsDir(stateDir), '.toolu_old_02.json.00112233aabb.tmp'),
    ];
    const kept = [
      join(dir, '.meta.json.fedcba987654.tmp'),
      join(callsDir(stateDir), '.toolu_new_02.json.445566778899.tmp'),
    ];
    for (const path of stale) {
      await writeAged(path, '{}\n', STALE);
    }
    // On a case-insensitive file system (the macOS default) the upper-case
    // name is the stale file itself.
    const upper = join(dir, '.meta.json.0123456789AB.tmp');
    const others = [join(dir, '.meta.json.tmp'), join(turns, 'notes.tmp'), ...(existsSync(upper) ? [] : [upper])];
    for (const path of others) {
      await writeAged(path, '{}\n', STALE);
    }
    for (const path of kept) {
      await writeAged(path, '{}\n', FRESH);
    }

    const report = await fixture.manager.sweep();

    for (const path of stale) {
      assert.equal(existsSync(path), false, `${path} is deleted`);
    }
    for (const path of [...kept, ...others]) {
      assert.equal(existsSync(path), true, `${path} stays`);
    }
    assert.deepEqual(runReport(report, meta.launchId).cleanedUp, [
      '.meta.json.0123456789ab.tmp removed', 'turns/.1.json.abcdef012345.tmp removed',
    ]);
    assert.deepEqual(report.state.cleanedUp, ['calls: 1 stale temp files removed']);
  });
});

describe('SessionManager.sweep: containers (live docker)', { skip: SKIP_WITHOUT_IMAGE }, () => {
  test('the host pass removes a dead driver\'s container under an ended run and keeps a live driver\'s and another host\'s', { timeout: 120_000 }, async (t) => {
    // Host ids of this test only, so no other container of the box is listed.
    const host = `test-host-${randomBytes(6).toString('hex')}`;
    const otherHost = `test-host-${randomBytes(6).toString('hex')}`;
    const fixture = await managerFixture(t, 'harness', {
      owner: await currentOwner(),
      env: testEnvironment({ DOCKER_HOST: process.env['DOCKER_HOST'] }),
      deps: { listHostContainers: (_hostId, env) => listHostContainers(host, env) },
    });
    const dead = await deadIdentity();
    const live = await startIdleProcess();
    t.after(() => live.stop());
    const meta = await seedRun(fixture.stateDir, dead, { mode: 'docker', state: 'exited' }, { releaseLock: true });
    const names: string[] = [];
    t.after(async () => {
      if (names.length > 0) {
        await docker(['rm', '-f', ...names]);
      }
    });
    const startLabelled = async (launchId: string, driver: ProcessIdentity): Promise<{ name: string; id: string }> => {
      const name = `${TEST_CONTAINER_PREFIX}${randomBytes(6).toString('hex')}`;
      names.push(name);
      const labels = containerLabels(launchId, { ownerKey: OTHER_OWNER, driver }, buildSecretSet({ env: {} }));
      const run = await docker([
        'run', '-d', '--name', name,
        ...labels.flatMap(([key, value]) => ['--label', `${key}=${value}`]),
        '--entrypoint', 'sh', TEST_IMAGE, '-c', 'sleep 600',
      ]);
      assert.equal(run.code, 0, run.stderr);
      return { name, id: run.stdout.trim() };
    };
    const gone = await startLabelled(meta.launchId, { ...dead, hostId: host });
    const alive = await startLabelled(newLaunchId(), { ...live.identity, hostId: host });
    const elsewhere = await startLabelled(newLaunchId(), { ...dead, hostId: otherHost });
    const exists = async (name: string): Promise<boolean> =>
      (await docker(['ps', '--all', '--quiet', '--filter', `name=^${name}$`])).stdout.trim() !== '';

    const report = await fixture.manager.sweep();

    assert.deepEqual(report.containers, {
      cleanedUp: [`container ${gone.id.slice(0, 12)} of ${meta.launchId} removed: its driver is dead`],
      failures: [],
    });
    assert.equal(await exists(gone.name), false, 'the dead driver\'s container is removed');
    assert.equal(await exists(alive.name), true, 'the live driver\'s container stays');
    assert.equal(await exists(elsewhere.name), true, 'the other host\'s container stays');
    assert.equal(runReport(report, meta.launchId).skipped, 'state exited');
  });

  test('removes the containers labelled with the run and no other', { timeout: 120_000 }, async (t) => {
    const fixture = await managerFixture(t, 'harness', {
      owner: await currentOwner(),
      env: testEnvironment({ DOCKER_HOST: process.env['DOCKER_HOST'] }),
    });
    const dead = await deadIdentity();
    const meta = await seedRun(fixture.stateDir, dead, { mode: 'docker' });
    const neighbour = newLaunchId();
    const names: string[] = [];
    t.after(async () => {
      if (names.length > 0) {
        await docker(['rm', '-f', ...names]);
      }
    });
    for (const launchId of [meta.launchId, neighbour]) {
      const name = `${TEST_CONTAINER_PREFIX}${randomBytes(6).toString('hex')}`;
      names.push(name);
      const labels = containerLabels(launchId, { ownerKey: OTHER_OWNER, driver: dead }, buildSecretSet({ env: {} }));
      const run = await docker([
        'run', '-d', '--name', name,
        ...labels.flatMap(([key, value]) => ['--label', `${key}=${value}`]),
        '--entrypoint', 'sh', TEST_IMAGE, '-c', 'sleep 600',
      ]);
      assert.equal(run.code, 0, run.stderr);
    }
    const listed = async (launchId: string) =>
      (await docker(['ps', '--all', '--quiet', '--filter', `label=${LABEL_LAUNCH}=${launchId}`])).stdout.trim();
    assert.notEqual(await listed(meta.launchId), '');

    const report = await fixture.manager.sweep();

    assert.deepEqual(runReport(report, meta.launchId).failures, []);
    assert.equal(await listed(meta.launchId), '', 'the run container is removed');
    assert.notEqual(await listed(neighbour), '', 'a container of another run stays');
    assert.equal((await metaOf(fixture.stateDir, meta.launchId)).state, 'lost');
  });
});
