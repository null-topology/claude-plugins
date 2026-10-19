import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createJsonOnce, readJsonIfExists, writeJsonAtomic } from '../../src/store/files.ts';
import { currentDriver } from '../../src/store/identity.ts';
import type { ProcessIdentity } from '../../src/store/identity.ts';
import { RunLock, acquireRunLock, breakMarker, readRunLock } from '../../src/store/lock.ts';
import { runPaths } from '../../src/store/paths.ts';
import { createRun } from '../../src/store/runs.ts';
import { deadIdentity, startIdleProcess, tempDir } from '../helpers/processes.ts';

const RACER = fileURLToPath(new URL('../fixtures/lock-racer.ts', import.meta.url));

/** Rounds of the multi-process race and contenders per round. */
const RACE_ROUNDS = 20;
const RACE_CONTENDERS = 8;

async function newRun(t: Parameters<typeof tempDir>[0]) {
  const stateDir = await tempDir(t);
  const { launchId, paths } = await createRun(stateDir);
  return { stateDir, launchId, paths };
}

/** Run directory entries other than the lock itself (markers, temp files). */
async function strayFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name !== 'lock' && name !== 'turns');
}

interface RaceOutcome {
  readonly pid: number;
  readonly acquired?: boolean;
  readonly reason?: string;
  readonly error?: string;
}

/**
 * Starts `count` processes, waits until each has warmed up, releases them at
 * once on the run's lock, and collects what each got. The processes stay
 * alive (a winner keeps holding) until every outcome is in.
 */
async function race(stateDir: string, launchId: string, count: number): Promise<RaceOutcome[]> {
  const contenders = Array.from({ length: count }, () => {
    const child = spawn(process.execPath, [RACER, stateDir, launchId], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const exited = once(child, 'exit');
    assert.ok(child.stdout !== null && child.stdin !== null);
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const next = async (): Promise<string> => {
      const { value, done } = await lines.next();
      assert.ok(done !== true, `contender ${child.pid} ended early`);
      return value as string;
    };
    return { child, exited, next };
  });
  try {
    for (const contender of contenders) {
      assert.equal(await contender.next(), 'ready');
    }
    for (const contender of contenders) {
      contender.child.stdin?.write('go\n');
    }
    const outcomes: RaceOutcome[] = [];
    for (const contender of contenders) {
      outcomes.push(JSON.parse(await contender.next()) as RaceOutcome);
    }
    return outcomes;
  } finally {
    for (const contender of contenders) {
      contender.child.stdin?.end();
    }
    for (const contender of contenders) {
      const timer = setTimeout(() => contender.child.kill('SIGKILL'), 5_000);
      await contender.exited;
      clearTimeout(timer);
    }
  }
}

describe('run lock', () => {
  test('a free lock is taken and names its holder', async (t) => {
    const { stateDir, launchId, paths } = await newRun(t);
    const attempt = await acquireRunLock(stateDir, launchId);
    assert.ok(attempt.acquired);
    const driver = await currentDriver();
    assert.deepEqual(attempt.lock.holder, driver);
    assert.deepEqual(await readJsonIfExists(paths.lock), {
      pid: driver.pid,
      startTime: driver.startTime,
      hostId: driver.hostId,
    });
    assert.deepEqual(await readRunLock(stateDir, launchId), driver);
    assert.equal((await stat(paths.lock)).mode & 0o777, 0o600);
    assert.deepEqual(await strayFiles(paths.dir), []);
  });

  test('release removes the lock and can be repeated', async (t) => {
    const { stateDir, launchId, paths } = await newRun(t);
    const attempt = await acquireRunLock(stateDir, launchId);
    assert.ok(attempt.acquired);
    await attempt.lock.release();
    await attempt.lock.release();
    assert.equal(attempt.lock.released, true);
    assert.equal(await readJsonIfExists(paths.lock), undefined);
    await assert.rejects(attempt.lock.assertHeld(), /released/);
    const again = await acquireRunLock(stateDir, launchId);
    assert.ok(again.acquired);
  });

  test('release leaves a lock that names another holder', async (t) => {
    const { stateDir, launchId, paths } = await newRun(t);
    const attempt = await acquireRunLock(stateDir, launchId);
    assert.ok(attempt.acquired);
    const other: ProcessIdentity = { ...attempt.lock.holder, startTime: 'another' };
    await writeJsonAtomic(paths.lock, other);
    await assert.rejects(attempt.lock.assertHeld(), /no longer held/);
    await attempt.lock.release();
    assert.deepEqual(await readRunLock(stateDir, launchId), other);
  });

  test('a second acquire is refused while the holder lives, and wins once it is dead', async (t) => {
    const { stateDir, launchId, paths } = await newRun(t);
    const holder = await startIdleProcess();
    try {
      const first = await acquireRunLock(stateDir, launchId, holder.identity);
      assert.ok(first.acquired);
      const second = await acquireRunLock(stateDir, launchId);
      assert.deepEqual(second, { acquired: false, reason: 'held', holder: holder.identity });
    } finally {
      await holder.stop();
    }
    const third = await acquireRunLock(stateDir, launchId);
    assert.ok(third.acquired);
    assert.deepEqual(await readRunLock(stateDir, launchId), await currentDriver());
    assert.deepEqual(await strayFiles(paths.dir), []);
  });

  test('the same process cannot take a lock it holds twice', async (t) => {
    const { stateDir, launchId } = await newRun(t);
    const first = await acquireRunLock(stateDir, launchId);
    assert.ok(first.acquired);
    const second = await acquireRunLock(stateDir, launchId);
    assert.deepEqual(second, { acquired: false, reason: 'held', holder: await currentDriver() });
  });

  test('a lock of another host is never broken', async (t) => {
    const { stateDir, launchId, paths } = await newRun(t);
    const remote: ProcessIdentity = { ...(await deadIdentity()), hostId: 'elsewhere:boot:1' };
    await writeJsonAtomic(paths.lock, remote);
    const attempt = await acquireRunLock(stateDir, launchId);
    assert.deepEqual(attempt, { acquired: false, reason: 'other-host', holder: remote });
    assert.deepEqual(await readRunLock(stateDir, launchId), remote);
  });

  test('a stale lock being taken over by a live process is refused', async (t) => {
    const { stateDir, launchId, paths } = await newRun(t);
    const dead = await deadIdentity();
    await writeJsonAtomic(paths.lock, dead);
    const breaker = await startIdleProcess();
    try {
      assert.ok(await createJsonOnce(breakMarker(paths.lock, dead), breaker.identity));
      const attempt = await acquireRunLock(stateDir, launchId);
      assert.deepEqual(attempt, { acquired: false, reason: 'taking-over', holder: breaker.identity });
      assert.deepEqual(await readRunLock(stateDir, launchId), dead);
    } finally {
      await breaker.stop();
    }
  });

  test('a take-over left unfinished by dead breakers is completed', async (t) => {
    const { stateDir, launchId, paths } = await newRun(t);
    const dead = await deadIdentity();
    const firstBreaker = await deadIdentity();
    const secondBreaker = await deadIdentity();
    await writeJsonAtomic(paths.lock, dead);
    assert.ok(await createJsonOnce(breakMarker(paths.lock, dead), firstBreaker));
    assert.ok(await createJsonOnce(breakMarker(paths.lock, firstBreaker), secondBreaker));
    const attempt = await acquireRunLock(stateDir, launchId);
    assert.ok(attempt.acquired);
    assert.deepEqual(await readRunLock(stateDir, launchId), await currentDriver());
    assert.deepEqual(await strayFiles(paths.dir), []);
  });

  test('a malformed lock file is reported, not broken', async (t) => {
    const { stateDir, launchId, paths } = await newRun(t);
    await writeJsonAtomic(paths.lock, { pid: 'x' });
    await assert.rejects(acquireRunLock(stateDir, launchId), /Malformed lock file/);
  });

  test('a RunLock cannot be made outside acquireRunLock', async () => {
    const holder = await currentDriver();
    const Construct = RunLock as unknown as new (...args: unknown[]) => RunLock;
    assert.throws(
      () => new Construct(Symbol('RunLock'), '/state', 'ks_0123456789ab', holder),
      /only from acquireRunLock/,
    );
  });

  test(
    `${RACE_CONTENDERS} processes on one stale lock: exactly one wins, ${RACE_ROUNDS} rounds`,
    { timeout: 180_000 },
    async (t) => {
      const stateDir = await tempDir(t);
      const reasons = new Map<string, number>();
      for (let round = 0; round < RACE_ROUNDS; round += 1) {
        const { launchId } = await createRun(stateDir);
        const paths = runPaths(stateDir, launchId);
        await writeJsonAtomic(paths.lock, await deadIdentity());

        const outcomes = await race(stateDir, launchId, RACE_CONTENDERS);
        assert.deepEqual(outcomes.filter((outcome) => outcome.error !== undefined), [], `round ${round}`);
        const winners = outcomes.filter((outcome) => outcome.acquired === true);
        assert.equal(winners.length, 1, `round ${round}: ${JSON.stringify(outcomes)}`);
        const [winner] = winners;
        assert.equal((await readRunLock(stateDir, launchId))?.pid, winner?.pid, `round ${round}`);
        for (const outcome of outcomes) {
          if (outcome.acquired === false) {
            assert.ok(outcome.reason === 'held' || outcome.reason === 'taking-over', outcome.reason);
            reasons.set(outcome.reason, (reasons.get(outcome.reason) ?? 0) + 1);
          }
        }
        assert.deepEqual(await strayFiles(paths.dir), [], `round ${round}`);
      }
      t.diagnostic(`refusals: ${JSON.stringify(Object.fromEntries(reasons))}`);
    },
  );
});
