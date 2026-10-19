import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fsPromises, { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import type { TestContext } from 'node:test';
import {
  LOST_ERROR,
  WAITER_POLL_INTERVAL_MS,
  lostResult,
  parseDeadlineArg,
  pollTurn,
  turnLogIds,
  waiterSecrets,
} from '../../src/hooks/waiter-loop.ts';
import type { WaiterLoopOptions } from '../../src/hooks/waiter-loop.ts';
import type { WaiterTurn } from '../../src/hooks/waiter-setup.ts';
import { buildExpiredNotice, buildWakeMessage } from '../../src/hooks/wake.ts';
import { TurnClaims } from '../../src/session/claims.ts';
import { parseTurnResult } from '../../src/session/turn-result.ts';
import type { TurnResult } from '../../src/session/types.ts';
import { writeJsonAtomic } from '../../src/store/files.ts';
import { liveness as processLiveness, ownerKey } from '../../src/store/identity.ts';
import type { Liveness, ProcessIdentity } from '../../src/store/identity.ts';
import { callPath, runPaths, turnPaths } from '../../src/store/paths.ts';
import { readTurnResult, recordCall, recordCallFailure } from '../../src/store/runs.ts';
import type { RunMeta } from '../../src/store/runs.ts';
import { SecretSet } from '../../src/text/redact.ts';
import { tempDir } from '../helpers/processes.ts';
import { OTHER_HOST_DRIVER, OWNER, sampleResult, writeRun, writeTurn } from '../session/helpers-runs.ts';
import { FakeClock, SESSION_ID, TOOL_USE_ID, hookLogLines } from './helpers.ts';

const CLOCK_AT = '2026-10-18T01:00:00Z';
const DRIVER: ProcessIdentity = { pid: 5151, startTime: '888', hostId: 'test-host:boot:1' };
const SECRET = 'test-secret-value-0123456789abcdef';
const NO_SECRETS = new SecretSet();

interface Fixture {
  readonly stateDir: string;
  readonly meta: RunMeta;
  readonly turn: WaiterTurn;
  readonly paths: ReturnType<typeof turnPaths>;
  readonly clock: FakeClock;
  /** Liveness by owner key; alive when not set. */
  readonly states: Map<string, Liveness>;
  readonly options: WaiterLoopOptions;
}

async function fixture(
  t: TestContext,
  overrides: Partial<RunMeta> = {},
  options: Partial<WaiterLoopOptions> = {},
): Promise<Fixture> {
  const stateDir = await tempDir(t);
  const meta = await writeRun(stateDir, { driver: DRIVER, currentTurn: 1, state: 'running', ...overrides });
  const turn: WaiterTurn = {
    kind: 'turn',
    stateDir,
    launchId: meta.launchId,
    turn: 1,
    source: 'trailer',
    run: meta,
    sessionId: SESSION_ID,
    agentType: null,
    agentId: null,
    toolUseId: TOOL_USE_ID,
  };
  const clock = new FakeClock();
  const states = new Map<string, Liveness>();
  return {
    stateDir,
    meta,
    turn,
    paths: turnPaths(stateDir, meta.launchId, 1),
    clock,
    states,
    options: {
      deadlineMs: 60_000,
      clock,
      env: {},
      liveness: (identity) => Promise.resolve(states.get(ownerKey(identity)) ?? 'alive'),
      ...options,
    },
  };
}

/**
 * Runs `between` once, after the waiter's first look at a delivery marker of
 * the turn has seen the files and before that look returns to the waiter.
 */
function betweenMarkerChecks(t: TestContext, f: Fixture, between: () => Promise<void>): void {
  const original = fsPromises.stat;
  const markers = new Set<unknown>([f.paths.claimed, f.paths.returned]);
  let pending = true;
  const patched = async (...args: unknown[]): Promise<unknown> => {
    const look = Reflect.apply(original, fsPromises, args) as Promise<unknown>;
    if (!pending || !markers.has(args[0])) {
      return look;
    }
    pending = false;
    try {
      return await look;
    } finally {
      await between();
    }
  };
  fsPromises.stat = patched as typeof original;
  syncBuiltinESMExports();
  t.after(() => {
    fsPromises.stat = original;
    syncBuiltinESMExports();
  });
}

async function logReasons(stateDir: string): Promise<unknown[]> {
  return (await hookLogLines(stateDir)).map((line) => line.reason);
}

function wakeOf(meta: RunMeta, result: TurnResult, agentType: string | null = null): string {
  return buildWakeMessage({ run: meta, result, agentType, secrets: NO_SECRETS });
}

async function pushedMarker(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

describe('pollTurn: a turn with a result', () => {
  test('is pushed at once: exit 2, the wake message and a .pushed marker', async (t) => {
    const f = await fixture(t);
    const result = await writeTurn(f.stateDir, f.meta, 1);
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 2, reason: 'pushed', wake: wakeOf(f.meta, result) });
    assert.deepEqual(await pushedMarker(f.paths.pushed), { sessionId: SESSION_ID, at: CLOCK_AT });
    assert.deepEqual(f.clock.sleeps, []);
    const lines = await hookLogLines(f.stateDir);
    assert.deepEqual(lines, [
      {
        at: CLOCK_AT,
        hook: 'waiter',
        step: 'turn',
        reason: 'pushed',
        launchId: f.meta.launchId,
        turn: 1,
        toolUseId: TOOL_USE_ID,
        sessionId: SESSION_ID,
      },
    ]);
  });

  test('a subagent turn names the agent type', async (t) => {
    const f = await fixture(t);
    const result = await writeTurn(f.stateDir, f.meta, 1);
    const outcome = await pollTurn({ ...f.turn, agentType: 'code-reviewer', agentId: 'agent-1' }, f.options);
    assert.equal(outcome.wake, wakeOf(f.meta, result, 'code-reviewer'));
    assert.equal((await hookLogLines(f.stateDir))[0]?.agentId, 'agent-1');
  });

  test('uses the freshest label and Kiro id from meta.json', async (t) => {
    const f = await fixture(t);
    const result = await writeTurn(f.stateDir, f.meta, 1);
    const fresh = { ...f.meta, label: 'renamed', kiroSessionId: 'sess-fresh' };
    await writeJsonAtomic(runPaths(f.stateDir, f.meta.launchId).meta, fresh);
    const outcome = await pollTurn(f.turn, f.options);
    assert.equal(outcome.wake, wakeOf(fresh, result));
    assert.match(outcome.wake ?? '', /"renamed"/);
  });

  test('falls back to the run it was given when meta.json cannot be read', async (t) => {
    const f = await fixture(t);
    const result = await writeTurn(f.stateDir, f.meta, 1);
    await writeFile(runPaths(f.stateDir, f.meta.launchId).meta, '{', 'utf8');
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 2, reason: 'pushed', wake: wakeOf(f.meta, result) });
  });

  test('with endedBy: exit 0, no push', async (t) => {
    const f = await fixture(t);
    await writeTurn(f.stateDir, f.meta, 1, 'Done.', { outcome: 'cancelled', endedBy: 'cancel' });
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'ended-by', wake: null });
    assert.equal(existsSync(f.paths.pushed), false);
    assert.deepEqual(await logReasons(f.stateDir), ['ended-by']);
  });

  test('with .returned: exit 0, no push', async (t) => {
    const f = await fixture(t);
    await writeTurn(f.stateDir, f.meta, 1);
    await writeFile(f.paths.returned, '{}', 'utf8');
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'returned', wake: null });
    assert.equal(existsSync(f.paths.pushed), false);
    assert.deepEqual(await logReasons(f.stateDir), ['returned']);
  });

  test('with .claimed: keeps polling; pushed once the claim is removed', async (t) => {
    const f = await fixture(t);
    const result = await writeTurn(f.stateDir, f.meta, 1);
    await writeFile(f.paths.claimed, '{}', 'utf8');
    f.clock.onSleep = async (count) => {
      if (count === 2) {
        await rm(f.paths.claimed);
      }
    };
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 2, reason: 'pushed', wake: wakeOf(f.meta, result) });
    assert.deepEqual(f.clock.sleeps, [2_000, 2_000]);
    assert.deepEqual(await pushedMarker(f.paths.pushed), { sessionId: SESSION_ID, at: '2026-10-18T01:00:04Z' });
    assert.deepEqual(await logReasons(f.stateDir), ['pushed']);
  });

  test('with .claimed and .returned: keeps polling until the claim is removed, then exit 0, no push', async (t) => {
    const f = await fixture(t);
    await writeTurn(f.stateDir, f.meta, 1);
    await writeFile(f.paths.claimed, '{}', 'utf8');
    f.clock.onSleep = async (count) => {
      if (count === 1) {
        await writeFile(f.paths.returned, '{}', 'utf8');
      }
      if (count === 2) {
        await rm(f.paths.claimed);
      }
    };
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'returned', wake: null });
    assert.deepEqual(f.clock.sleeps, [2_000, 2_000]);
    assert.equal(existsSync(f.paths.pushed), false);
  });

  test('the claiming call returns the turn between the marker checks: exit 0, no push', async (t) => {
    const f = await fixture(t);
    await writeTurn(f.stateDir, f.meta, 1);
    const claims = new TurnClaims(f.stateDir);
    const release = await claims.claim(f.meta.launchId, 1);
    // The server's order: `.returned` is written before the claim is released.
    betweenMarkerChecks(t, f, async () => {
      await claims.markReturned(f.meta.launchId, 1);
      await release();
    });
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'returned', wake: null });
    assert.deepEqual(f.clock.sleeps, [2_000]);
    assert.equal(existsSync(f.paths.pushed), false);
    assert.equal(existsSync(f.paths.claimed), false);
    assert.deepEqual(await logReasons(f.stateDir), ['returned']);
  });

  test('with .pushed already there: exit 0 and the marker is left as it was', async (t) => {
    const f = await fixture(t);
    await writeTurn(f.stateDir, f.meta, 1);
    const other = { sessionId: 'another-session', at: '2026-10-18T00:59:00Z' };
    await writeFile(f.paths.pushed, JSON.stringify(other), 'utf8');
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'pushed-elsewhere', wake: null });
    assert.deepEqual(await pushedMarker(f.paths.pushed), other);
    assert.deepEqual(await logReasons(f.stateDir), ['pushed-elsewhere']);
  });

  test('a result that is not JSON: exit 0, logged as unreadable', async (t) => {
    const f = await fixture(t);
    await writeFile(f.paths.result, '{"launchId":', 'utf8');
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'result-unreadable', wake: null });
    assert.equal(existsSync(f.paths.pushed), false);
    assert.deepEqual(await logReasons(f.stateDir), ['result-unreadable']);
  });

  test('a result that breaks the contract: exit 0, logged as invalid', async (t) => {
    const f = await fixture(t);
    await writeFile(f.paths.result, JSON.stringify({ ...sampleResult(f.meta, 1), toolCalls: -1 }), 'utf8');
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'result-invalid', wake: null });
    assert.equal(existsSync(f.paths.pushed), false);
  });

  test('a result of another turn: exit 0, logged as invalid', async (t) => {
    const f = await fixture(t);
    await writeFile(f.paths.result, JSON.stringify(sampleResult(f.meta, 2)), 'utf8');
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'result-invalid', wake: null });
  });

  test('a push stopped before it began: exit 0, no .pushed, no log line', async (t) => {
    const f = await fixture(t, {}, { beginPush: () => false });
    await writeTurn(f.stateDir, f.meta, 1);
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'stopped', wake: null });
    assert.equal(existsSync(f.paths.pushed), false);
    assert.deepEqual(await logReasons(f.stateDir), []);
  });

  test('a wake message that cannot be built: exit 0, logged as internal, no .pushed', async (t) => {
    let asked = 0;
    const f = await fixture(t, {}, {
      secrets: () => ({
        redact: () => {
          throw new RangeError('the text cannot be built');
        },
      }),
      beginPush: () => {
        asked += 1;
        return true;
      },
    });
    await writeTurn(f.stateDir, f.meta, 1);
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'internal', wake: null });
    assert.equal(existsSync(f.paths.pushed), false);
    assert.equal(asked, 0, 'the push never began');
    assert.deepEqual(await logReasons(f.stateDir), ['internal']);
  });
});

describe('pollTurn: the driver', () => {
  test('dead with no result: lost is created once, without meta.json, then pushed', async (t) => {
    const f = await fixture(t);
    f.states.set(ownerKey(DRIVER), 'dead');
    const stderrLog = runPaths(f.stateDir, f.meta.launchId).stderrLog;
    await writeFile(stderrLog, 'starting\nconnection reset\n', 'utf8');
    const metaBefore = await readFile(runPaths(f.stateDir, f.meta.launchId).meta, 'utf8');

    const outcome = await pollTurn(f.turn, f.options);

    const stored = parseTurnResult(await readTurnResult(f.stateDir, f.meta.launchId, 1), f.meta.launchId, 1);
    const expected = lostResult(f.meta, 1, new Date(f.clock.time), new Date(f.clock.time), 'starting\nconnection reset');
    assert.deepEqual(stored, expected);
    assert.equal(stored.outcome, 'lost');
    assert.equal(stored.error, LOST_ERROR);
    assert.deepEqual(outcome, { exitCode: 2, reason: 'pushed', wake: wakeOf(f.meta, expected) });
    assert.match(outcome.wake ?? '', /turn 1: lost/);
    assert.equal(await readFile(runPaths(f.stateDir, f.meta.launchId).meta, 'utf8'), metaBefore);
    assert.deepEqual(await logReasons(f.stateDir), ['lost-created', 'pushed']);
  });

  test('dead before the start opened its first turn: exit 0, never-opened, no lost result, no wake', async (t) => {
    const f = await fixture(t, { state: 'starting', currentTurn: 0 });
    f.states.set(ownerKey(DRIVER), 'dead');
    await recordCall(f.stateDir, TOOL_USE_ID, { launchId: f.meta.launchId, turn: 1, driver: DRIVER });
    const outcome = await pollTurn({ ...f.turn, source: 'call' }, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'never-opened', wake: null });
    assert.equal(existsSync(f.paths.result), false);
    assert.equal(existsSync(f.paths.pushed), false);
    assert.deepEqual(await logReasons(f.stateDir), ['never-opened']);
  });

  test('dead before a send opened its turn: exit 0, never-opened, no lost result, no wake', async (t) => {
    const f = await fixture(t, { state: 'idle', currentTurn: 1 });
    f.states.set(ownerKey(DRIVER), 'dead');
    await recordCall(f.stateDir, TOOL_USE_ID, { launchId: f.meta.launchId, turn: 2, driver: DRIVER });
    const second = turnPaths(f.stateDir, f.meta.launchId, 2);
    const outcome = await pollTurn({ ...f.turn, turn: 2, source: 'call' }, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'never-opened', wake: null });
    assert.equal(existsSync(second.result), false);
    assert.equal(existsSync(second.pushed), false);
    assert.deepEqual(await logReasons(f.stateDir), ['never-opened']);
  });

  test('dead after a poll: lost is created on the poll that sees it, timed from the waiter start', async (t) => {
    const f = await fixture(t, {}, { startedAt: Date.UTC(2026, 9, 18, 0, 59, 50) });
    f.clock.onSleep = (count) => {
      if (count === 1) {
        f.states.set(ownerKey(DRIVER), 'dead');
      }
    };
    const outcome = await pollTurn(f.turn, f.options);
    assert.equal(outcome.reason, 'pushed');
    const stored = parseTurnResult(await readTurnResult(f.stateDir, f.meta.launchId, 1), f.meta.launchId, 1);
    assert.equal(stored.startedAt, '2026-10-18T00:59:50Z');
    assert.equal(stored.endedAt, '2026-10-18T01:00:02Z');
    assert.equal(stored.durationS, 12);
    assert.equal(stored.stderrTail, null);
  });

  test('dead while the driver writes its own result: the existing result is kept', async (t) => {
    const f = await fixture(t);
    let written: TurnResult | undefined;
    const options: WaiterLoopOptions = {
      ...f.options,
      liveness: async (identity) => {
        if (ownerKey(identity) !== ownerKey(DRIVER)) {
          return 'alive';
        }
        // The driver's result lands between the waiter's read and its create.
        written ??= await writeTurn(f.stateDir, f.meta, 1, 'Finished.', { final: 'Finished.' });
        return 'dead';
      },
    };
    const outcome = await pollTurn(f.turn, options);
    assert.ok(written !== undefined);
    assert.deepEqual(await readTurnResult(f.stateDir, f.meta.launchId, 1), written);
    assert.deepEqual(outcome, { exitCode: 2, reason: 'pushed', wake: wakeOf(f.meta, written) });
    assert.deepEqual(await logReasons(f.stateDir), ['pushed']);
  });

  test('on another host: never lost, the push expires at the deadline', async (t) => {
    // The real liveness: the owner and the driver are both on other hosts.
    const f = await fixture(t, { driver: OTHER_HOST_DRIVER }, { deadlineMs: 4_000, liveness: processLiveness });
    assert.equal(f.meta.ownerKey, OWNER);
    const outcome = await pollTurn(f.turn, f.options);
    assert.equal(outcome.reason, 'expired');
    assert.equal(existsSync(f.paths.result), false);
    assert.deepEqual(await logReasons(f.stateDir), ['expired']);
  });

  test('alive: no lost result while the turn runs', async (t) => {
    const f = await fixture(t, {}, { deadlineMs: 6_000 });
    const outcome = await pollTurn(f.turn, f.options);
    assert.equal(outcome.reason, 'expired');
    assert.equal(existsSync(f.paths.result), false);
  });
});

describe('pollTurn: the owner', () => {
  test('dead: exit 0 and no .pushed, even with a result to push', async (t) => {
    const f = await fixture(t);
    await writeTurn(f.stateDir, f.meta, 1);
    f.states.set(OWNER, 'dead');
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'owner-gone', wake: null });
    assert.equal(existsSync(f.paths.pushed), false);
    const lines = await hookLogLines(f.stateDir);
    assert.deepEqual(lines.map((line) => [line.step, line.reason]), [['owner', 'owner-gone']]);
  });

  test('dead while polling: exit 0 on the next poll', async (t) => {
    const f = await fixture(t);
    f.clock.onSleep = (count) => {
      if (count === 2) {
        f.states.set(OWNER, 'dead');
      }
    };
    const outcome = await pollTurn(f.turn, f.options);
    assert.equal(outcome.reason, 'owner-gone');
    assert.deepEqual(f.clock.sleeps, [2_000, 2_000]);
  });

  test('dead before the driver: no lost result is created', async (t) => {
    const f = await fixture(t);
    f.states.set(OWNER, 'dead');
    f.states.set(ownerKey(DRIVER), 'dead');
    const outcome = await pollTurn(f.turn, f.options);
    assert.equal(outcome.reason, 'owner-gone');
    assert.equal(existsSync(f.paths.result), false);
  });

  test('an owner key that does not parse: exit 0', async (t) => {
    const f = await fixture(t);
    const outcome = await pollTurn({ ...f.turn, run: { ...f.meta, ownerKey: 'not-a-key' } }, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'owner-key-invalid', wake: null });
    assert.equal(existsSync(f.paths.armed), false);
  });
});

describe('pollTurn: a turn that can no longer come', () => {
  test('its call record rewritten failed after the loop began: exit 0, no wake, no .pushed', async (t) => {
    const f = await fixture(t);
    await recordCall(f.stateDir, TOOL_USE_ID, { launchId: f.meta.launchId, turn: 1, driver: DRIVER });
    f.clock.onSleep = async (count) => {
      if (count === 1) {
        await recordCallFailure(f.stateDir, TOOL_USE_ID, 'E_CANCEL_TIMEOUT: the running turn did not end');
      }
    };
    const outcome = await pollTurn({ ...f.turn, source: 'call' }, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'call-failed', wake: null });
    assert.deepEqual(f.clock.sleeps, [2_000]);
    assert.equal(existsSync(f.paths.pushed), false);
    assert.equal(existsSync(f.paths.result), false);
    assert.deepEqual(await logReasons(f.stateDir), ['call-failed']);
  });

  test('a failed call record is not read for a turn found in the reply trailer', async (t) => {
    const f = await fixture(t, {}, { deadlineMs: 2_000 });
    await recordCallFailure(f.stateDir, TOOL_USE_ID, 'E_TEST: another call');
    const outcome = await pollTurn(f.turn, f.options);
    assert.equal(outcome.reason, 'expired');
  });

  test('the run directory removed while polling: exit 0, run-gone, no wake', async (t) => {
    const f = await fixture(t);
    f.clock.onSleep = async (count) => {
      if (count === 1) {
        await rm(runPaths(f.stateDir, f.meta.launchId).dir, { recursive: true });
      }
    };
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'run-gone', wake: null });
    assert.deepEqual(f.clock.sleeps, [2_000]);
    assert.equal(existsSync(f.paths.pushed), false);
    // The heartbeat of the poll that found the run gone had nowhere to go.
    assert.deepEqual(await logReasons(f.stateDir), ['armed-failed', 'run-gone']);
  });

  test('the run directory gone and the driver dead: run-gone, no lost result is attempted', async (t) => {
    const f = await fixture(t);
    f.states.set(ownerKey(DRIVER), 'dead');
    await rm(runPaths(f.stateDir, f.meta.launchId).dir, { recursive: true });
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'run-gone', wake: null });
    assert.deepEqual(await logReasons(f.stateDir), ['armed-failed', 'run-gone']);
  });

  test('the run failed with no result: exit 0, run-failed, no wake', async (t) => {
    const f = await fixture(t);
    f.clock.onSleep = async (count) => {
      if (count === 1) {
        await writeJsonAtomic(runPaths(f.stateDir, f.meta.launchId).meta, { ...f.meta, state: 'failed' });
      }
    };
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'run-failed', wake: null });
    assert.deepEqual(f.clock.sleeps, [2_000]);
    assert.equal(existsSync(f.paths.pushed), false);
    assert.deepEqual(await logReasons(f.stateDir), ['run-failed']);
  });

  test('the run failed and its driver is dead: run-failed, no lost result', async (t) => {
    const f = await fixture(t, { state: 'failed' });
    f.states.set(ownerKey(DRIVER), 'dead');
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'run-failed', wake: null });
    assert.equal(existsSync(f.paths.result), false);
    assert.deepEqual(await logReasons(f.stateDir), ['run-failed']);
  });

  test('a meta.json or call record that cannot be read does not end the loop', async (t) => {
    const f = await fixture(t, {}, { deadlineMs: 4_000 });
    await writeFile(runPaths(f.stateDir, f.meta.launchId).meta, '{', 'utf8');
    await recordCall(f.stateDir, TOOL_USE_ID, { launchId: f.meta.launchId, turn: 1, driver: DRIVER });
    await writeFile(callPath(f.stateDir, TOOL_USE_ID), '{', 'utf8');
    const outcome = await pollTurn({ ...f.turn, source: 'call' }, f.options);
    assert.equal(outcome.reason, 'expired');
    assert.deepEqual(f.clock.sleeps, [2_000, 2_000]);
  });
});

describe('pollTurn: the deadline', () => {
  test('passed with no result: the expired notice, exit 2, no .pushed', async (t) => {
    const f = await fixture(t, {}, { deadlineMs: 5_000 });
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, {
      exitCode: 2,
      reason: 'expired',
      wake: buildExpiredNotice({ run: f.meta, turn: 1, agentType: null, secrets: NO_SECRETS }),
    });
    assert.deepEqual(f.clock.sleeps, [2_000, 2_000, 1_000]);
    assert.equal(existsSync(f.paths.pushed), false);
    const lines = await hookLogLines(f.stateDir);
    assert.deepEqual(lines.map((line) => [line.at, line.reason]), [['2026-10-18T01:00:05Z', 'expired']]);
  });

  test('passed with .claimed and a result: the expired notice, exit 2, no .pushed', async (t) => {
    const f = await fixture(t, {}, { deadlineMs: 4_000 });
    await writeTurn(f.stateDir, f.meta, 1);
    await writeFile(f.paths.claimed, '{}', 'utf8');
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, {
      exitCode: 2,
      reason: 'expired',
      wake: buildExpiredNotice({ run: f.meta, turn: 1, agentType: null, secrets: NO_SECRETS }),
    });
    assert.deepEqual(f.clock.sleeps, [2_000, 2_000]);
    assert.equal(existsSync(f.paths.pushed), false);
    assert.deepEqual(await logReasons(f.stateDir), ['expired']);
  });

  test('passed with .claimed and no result: the expired notice, exit 2', async (t) => {
    const f = await fixture(t, {}, { deadlineMs: 2_000 });
    await writeFile(f.paths.claimed, '{}', 'utf8');
    const outcome = await pollTurn(f.turn, f.options);
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.reason, 'expired');
  });

  test('a claim held across the deadline and then released without the result: the notice was sent', async (t) => {
    const f = await fixture(t, {}, { deadlineMs: 4_000 });
    const claims = new TurnClaims(f.stateDir);
    const release = await claims.claim(f.meta.launchId, 1);
    const outcome = await pollTurn(f.turn, f.options);
    // The claiming call times out without the result; the turn ends later.
    await release();
    await writeTurn(f.stateDir, f.meta, 1);
    assert.deepEqual(outcome, {
      exitCode: 2,
      reason: 'expired',
      wake: buildExpiredNotice({ run: f.meta, turn: 1, agentType: null, secrets: NO_SECRETS }),
    });
    assert.deepEqual(f.clock.sleeps, [2_000, 2_000]);
    assert.equal(existsSync(f.paths.claimed), false);
    assert.equal(existsSync(f.paths.returned), false);
    assert.equal(existsSync(f.paths.pushed), false);
    assert.deepEqual(await logReasons(f.stateDir), ['expired']);
  });

  test('counts from the waiter start, not from the first poll', async (t) => {
    const clockStart = Date.UTC(2026, 9, 18, 1, 0, 0);
    const f = await fixture(t, {}, { deadlineMs: 6_000, startedAt: clockStart - 5_000 });
    const outcome = await pollTurn(f.turn, f.options);
    assert.equal(outcome.reason, 'expired');
    assert.deepEqual(f.clock.sleeps, [1_000]);
  });

  test('already passed at the first poll: a result is still pushed', async (t) => {
    const clockStart = Date.UTC(2026, 9, 18, 1, 0, 0);
    const f = await fixture(t, {}, { deadlineMs: 1_000, startedAt: clockStart - 9_000 });
    await writeTurn(f.stateDir, f.meta, 1);
    const outcome = await pollTurn(f.turn, f.options);
    assert.equal(outcome.reason, 'pushed');
  });
});

describe('pollTurn: polling', () => {
  test('polls every 2 s', async (t) => {
    assert.equal(WAITER_POLL_INTERVAL_MS, 2_000);
    const f = await fixture(t, {}, { deadlineMs: 10_000 });
    await pollTurn(f.turn, f.options);
    assert.deepEqual(f.clock.sleeps, [2_000, 2_000, 2_000, 2_000, 2_000]);
  });

  test('refreshes .armed on every poll, with the poll time as its mtime', async (t) => {
    const f = await fixture(t, {}, { deadlineMs: 6_000 });
    const start = f.clock.time;
    const seen: number[] = [];
    f.clock.onSleep = async () => {
      seen.push((await stat(f.paths.armed)).mtimeMs);
    };
    await pollTurn(f.turn, f.options);
    seen.push((await stat(f.paths.armed)).mtimeMs);
    assert.deepEqual(seen, [start, start + 2_000, start + 4_000, start + 6_000]);
  });

  test('a heartbeat that cannot be written is logged once and the push still happens', async (t) => {
    const f = await fixture(t);
    // A directory in the way of the heartbeat file.
    await mkdir(f.paths.armed);
    await writeFile(f.paths.claimed, '{}', 'utf8');
    const result = await writeTurn(f.stateDir, f.meta, 1);
    f.clock.onSleep = async (count) => {
      if (count === 2) {
        await rm(f.paths.claimed);
      }
    };
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 2, reason: 'pushed', wake: wakeOf(f.meta, result) });
    const lines = await hookLogLines(f.stateDir);
    assert.deepEqual(lines.map((line) => [line.reason, line.code]), [
      ['armed-failed', 'EISDIR'],
      ['pushed', undefined],
    ]);
  });

  test('an unexpected error: exit 0, logged as internal with its code only', async (t) => {
    const f = await fixture(t, {}, {
      liveness: () => Promise.reject(Object.assign(new Error('proc hidden at /proc/1'), { code: 'EACCES' })),
    });
    await writeTurn(f.stateDir, f.meta, 1);
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 0, reason: 'internal', wake: null });
    assert.equal(existsSync(f.paths.pushed), false);
    const lines = await hookLogLines(f.stateDir);
    assert.deepEqual(lines.map((line) => [line.reason, line.code]), [['internal', 'EACCES']]);
    assert.doesNotMatch(JSON.stringify(lines), /proc hidden/);
  });
});

describe('pollTurn: secrets', () => {
  test('a secret set that cannot be built still pushes, redacted with none', async (t) => {
    const f = await fixture(t, {}, {
      secrets: () => {
        throw Object.assign(new Error('bad token'), { code: 'E_INVALID' });
      },
    });
    const result = await writeTurn(f.stateDir, f.meta, 1);
    const outcome = await pollTurn(f.turn, f.options);
    assert.deepEqual(outcome, { exitCode: 2, reason: 'pushed', wake: wakeOf(f.meta, result) });
    assert.deepEqual(await logReasons(f.stateDir), ['secrets-invalid', 'pushed']);
  });

  test('the same failure does not keep the expired notice back', async (t) => {
    const f = await fixture(t, {}, {
      deadlineMs: 2_000,
      secrets: () => {
        throw new Error('bad token');
      },
    });
    const outcome = await pollTurn(f.turn, f.options);
    assert.equal(outcome.reason, 'expired');
    assert.deepEqual(await logReasons(f.stateDir), ['secrets-invalid', 'expired']);
  });

  test('the secrets of the waiter environment are redacted from the wake text', async (t) => {
    const f = await fixture(t, {}, { env: { KIRO_API_KEY: SECRET } });
    await writeTurn(f.stateDir, f.meta, 1, null, { final: `The key is ${SECRET}.` });
    const outcome = await pollTurn(f.turn, f.options);
    assert.equal(outcome.reason, 'pushed');
    assert.doesNotMatch(outcome.wake ?? '', new RegExp(SECRET));
    assert.match(outcome.wake ?? '', /The key is /);
  });

  test('the api key option of the hook environment is redacted from the wake text', async (t) => {
    const f = await fixture(t, {}, { env: { CLAUDE_PLUGIN_OPTION_API_KEY: SECRET } });
    await writeTurn(f.stateDir, f.meta, 1, null, { final: `The key is ${SECRET}.` });
    const outcome = await pollTurn(f.turn, f.options);
    assert.equal(outcome.reason, 'pushed');
    assert.doesNotMatch(outcome.wake ?? '', new RegExp(SECRET));
    assert.match(outcome.wake ?? '', /The key is \[REDACTED\]\./);
  });

  test('waiterSecrets reads the api key option, the api key setting and KIRO_API_KEY', () => {
    const option = 'option-secret-value-1357924680';
    const other = 'another-secret-value-9876543210';
    const secrets = waiterSecrets({ CLAUDE_PLUGIN_OPTION_API_KEY: option, KIRO_SIDECAR_API_KEY: SECRET, KIRO_API_KEY: other });
    const redacted = secrets.redact(`${option}, ${SECRET} and ${other}`);
    assert.doesNotMatch(redacted, new RegExp(`${option}|${SECRET}|${other}`));
  });

  test('an api key option shorter than a Kiro token is still a secret', () => {
    const other = 'another-secret-value-9876543210';
    const secrets = waiterSecrets({ CLAUDE_PLUGIN_OPTION_API_KEY: 'short-key-1', KIRO_API_KEY: other });
    assert.equal(secrets.redact(`short-key-1 and ${other}`), '[REDACTED] and [REDACTED]');
  });
});

describe('parseDeadlineArg and turnLogIds', () => {
  test('accepts --deadline-s with a positive integer only', () => {
    assert.equal(parseDeadlineArg(['--deadline-s', '600']), 600);
    assert.equal(parseDeadlineArg(['--deadline-s', '1']), 1);
    for (const args of [
      [],
      ['--deadline-s'],
      ['--deadline-s', '0'],
      ['--deadline-s', '-5'],
      ['--deadline-s', '1.5'],
      ['--deadline-s', '07'],
      ['--deadline-s', ' 5'],
      ['--deadline-s', '9007199254740991'],
      ['--deadline-s=5'],
      ['--deadline', '5'],
      ['--deadline-s', '5', '--extra'],
    ]) {
      assert.equal(parseDeadlineArg(args), null, JSON.stringify(args));
    }
  });

  test('the ids leave out what the hook input did not give', async (t) => {
    const f = await fixture(t);
    assert.deepEqual(turnLogIds({ ...f.turn, toolUseId: null }), {
      sessionId: SESSION_ID,
      launchId: f.meta.launchId,
      turn: 1,
    });
  });
});
