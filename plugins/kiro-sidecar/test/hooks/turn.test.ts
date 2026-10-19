import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CALL_POLL_INTERVAL_MS,
  CALL_WAIT_MS,
  findTurn,
  lastLine,
  parseTurnTrailer,
  waitForCallTurn,
} from '../../src/hooks/turn.ts';
import { ensureDir, writeJsonAtomic } from '../../src/store/files.ts';
import { currentDriver } from '../../src/store/identity.ts';
import { callPath, callsDir } from '../../src/store/paths.ts';
import { recordCall, recordCallFailure } from '../../src/store/runs.ts';
import { formatResultLine, formatTurnTrailer } from '../../src/text/format.ts';
import { tempDir } from '../helpers/processes.ts';
import { FakeClock, TOOL_USE_ID, replyText } from './helpers.ts';

const LAUNCH_ID = 'ks_0123456789ab';
const OTHER_LAUNCH_ID = 'ks_ba9876543210';

describe('parseTurnTrailer', () => {
  test('reads the trailer the server writes', () => {
    for (const turn of [1, 2, 37, Number.MAX_SAFE_INTEGER]) {
      assert.deepEqual(parseTurnTrailer(replyText(formatTurnTrailer(LAUNCH_ID, turn))), {
        kind: 'trailer',
        ref: { launchId: LAUNCH_ID, turn },
      });
    }
  });

  test('one line break at the very end is allowed', () => {
    const trailer = formatTurnTrailer(LAUNCH_ID, 3);
    for (const text of [`${trailer}\n`, `{}\r\n${trailer}\r\n`, trailer]) {
      assert.deepEqual(parseTurnTrailer(text), { kind: 'trailer', ref: { launchId: LAUNCH_ID, turn: 3 } });
    }
    assert.deepEqual(parseTurnTrailer(`${trailer}\n\n`), { kind: 'absent' });
  });

  test('only the last line is read', () => {
    const trailer = formatTurnTrailer(LAUNCH_ID, 1);
    assert.deepEqual(parseTurnTrailer(`${trailer}\n{"state": "running"}`), { kind: 'absent' });
    assert.deepEqual(parseTurnTrailer(replyText(null)), { kind: 'absent' });
    assert.deepEqual(parseTurnTrailer(`${trailer}\n${formatResultLine(LAUNCH_ID, 1)}`), { kind: 'absent' });
    assert.deepEqual(parseTurnTrailer(''), { kind: 'absent' });
    assert.deepEqual(parseTurnTrailer(` ${trailer}`), { kind: 'absent' });
  });

  test('a malformed trailer is invalid', () => {
    const lines = [
      'kiro-turn: ks_../#1',
      'kiro-turn: ks_../../runs#1',
      'kiro-turn: ks_0123456789ab#0',
      'kiro-turn: ks_0123456789ab#01',
      'kiro-turn: ks_0123456789ab#1.5',
      'kiro-turn: ks_0123456789ab#-1',
      'kiro-turn: ks_0123456789ab#1e3',
      'kiro-turn: ks_0123456789ab#9007199254740992',
      'kiro-turn: ks_0123456789ab#99999999999999999999',
      'kiro-turn: ks_0123456789ab#',
      'kiro-turn: ks_0123456789ab',
      'kiro-turn: ks_0123456789ab#1#2',
      'kiro-turn: ks_0123456789ab#1 ',
      'kiro-turn: ks_0123456789AB#1',
      'kiro-turn: ks_0123456789a#1',
      'kiro-turn:ks_0123456789ab#1',
      'kiro-turn:  ks_0123456789ab#1',
      'kiro-turn: ks_0123456789ab #1',
      'kiro-turn: other_0123456789ab#1',
      'kiro-turn:',
    ];
    for (const line of lines) {
      assert.deepEqual(parseTurnTrailer(replyText(line)), { kind: 'invalid' }, line);
    }
  });

  test('lastLine', () => {
    assert.equal(lastLine('a\nb'), 'b');
    assert.equal(lastLine('a\nb\n'), 'b');
    assert.equal(lastLine('a\r\nb\r\n'), 'b');
    assert.equal(lastLine('a\n\n'), '');
    assert.equal(lastLine('single'), 'single');
  });
});

describe('waitForCallTurn', () => {
  test('polls every 2 s for up to 120 s', () => {
    assert.equal(CALL_POLL_INTERVAL_MS, 2_000);
    assert.equal(CALL_WAIT_MS, 120_000);
  });

  test('a record already there is read without waiting', async (t) => {
    const stateDir = await tempDir(t);
    await recordCall(stateDir, TOOL_USE_ID, { launchId: LAUNCH_ID, turn: 4, driver: await currentDriver() });
    const clock = new FakeClock();
    assert.deepEqual(await waitForCallTurn(stateDir, TOOL_USE_ID, clock), {
      kind: 'call',
      ref: { launchId: LAUNCH_ID, turn: 4 },
    });
    assert.deepEqual(clock.sleeps, []);
  });

  test('a record that appears after three polls is found', async (t) => {
    const stateDir = await tempDir(t);
    const driver = await currentDriver();
    const clock = new FakeClock();
    clock.onSleep = async (count) => {
      if (count === 3) {
        await recordCall(stateDir, TOOL_USE_ID, { launchId: LAUNCH_ID, turn: 2, driver });
      }
    };
    assert.deepEqual(await waitForCallTurn(stateDir, TOOL_USE_ID, clock), {
      kind: 'call',
      ref: { launchId: LAUNCH_ID, turn: 2 },
    });
    assert.deepEqual(clock.sleeps, [2_000, 2_000, 2_000]);
  });

  test('a record that never appears gives up after 120 s of simulated time', async (t) => {
    const stateDir = await tempDir(t);
    const clock = new FakeClock();
    const started = performance.now();
    assert.deepEqual(await waitForCallTurn(stateDir, TOOL_USE_ID, clock), {
      kind: 'skip',
      reason: 'call-not-found',
    });
    assert.equal(clock.slept, 120_000);
    assert.equal(clock.sleeps.length, 60);
    assert.ok(clock.sleeps.every((ms) => ms === 2_000));
    assert.ok(performance.now() - started < 1_000);
  });

  test('the last sleep is cut to the deadline', async (t) => {
    const stateDir = await tempDir(t);
    const clock = new FakeClock();
    const lookup = await waitForCallTurn(stateDir, TOOL_USE_ID, clock, { timeoutMs: 5_000 });
    assert.deepEqual(lookup, { kind: 'skip', reason: 'call-not-found' });
    assert.deepEqual(clock.sleeps, [2_000, 2_000, 1_000]);
  });

  test('a call that opened no turn gives none', async (t) => {
    const stateDir = await tempDir(t);
    await recordCall(stateDir, TOOL_USE_ID, { launchId: LAUNCH_ID, turn: null, driver: await currentDriver() });
    assert.deepEqual(await waitForCallTurn(stateDir, TOOL_USE_ID, new FakeClock()), {
      kind: 'skip',
      reason: 'no-turn',
    });
  });

  test('a failed call gives none', async (t) => {
    const stateDir = await tempDir(t);
    await recordCall(stateDir, TOOL_USE_ID, { launchId: LAUNCH_ID, turn: 1, driver: await currentDriver() });
    await recordCallFailure(stateDir, TOOL_USE_ID, 'Kiro exited before the session started');
    const clock = new FakeClock();
    assert.deepEqual(await waitForCallTurn(stateDir, TOOL_USE_ID, clock), {
      kind: 'skip',
      reason: 'call-failed',
    });
    assert.deepEqual(clock.sleeps, []);
  });

  test('a malformed record is skipped, not thrown', async (t) => {
    const stateDir = await tempDir(t);
    await ensureDir(callsDir(stateDir));
    await writeFile(callPath(stateDir, TOOL_USE_ID), '{"launchId": "ks_', 'utf8');
    const lookup = await waitForCallTurn(stateDir, TOOL_USE_ID, new FakeClock());
    assert.equal(lookup.kind === 'skip' ? lookup.reason : null, 'call-unreadable');
    await writeJsonAtomic(callPath(stateDir, TOOL_USE_ID), { launchId: 'ks_../x', turn: 1 });
    const shaped = await waitForCallTurn(stateDir, TOOL_USE_ID, new FakeClock());
    assert.equal(shaped.kind === 'skip' ? shaped.reason : null, 'call-unreadable');
  });

  test('an invalid tool use id reads no file', async (t) => {
    const stateDir = await tempDir(t);
    const driver = await currentDriver();
    const record = { launchId: LAUNCH_ID, turn: 1, driver };
    // Files an unchecked id would reach: calls/../planted.json and calls/<129 x>.json.
    await ensureDir(callsDir(stateDir));
    await writeJsonAtomic(join(stateDir, 'planted.json'), record);
    const long = 'x'.repeat(129);
    await writeJsonAtomic(join(callsDir(stateDir), `${long}.json`), record);
    for (const id of ['../planted', long, 'a.b', 'a/b', '', null]) {
      const clock = new FakeClock();
      assert.deepEqual(
        await waitForCallTurn(stateDir, id, clock),
        { kind: 'skip', reason: 'tool-use-id-invalid' },
        String(id),
      );
      assert.deepEqual(clock.sleeps, []);
    }
  });
});

describe('findTurn', () => {
  test('a trailer wins and the calls record is not read', async (t) => {
    const stateDir = await tempDir(t);
    await recordCall(stateDir, TOOL_USE_ID, { launchId: OTHER_LAUNCH_ID, turn: 9, driver: await currentDriver() });
    const lookup = await findTurn(stateDir, replyText(formatTurnTrailer(LAUNCH_ID, 2)), TOOL_USE_ID, new FakeClock());
    assert.deepEqual(lookup, { kind: 'turn', ref: { launchId: LAUNCH_ID, turn: 2 }, source: 'trailer' });
  });

  test('without a trailer the calls record names the turn', async (t) => {
    const stateDir = await tempDir(t);
    await recordCall(stateDir, TOOL_USE_ID, { launchId: OTHER_LAUNCH_ID, turn: 9, driver: await currentDriver() });
    const expected = { kind: 'turn', ref: { launchId: OTHER_LAUNCH_ID, turn: 9 }, source: 'call' };
    for (const text of [
      replyText(null),
      `${formatTurnTrailer(LAUNCH_ID, 1)}\n{"state": "running"}`,
      'Running in the background',
      null,
    ]) {
      assert.deepEqual(await findTurn(stateDir, text, TOOL_USE_ID, new FakeClock()), expected, String(text));
    }
  });

  test('a malformed trailer gives no turn even with a calls record', async (t) => {
    const stateDir = await tempDir(t);
    await recordCall(stateDir, TOOL_USE_ID, { launchId: LAUNCH_ID, turn: 1, driver: await currentDriver() });
    for (const line of ['kiro-turn: ks_../#1', 'kiro-turn: ks_0123456789ab#0', 'kiro-turn: ks_0123456789ab#1.5']) {
      const clock = new FakeClock();
      assert.deepEqual(
        await findTurn(stateDir, replyText(line), TOOL_USE_ID, clock),
        { kind: 'skip', reason: 'trailer-invalid' },
        line,
      );
      assert.deepEqual(clock.sleeps, []);
    }
  });
});
