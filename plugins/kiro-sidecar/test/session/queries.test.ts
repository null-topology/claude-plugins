import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { utimes, writeFile } from 'node:fs/promises';
import { SidecarError } from '../../src/errors.ts';
import { writeJsonAtomic } from '../../src/store/files.ts';
import { currentDriver, ownerKey } from '../../src/store/identity.ts';
import { runPaths, turnPaths } from '../../src/store/paths.ts';
import type { RunMeta } from '../../src/store/runs.ts';
import {
  WAIT_TIMEOUT_DEFAULT_S,
  listSessions,
  sessionStatus,
  waitTurn,
} from '../../src/session/queries.ts';
import type { FinishedTurn, TurnCounters, WaitResult } from '../../src/session/queries.ts';
import { InvalidInputError } from '../../src/text/errors.ts';
import { PAGE_LIMIT_DEFAULT } from '../../src/text/limits.ts';
import { deadIdentity, startIdleProcess, tempDir } from '../helpers/processes.ts';
import {
  OTHER_HOST_DRIVER,
  liveSession,
  makeDeps,
  sampleResult,
  sleep,
  writeRun,
  writeTurn,
} from './helpers-runs.ts';

function isCode(code: string, field?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof SidecarError || error instanceof InvalidInputError, String(error));
    assert.equal(error.code, code, error.message);
    if (field !== undefined) {
      assert.equal((error as InvalidInputError).field, field, error.message);
    }
    return true;
  };
}

function finished(result: WaitResult): FinishedTurn {
  assert.equal(result.state, 'finished');
  return result as FinishedTurn;
}

function files(stateDir: string, meta: RunMeta, turn: number) {
  const paths = turnPaths(stateDir, meta.launchId, turn);
  return {
    claimed: () => existsSync(paths.claimed),
    returned: () => existsSync(paths.returned),
    paths,
  };
}

/** Tracks whether a promise has settled. */
function track<T>(promise: Promise<T>): { readonly settled: () => boolean } {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { settled: () => settled };
}

async function runningOwnRun(
  stateDir: string,
  registry: ReturnType<typeof makeDeps>['registry'],
  startedAt = new Date().toISOString(),
): Promise<RunMeta> {
  const meta = await writeRun(stateDir, { state: 'running', currentTurn: 1 });
  registry.put(
    liveSession(meta.launchId, {
      state: 'running',
      currentTurn: 1,
      runningTurn: { turn: 1, startedAt, toolCalls: 3, lastTool: 'run_command: npm test' },
    }),
  );
  return meta;
}

describe('wait on a finished turn', () => {
  test('returns the result, a page of the text, nextOffset and the trailer', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, log } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, { currentTurn: 1 });
    const text = 'abcd\u{1F600}efgh';
    const written = await writeTurn(stateDir, meta, 1, text);
    const first = finished(await waitTurn(deps, { session: meta.launchId, limit: 5 }));
    assert.deepEqual(first.result, written);
    assert.equal(first.text, 'abcd');
    assert.equal(first.offset, 0);
    assert.equal(first.nextOffset, 4);
    assert.equal(first.totalChars, 10);
    assert.equal(first.trailer, `kiro-result: ${meta.launchId}#1`);
    assert.equal(first.sessionId, meta.kiroSessionId);
    assert.equal(first.relation, 'own');
    const second = finished(await waitTurn(deps, { session: meta.launchId, offset: 4, limit: 5 }));
    assert.equal(second.text, '\u{1F600}efg');
    assert.equal(second.nextOffset, 9);
    const last = finished(await waitTurn(deps, { session: meta.launchId, offset: 9, limit: 5 }));
    assert.equal(last.text, 'h');
    assert.equal(last.nextOffset, null);
    assert.equal(first.text + second.text + last.text, text);
    const inside = finished(await waitTurn(deps, { session: meta.launchId, offset: 5, limit: 5 }));
    assert.equal(inside.offset, 4);
    const turn = files(stateDir, meta, 1);
    assert.ok(turn.returned());
    assert.ok(!turn.claimed());
    assert.equal(log.claims.length, 0);
  });

  test('defaults to the latest turn, offset 0 and a page of 20000 characters', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, { currentTurn: 2 });
    await writeTurn(stateDir, meta, 1, 'first');
    await writeTurn(stateDir, meta, 2, 'x'.repeat(25_000));
    const latest = finished(await waitTurn(deps, { session: meta.launchId }));
    assert.equal(latest.turn, 2);
    assert.equal(latest.offset, 0);
    assert.equal(latest.text.length, PAGE_LIMIT_DEFAULT);
    assert.equal(latest.nextOffset, PAGE_LIMIT_DEFAULT);
    const earlier = finished(await waitTurn(deps, { session: meta.launchId, turn: 1 }));
    assert.equal(earlier.text, 'first');
    assert.equal(earlier.trailer, `kiro-result: ${meta.launchId}#1`);
  });

  test('an offset past the end is E_INVALID and marks nothing returned', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, { currentTurn: 1 });
    await writeTurn(stateDir, meta, 1, 'short');
    await assert.rejects(
      waitTurn(deps, { session: meta.launchId, offset: 6 }),
      isCode('E_INVALID', 'offset'),
    );
    assert.ok(!files(stateDir, meta, 1).returned());
  });

  test('a turn without .md is read from .md.part, else as empty text', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, { currentTurn: 2, state: 'stopped' });
    await writeTurn(stateDir, meta, 1, null, { outcome: 'lost' });
    await writeFile(files(stateDir, meta, 1).paths.partial, 'partial text', 'utf8');
    await writeTurn(stateDir, meta, 2, null, { outcome: 'lost' });
    const partial = finished(await waitTurn(deps, { session: meta.launchId, turn: 1 }));
    assert.equal(partial.text, 'partial text');
    const empty = finished(await waitTurn(deps, { session: meta.launchId, turn: 2 }));
    assert.equal(empty.text, '');
    assert.equal(empty.nextOffset, null);
    await assert.rejects(
      waitTurn(deps, { session: meta.launchId, turn: 2, offset: 1 }),
      isCode('E_INVALID', 'offset'),
    );
  });

  test('an invalid result file is E_INTERNAL, not trusted', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, { currentTurn: 3, state: 'stopped' });
    const paths = (turn: number) => turnPaths(stateDir, meta.launchId, turn);
    await writeFile(paths(1).result, JSON.stringify({ launchId: meta.launchId, turn: 1 }), 'utf8');
    await writeFile(paths(2).result, '{"launchId":', 'utf8');
    await writeJsonAtomic(paths(3).result, sampleResult(meta, 2));
    for (const turn of [1, 2, 3]) {
      await assert.rejects(waitTurn(deps, { session: meta.launchId, turn }), (error: unknown) => {
        isCode('E_INTERNAL')(error);
        assert.match((error as Error).message, new RegExp(`turns/${turn}\\.json`));
        return true;
      });
      assert.ok(!files(stateDir, meta, turn).returned());
    }
  });

  test('a turn without a result in a session that is not running it is E_NOT_FOUND', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, log } = makeDeps(stateDir);
    const stopped = await writeRun(stateDir, { currentTurn: 1, state: 'stopped' });
    await assert.rejects(waitTurn(deps, { session: stopped.launchId }), isCode('E_NOT_FOUND'));
    const lost = await writeRun(stateDir, {
      currentTurn: 1,
      state: 'running',
      driver: await deadIdentity(),
    });
    await assert.rejects(waitTurn(deps, { session: lost.launchId }), (error: unknown) => {
      isCode('E_NOT_FOUND')(error);
      assert.match((error as Error).message, /lost/);
      return true;
    });
    assert.equal(log.claims.length, 0);
  });
});

describe('wait on a running own turn', () => {
  test('holds the claim while it blocks and returns the result when the turn ends', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, registry, log } = makeDeps(stateDir);
    const meta = await runningOwnRun(stateDir, registry);
    const turn = files(stateDir, meta, 1);
    const pending = waitTurn(deps, { session: meta.launchId });
    const state = track(pending);
    await sleep(80);
    assert.ok(turn.claimed(), 'the claim is held while the call blocks');
    assert.ok(!state.settled());
    await writeTurn(stateDir, meta, 1, 'All done.');
    const result = finished(await pending);
    assert.equal(result.text, 'All done.');
    assert.equal(result.trailer, `kiro-result: ${meta.launchId}#1`);
    assert.ok(!turn.claimed(), 'the claim is released');
    assert.ok(turn.returned());
    assert.equal(log.claims.length, 1);
    assert.deepEqual(log.releases, [
      { launchId: meta.launchId, turn: 1, returnedAtRelease: true },
    ]);
  });

  test('takes the claim before it looks for the result', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, registry, log } = makeDeps(stateDir);
    const meta = await runningOwnRun(stateDir, registry);
    await writeTurn(stateDir, meta, 1, 'Ended just now.');
    const result = finished(await waitTurn(deps, { session: meta.launchId }));
    assert.equal(result.text, 'Ended just now.');
    assert.deepEqual(log.claims, [{ launchId: meta.launchId, turn: 1, resultAtClaim: true }]);
    assert.equal(log.releases[0]?.returnedAtRelease, true);
    assert.ok(!files(stateDir, meta, 1).claimed());
  });

  test('a turn the registry does not know yet is claimed from the recorded state', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, log } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, { state: 'running', currentTurn: 1 });
    const pending = waitTurn(deps, { session: meta.launchId });
    await sleep(50);
    assert.ok(files(stateDir, meta, 1).claimed());
    await writeTurn(stateDir, meta, 1);
    finished(await pending);
    assert.equal(log.claims.length, 1);
  });

  test('at the default timeout returns the running state without a trailer', async (t) => {
    const stateDir = await tempDir(t);
    let clock = Date.now();
    const { deps, registry, log } = makeDeps(stateDir, { now: () => clock });
    const meta = await runningOwnRun(stateDir, registry, new Date(clock - 5_000).toISOString());
    const pending = waitTurn(deps, { session: meta.launchId });
    const state = track(pending);
    await sleep(40);
    clock += (WAIT_TIMEOUT_DEFAULT_S - 1) * 1000;
    await sleep(40);
    assert.ok(!state.settled(), 'still blocked one second before the default timeout');
    assert.ok(files(stateDir, meta, 1).claimed());
    clock += 1000;
    const result = await pending;
    assert.deepEqual(result, {
      state: 'running',
      launchId: meta.launchId,
      sessionId: meta.kiroSessionId,
      turn: 1,
      elapsedS: WAIT_TIMEOUT_DEFAULT_S + 5,
      toolCalls: 3,
      lastTool: 'run_command: npm test',
    });
    assert.ok(!('trailer' in result));
    assert.ok(!files(stateDir, meta, 1).claimed());
    assert.ok(!files(stateDir, meta, 1).returned());
    assert.equal(log.releases.length, 1);
  });

  test('an explicit timeout_s is honoured in real time', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, registry } = makeDeps(stateDir);
    const meta = await runningOwnRun(stateDir, registry);
    const started = Date.now();
    const result = await waitTurn(deps, { session: meta.launchId, timeout_s: 1 });
    const took = Date.now() - started;
    assert.equal(result.state, 'running');
    assert.ok(took >= 1000 && took < 3000, `took ${took} ms`);
    assert.ok(!files(stateDir, meta, 1).claimed());
  });

  test('an abort releases the claim and leaves the turn to the waiter', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, registry, log } = makeDeps(stateDir);
    const meta = await runningOwnRun(stateDir, registry);
    const controller = new AbortController();
    const pending = waitTurn(deps, { session: meta.launchId }, { signal: controller.signal });
    await sleep(50);
    assert.ok(files(stateDir, meta, 1).claimed());
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(!files(stateDir, meta, 1).claimed());
    assert.ok(!files(stateDir, meta, 1).returned());
    assert.equal(log.releases.length, 1);
  });

  test('an aborted signal fails at once without a claim', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, registry, log } = makeDeps(stateDir);
    const meta = await runningOwnRun(stateDir, registry);
    await assert.rejects(
      waitTurn(deps, { session: meta.launchId }, { signal: AbortSignal.abort() }),
      { name: 'AbortError' },
    );
    assert.equal(log.claims.length, 0);
  });

  test('reports progress from the live registry while it blocks', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, registry } = makeDeps(stateDir, { progressMs: 30 });
    const meta = await runningOwnRun(stateDir, registry);
    const progress: TurnCounters[] = [];
    const pending = waitTurn(
      deps,
      { session: meta.launchId },
      {
        onProgress: (counters) => {
          progress.push(counters);
          if (progress.length === 1) {
            throw new Error('a failed progress report');
          }
        },
      },
    );
    await sleep(200);
    await writeTurn(stateDir, meta, 1);
    finished(await pending);
    assert.ok(progress.length >= 2, `${progress.length} progress reports`);
    for (const counters of progress) {
      assert.equal(counters.toolCalls, 3);
      assert.equal(counters.lastTool, 'run_command: npm test');
      assert.equal(typeof counters.elapsedS, 'number');
    }
  });
});

describe('wait arguments and states', () => {
  test('rejects out-of-range arguments, naming the field', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, log } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, { currentTurn: 1 });
    await writeTurn(stateDir, meta, 1);
    const session = meta.launchId;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ timeout_s: 0 }, 'timeout_s'],
      [{ timeout_s: 3601 }, 'timeout_s'],
      [{ timeout_s: 1.5 }, 'timeout_s'],
      [{ timeout_s: '10' }, 'timeout_s'],
      [{ limit: 0 }, 'limit'],
      [{ limit: 40_001 }, 'limit'],
      [{ offset: -1 }, 'offset'],
      [{ offset: 0.5 }, 'offset'],
      [{ turn: 0 }, 'turn'],
      [{ turn: 1.5 }, 'turn'],
    ];
    for (const [args, field] of cases) {
      await assert.rejects(waitTurn(deps, { session, ...args }), isCode('E_INVALID', field));
    }
    for (const args of [{ timeout_s: 1 }, { timeout_s: 3600 }, { limit: 40_000 }, { limit: 1 }]) {
      finished(await waitTurn(deps, { session, ...args }));
    }
    assert.equal(log.claims.length, 0);
  });

  test('a turn above the latest is E_NOT_FOUND', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, { currentTurn: 1 });
    await writeTurn(stateDir, meta, 1);
    await assert.rejects(
      waitTurn(deps, { session: meta.launchId, turn: 2 }),
      isCode('E_NOT_FOUND'),
    );
  });

  test('a session without turns is E_INVALID, a start without a prompt included', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, registry, log } = makeDeps(stateDir);
    const idle = await writeRun(stateDir, { currentTurn: 0, state: 'idle' });
    const starting = await writeRun(stateDir, { currentTurn: 0, state: 'starting' });
    const driven = await writeRun(stateDir, { currentTurn: 0, state: 'idle' });
    registry.put(liveSession(driven.launchId, { state: 'starting', currentTurn: 0 }));
    for (const meta of [idle, starting, driven]) {
      await assert.rejects(
        waitTurn(deps, { session: meta.launchId }),
        isCode('E_INVALID', 'session'),
      );
    }
    assert.equal(log.claims.length, 0);
  });

  test('another owner of the home: a finished turn is read without claim or mark', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, log } = makeDeps(stateDir);
    const owner = await startIdleProcess();
    t.after(() => owner.stop());
    const meta = await writeRun(stateDir, {
      ownerKey: ownerKey(owner.identity),
      currentTurn: 1,
      state: 'idle',
    });
    const written = await writeTurn(stateDir, meta, 1, 'Their result.');
    const result = finished(await waitTurn(deps, { session: meta.launchId }));
    assert.equal(result.relation, 'same-home');
    assert.deepEqual(result.result, written);
    assert.equal(result.text, 'Their result.');
    assert.equal(result.trailer, `kiro-result: ${meta.launchId}#1`);
    assert.equal(log.claims.length, 0);
    assert.ok(!files(stateDir, meta, 1).returned());
    assert.ok(!files(stateDir, meta, 1).claimed());
  });

  test('another owner of the home: a running turn is E_BUSY without a claim', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, log } = makeDeps(stateDir);
    const owner = await startIdleProcess();
    t.after(() => owner.stop());
    const meta = await writeRun(stateDir, {
      ownerKey: ownerKey(owner.identity),
      currentTurn: 1,
      state: 'running',
    });
    await assert.rejects(waitTurn(deps, { session: meta.launchId }), isCode('E_BUSY'));
    assert.equal(log.claims.length, 0);
    assert.ok(!files(stateDir, meta, 1).claimed());
  });

  test('another host: a finished turn is read-only, a running one is E_BUSY', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, log } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, {
      ownerKey: `pid-4242-777@${OTHER_HOST_DRIVER.hostId}`,
      driver: OTHER_HOST_DRIVER,
      currentTurn: 2,
      state: 'running',
    });
    await writeTurn(stateDir, meta, 1, 'Far result.');
    const result = finished(await waitTurn(deps, { session: meta.launchId, turn: 1 }));
    assert.equal(result.relation, 'other-host');
    assert.ok(!files(stateDir, meta, 1).returned());
    await assert.rejects(waitTurn(deps, { session: meta.launchId }), isCode('E_BUSY'));
    assert.equal(log.claims.length, 0);
  });

  test('a run of another home is E_NOT_FOUND', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, {
      ownerKey: 'pid-1-1@elsewhere',
      home: 'another-home',
      currentTurn: 1,
    });
    await writeTurn(stateDir, meta, 1);
    await assert.rejects(waitTurn(deps, { session: meta.launchId }), isCode('E_NOT_FOUND'));
  });
});

const STATUS_KEYS = [
  'launchId',
  'sessionId',
  'label',
  'mode',
  'dir',
  'home',
  'state',
  'relation',
  'host',
  'currentTurn',
  'elapsedS',
  'toolCalls',
  'lastTool',
  'permissionsAnswered',
  'waiterArmed',
  'undelivered',
].sort();

describe('status', () => {
  test('an own running session carries every field and no turn text', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, registry } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, { state: 'running', currentTurn: 2 });
    await writeTurn(stateDir, meta, 1, 'Secret turn text.');
    registry.put(
      liveSession(meta.launchId, {
        state: 'running',
        currentTurn: 2,
        runningTurn: {
          turn: 2,
          startedAt: new Date(Date.now() - 7_000).toISOString(),
          toolCalls: 5,
          lastTool: 'grep',
        },
        permissionsAnswered: { allowed: 4, denied: 1 },
      }),
    );
    const [status, ...rest] = await sessionStatus(deps, { session: meta.launchId });
    assert.equal(rest.length, 0);
    assert.ok(status !== undefined);
    assert.deepEqual(Object.keys(status).sort(), STATUS_KEYS);
    assert.equal(status.launchId, meta.launchId);
    assert.equal(status.sessionId, meta.kiroSessionId);
    assert.equal(status.label, meta.label);
    assert.equal(status.mode, 'docker');
    assert.equal(status.dir, meta.dir);
    assert.equal(status.home, meta.home);
    assert.equal(status.state, 'running');
    assert.equal(status.relation, 'own');
    assert.equal(status.host, null);
    assert.equal(status.currentTurn, 2);
    assert.ok(status.elapsedS !== null && status.elapsedS >= 7 && status.elapsedS < 30);
    assert.equal(status.toolCalls, 5);
    assert.equal(status.lastTool, 'grep');
    assert.deepEqual(status.permissionsAnswered, { allowed: 4, denied: 1 });
    assert.equal(status.waiterArmed, false);
    assert.deepEqual(status.undelivered, [1]);
    assert.doesNotMatch(JSON.stringify(status), /Secret turn text|Done\./);
  });

  test('waiterArmed follows the age of the current turn heartbeat', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, { state: 'running', currentTurn: 1 });
    const armed = turnPaths(stateDir, meta.launchId, 1).armed;
    const waiterArmed = async () =>
      (await sessionStatus(deps, { session: meta.launchId }))[0]?.waiterArmed;
    assert.equal(await waiterArmed(), false);
    await writeFile(armed, '', 'utf8');
    assert.equal(await waiterArmed(), true);
    const seconds = Date.now() / 1000;
    await utimes(armed, seconds - 20, seconds - 20);
    assert.equal(await waiterArmed(), false);
    await utimes(armed, seconds - 5, seconds - 5);
    assert.equal(await waiterArmed(), true);
  });

  test('undelivered lists the finished turns with neither .pushed nor .returned', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, { state: 'running', currentTurn: 11 });
    for (const turn of [1, 2, 3, 4, 10]) {
      await writeTurn(stateDir, meta, turn, null, { endedBy: turn === 4 ? 'cancel' : null });
    }
    await writeFile(turnPaths(stateDir, meta.launchId, 2).pushed, '{}', 'utf8');
    await writeFile(turnPaths(stateDir, meta.launchId, 3).returned, '{}', 'utf8');
    await writeFile(turnPaths(stateDir, meta.launchId, 11).armed, '', 'utf8');
    const [status] = await sessionStatus(deps, { session: meta.launchId });
    assert.deepEqual(status?.undelivered, [1, 4, 10]);
  });

  test('without a session it lists every own session and no other', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const owner = await startIdleProcess();
    t.after(() => owner.stop());
    const idle = await writeRun(stateDir, { state: 'idle' });
    const stopped = await writeRun(stateDir, { state: 'stopped', home: 'another-home' });
    await writeRun(stateDir, { ownerKey: ownerKey(owner.identity), state: 'idle' });
    await writeRun(stateDir, { ownerKey: 'pid-1-1@elsewhere', home: 'another-home' });
    const statuses = await sessionStatus(deps);
    assert.deepEqual(
      statuses.map((status) => status.launchId),
      [idle.launchId, stopped.launchId],
    );
    assert.deepEqual(await sessionStatus(makeDeps(await tempDir(t)).deps), []);
  });

  test('a dead driver on this host shows lost; a record of another host never does', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const lost = await writeRun(stateDir, { state: 'idle', driver: await deadIdentity() });
    const far = await writeRun(stateDir, {
      ownerKey: `pid-4242-777@${OTHER_HOST_DRIVER.hostId}`,
      driver: OTHER_HOST_DRIVER,
      state: 'running',
    });
    const [lostStatus] = await sessionStatus(deps, { session: lost.launchId });
    assert.equal(lostStatus?.state, 'lost');
    assert.equal(lostStatus?.permissionsAnswered, null);
    const [farStatus] = await sessionStatus(deps, { session: far.launchId });
    assert.equal(farStatus?.state, 'running');
    assert.equal(farStatus?.relation, 'other-host');
    assert.equal(farStatus?.host, OTHER_HOST_DRIVER.hostId);
    assert.equal(farStatus?.toolCalls, null);
  });

  test('works read-only on another owner of the home', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, {
      ownerKey: ownerKey(await deadIdentity()),
      state: 'stopped',
      currentTurn: 1,
    });
    await writeTurn(stateDir, meta, 1);
    const [status] = await sessionStatus(deps, { session: meta.launchId });
    assert.equal(status?.relation, 'same-home');
    assert.deepEqual(status?.undelivered, [1]);
    assert.ok(!files(stateDir, meta, 1).returned());
    const other = await writeRun(stateDir, { ownerKey: 'pid-1-1@elsewhere', home: 'another-home' });
    await assert.rejects(sessionStatus(deps, { session: other.launchId }), isCode('E_NOT_FOUND'));
  });
});

describe('list', () => {
  test('lists own sessions with their last turn; history is off by default', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const fresh = await writeRun(stateDir, { state: 'idle', currentTurn: 0 });
    const cancelled = await writeRun(stateDir, { state: 'idle', currentTurn: 2 });
    await writeTurn(stateDir, cancelled, 2, null, {
      outcome: 'cancelled',
      endedBy: 'cancel',
      endedAt: '2026-10-18T01:02:03Z',
    });
    const running = await writeRun(stateDir, { state: 'running', currentTurn: 1 });
    const broken = await writeRun(stateDir, { state: 'stopped', currentTurn: 1 });
    await writeFile(turnPaths(stateDir, broken.launchId, 1).result, '[]', 'utf8');
    await writeRun(stateDir, { ownerKey: ownerKey(await deadIdentity()), state: 'stopped' });
    for (const args of [undefined, {}, { history: false }]) {
      const listing = await listSessions(deps, args);
      assert.deepEqual(
        listing.map((entry) => entry.launchId),
        [fresh.launchId, cancelled.launchId, running.launchId, broken.launchId],
      );
      const [first, second, third, fourth] = listing;
      assert.equal(first?.lastTurn, null);
      assert.deepEqual(second?.lastTurn, {
        n: 2,
        outcome: 'cancelled',
        endedAt: '2026-10-18T01:02:03Z',
        invalid: null,
      });
      assert.deepEqual(third?.lastTurn, { n: 1, outcome: null, endedAt: null, invalid: null });
      assert.equal(fourth?.lastTurn?.outcome, null);
      assert.match(fourth?.lastTurn?.invalid ?? '', /not a valid turn result/);
      for (const entry of listing) {
        assert.equal(entry.resumable, false);
        assert.equal(entry.relation, 'own');
        assert.deepEqual(
          Object.keys(entry).sort(),
          [
            'launchId',
            'sessionId',
            'label',
            'mode',
            'dir',
            'home',
            'state',
            'relation',
            'host',
            'lastTurn',
            'resumable',
          ].sort(),
        );
      }
    }
  });

  test('history adds the home history, none of it resumable in this version', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const alive = await startIdleProcess();
    t.after(() => alive.stop());
    const deadOwner = ownerKey(await deadIdentity());
    const aliveOwner = ownerKey(alive.identity);
    const deadDriver = await deadIdentity();
    const driver = await currentDriver();
    const expected = new Set<string>();
    const add = async (overrides: Partial<RunMeta>) => {
      const meta = await writeRun(stateDir, { driver, ...overrides });
      expected.add(meta.launchId);
      return meta;
    };
    const ownExited = await add({ state: 'exited' });
    const ownIdle = await add({ state: 'idle' });
    const ownFailedUnloaded = await add({ state: 'failed', kiroSessionId: null });
    const stopped = await add({ ownerKey: deadOwner, state: 'stopped' });
    await add({ ownerKey: deadOwner, state: 'stopped', kiroSessionId: null });
    await add({ ownerKey: aliveOwner, state: 'exited' });
    const lost = await add({ ownerKey: deadOwner, state: 'idle', driver: deadDriver });
    await add({ ownerKey: deadOwner, state: 'failed' });
    await add({ ownerKey: deadOwner, state: 'failed', kiroSessionId: null });
    // Read-only history: listed with its state, never resumable.
    const completed = await add({ ownerKey: deadOwner, state: 'completed' });
    await add({ ownerKey: deadOwner, state: 'stopped', mode: 'local', tokenSource: null, image: null });
    const locked = await add({ ownerKey: deadOwner, state: 'stopped' });
    await writeJsonAtomic(runPaths(stateDir, locked.launchId).lock, alive.identity);
    const far = await add({
      ownerKey: `pid-4242-777@${OTHER_HOST_DRIVER.hostId}`,
      driver: OTHER_HOST_DRIVER,
      state: 'running',
    });
    const liveOther = await writeRun(stateDir, { ownerKey: aliveOwner, state: 'idle', driver });
    const otherHome = await writeRun(stateDir, {
      ownerKey: deadOwner,
      state: 'stopped',
      home: 'another-home',
    });

    const listing = await listSessions(deps, { history: true });
    const ids = listing.map((entry) => entry.launchId);
    assert.deepEqual(ids.slice(0, 3), [
      ownExited.launchId,
      ownIdle.launchId,
      ownFailedUnloaded.launchId,
    ]);
    assert.ok(!ids.includes(liveOther.launchId), 'a live session of another owner is not history');
    assert.ok(!ids.includes(otherHome.launchId), 'another home is never listed');
    assert.deepEqual(new Set(ids), expected);
    for (const entry of listing) {
      assert.equal(entry.resumable, false, entry.launchId);
    }
    const byId = new Map(listing.map((entry) => [entry.launchId, entry]));
    assert.equal(byId.get(lost.launchId)?.state, 'lost');
    assert.equal(byId.get(completed.launchId)?.state, 'completed');
    assert.equal(byId.get(completed.launchId)?.relation, 'same-home');
    assert.equal(byId.get(stopped.launchId)?.relation, 'same-home');
    assert.equal(byId.get(stopped.launchId)?.host, null);
    assert.equal(byId.get(far.launchId)?.state, 'running');
    assert.equal(byId.get(far.launchId)?.relation, 'other-host');
    assert.equal(byId.get(far.launchId)?.host, OTHER_HOST_DRIVER.hostId);
  });

  test('a history argument that is not a boolean is E_INVALID', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    await assert.rejects(listSessions(deps, { history: 'yes' }), isCode('E_INVALID', 'history'));
  });
});
