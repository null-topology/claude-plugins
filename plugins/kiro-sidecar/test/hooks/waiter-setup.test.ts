import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { hooksLogPath } from '../../src/hooks/log.ts';
import { pollTurn } from '../../src/hooks/waiter-loop.ts';
import { sessionEvent, setUpWaiter } from '../../src/hooks/waiter-setup.ts';
import type { WaiterSetupOptions } from '../../src/hooks/waiter-setup.ts';
import { ensureDir, writeJsonAtomic } from '../../src/store/files.ts';
import { currentDriver, currentOwner, ownerKey } from '../../src/store/identity.ts';
import { callsDir, runPaths } from '../../src/store/paths.ts';
import { readClaudeSessions, recordCall, recordCallFailure } from '../../src/store/runs.ts';
import type { RunMeta } from '../../src/store/runs.ts';
import { formatTurnTrailer } from '../../src/text/format.ts';
import { tempDir } from '../helpers/processes.ts';
import { OWNER, writeRun, writeTurn } from '../session/helpers-runs.ts';
import {
  FakeClock,
  SEND_TOOL,
  SESSION_ID,
  TOOL_USE_ID,
  filesHolding,
  hookLogLines,
  inputStream,
  postToolUse,
  replyText,
} from './helpers.ts';

const LOG_KEYS = new Set(['at', 'hook', 'step', 'reason', 'launchId', 'turn', 'toolUseId', 'sessionId', 'agentId', 'code']);
const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const CLOCK_AT = '2026-10-18T01:00:00Z';

/** A run owned by this test's parent process, the owner a hook computes by default. */
async function ownRun(stateDir: string, overrides: Partial<RunMeta> = {}): Promise<RunMeta> {
  return writeRun(stateDir, { ownerKey: ownerKey(await currentOwner()), currentTurn: 1, state: 'running', ...overrides });
}

function run(stateDir: string, input: unknown, options: WaiterSetupOptions = {}) {
  const clock = options.clock ?? new FakeClock();
  return setUpWaiter({ stdin: inputStream(input), stateDir, clock, ...options });
}

function assertSafeLogLine(line: Record<string, unknown>): void {
  for (const key of Object.keys(line)) {
    assert.ok(LOG_KEYS.has(key), `unexpected key ${key}`);
  }
  assert.match(String(line.at), AT_PATTERN);
  assert.equal(line.hook, 'waiter');
}

describe('setUpWaiter: finding the turn', () => {
  test('a trailer names the turn; the session is recorded and nothing is logged', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    const result = await run(stateDir, postToolUse(replyText(formatTurnTrailer(meta.launchId, 1))));
    assert.deepEqual(result, {
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
    });
    assert.deepEqual(await readClaudeSessions(stateDir, meta.launchId), [
      { id: SESSION_ID, event: 'start', at: CLOCK_AT },
    ]);
    assert.deepEqual(await hookLogLines(stateDir), []);
  });

  test('a string tool_response is read like a text block', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    const result = await run(
      stateDir,
      postToolUse(null, { tool_response: replyText(formatTurnTrailer(meta.launchId, 1)) }),
    );
    assert.equal(result.kind, 'turn');
    assert.equal(result.kind === 'turn' ? result.source : null, 'trailer');
  });

  test('a backgrounded call is found through its calls record after a few polls', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir, { currentTurn: 2 });
    const clock = new FakeClock();
    clock.onSleep = async (count) => {
      if (count === 2) {
        await recordCall(stateDir, TOOL_USE_ID, { launchId: meta.launchId, turn: 2, driver: meta.driver });
      }
    };
    const result = await run(stateDir, postToolUse('Running in the background'), { clock });
    assert.equal(result.kind, 'turn');
    if (result.kind === 'turn') {
      assert.equal(result.source, 'call');
      assert.equal(result.launchId, meta.launchId);
      assert.equal(result.turn, 2);
    }
    assert.deepEqual(clock.sleeps, [2_000, 2_000]);
    assert.equal((await readClaudeSessions(stateDir, meta.launchId)).length, 1);
  });

  test('no record within 120 s is a logged skip, in simulated time', async (t) => {
    const stateDir = await tempDir(t);
    const clock = new FakeClock();
    const started = performance.now();
    const result = await run(stateDir, postToolUse(replyText(null)), { clock });
    assert.deepEqual(result, { kind: 'skip', step: 'turn', reason: 'call-not-found' });
    assert.equal(clock.slept, 120_000);
    assert.ok(performance.now() - started < 1_000);
    const lines = await hookLogLines(stateDir);
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0], {
      at: '2026-10-18T01:02:00Z',
      hook: 'waiter',
      step: 'turn',
      reason: 'call-not-found',
      toolUseId: TOOL_USE_ID,
      sessionId: SESSION_ID,
    });
  });

  test('a start without a prompt and a failed call are skipped', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    await recordCall(stateDir, TOOL_USE_ID, { launchId: meta.launchId, turn: null, driver: meta.driver });
    assert.deepEqual(await run(stateDir, postToolUse(replyText(null))), {
      kind: 'skip',
      step: 'turn',
      reason: 'no-turn',
    });
    await recordCallFailure(stateDir, TOOL_USE_ID, 'The start was aborted');
    assert.deepEqual(await run(stateDir, postToolUse('Error: the start was aborted')), {
      kind: 'skip',
      step: 'turn',
      reason: 'call-failed',
    });
    assert.deepEqual(await readClaudeSessions(stateDir, meta.launchId), []);
    assert.deepEqual(
      (await hookLogLines(stateDir)).map((line) => line.reason),
      ['no-turn', 'call-failed'],
    );
  });

  test('an invalid tool_use_id reads no file and is not logged', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    const record = { launchId: meta.launchId, turn: 1, driver: meta.driver };
    await ensureDir(callsDir(stateDir));
    await writeJsonAtomic(join(stateDir, 'planted.json'), record);
    const long = 'x'.repeat(129);
    await writeJsonAtomic(join(callsDir(stateDir), `${long}.json`), record);
    for (const id of ['../planted', long]) {
      const clock = new FakeClock();
      const result = await run(stateDir, postToolUse(replyText(null), { tool_use_id: id }), { clock });
      assert.deepEqual(result, { kind: 'skip', step: 'turn', reason: 'tool-use-id-invalid' });
      assert.deepEqual(clock.sleeps, []);
    }
    const lines = await hookLogLines(stateDir);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assertSafeLogLine(line);
      assert.equal(line.toolUseId, undefined);
    }
    assert.deepEqual(await readClaudeSessions(stateDir, meta.launchId), []);
  });

  test('an invalid launch id or turn in a trailer is skipped', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    await recordCall(stateDir, TOOL_USE_ID, { launchId: meta.launchId, turn: 1, driver: meta.driver });
    for (const line of [
      'kiro-turn: ks_../#1',
      `kiro-turn: ${meta.launchId}#0`,
      `kiro-turn: ${meta.launchId}#1.5`,
      `kiro-turn: ${meta.launchId}#99999999999999999999`,
    ]) {
      assert.deepEqual(
        await run(stateDir, postToolUse(replyText(line))),
        { kind: 'skip', step: 'turn', reason: 'trailer-invalid' },
        line,
      );
    }
    assert.deepEqual(await readClaudeSessions(stateDir, meta.launchId), []);
  });

  test('a trailer that is not on the last line is not used', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir, { currentTurn: 3 });
    await recordCall(stateDir, TOOL_USE_ID, { launchId: meta.launchId, turn: 3, driver: meta.driver });
    const text = `${formatTurnTrailer(meta.launchId, 1)}\n${replyText(null)}`;
    const result = await run(stateDir, postToolUse(text));
    assert.equal(result.kind === 'turn' ? `${result.source}:${result.turn}` : result.reason, 'call:3');
  });

  test('a trailer naming a run that does not exist is skipped', async (t) => {
    const stateDir = await tempDir(t);
    const result = await run(stateDir, postToolUse(replyText(formatTurnTrailer('ks_00000000beef', 1))));
    assert.deepEqual(result, { kind: 'skip', step: 'owner', reason: 'run-not-found' });
    assert.deepEqual(await hookLogLines(stateDir), [
      {
        at: CLOCK_AT,
        hook: 'waiter',
        step: 'owner',
        reason: 'run-not-found',
        launchId: 'ks_00000000beef',
        turn: 1,
        toolUseId: TOOL_USE_ID,
        sessionId: SESSION_ID,
      },
    ]);
  });

  test('a malformed meta.json is skipped', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    await writeFile(runPaths(stateDir, meta.launchId).meta, '{"launchId": ', 'utf8');
    const result = await run(stateDir, postToolUse(replyText(formatTurnTrailer(meta.launchId, 1))));
    assert.deepEqual(result, { kind: 'skip', step: 'owner', reason: 'meta-unreadable' });
  });
});

describe('setUpWaiter: hook input', () => {
  test('oversize input is a logged skip', async (t) => {
    const stateDir = await tempDir(t);
    const input = postToolUse(replyText('x'.repeat(4096)));
    const result = await run(stateDir, input, { maxInputBytes: 1024 });
    assert.deepEqual(result, { kind: 'skip', step: 'input', reason: 'input-too-large' });
    assert.deepEqual(await hookLogLines(stateDir), [
      { at: CLOCK_AT, hook: 'waiter', step: 'input', reason: 'input-too-large' },
    ]);
  });

  test('malformed and invalid input are logged skips', async (t) => {
    const stateDir = await tempDir(t);
    const malformed = await setUpWaiter({
      stdin: Readable.from(['{"session_id": "abc", "tool_response": [']),
      stateDir,
      clock: new FakeClock(),
    });
    assert.deepEqual(malformed, { kind: 'skip', step: 'input', reason: 'input-not-json' });
    assert.deepEqual(await run(stateDir, ['not', 'an', 'object']), {
      kind: 'skip',
      step: 'input',
      reason: 'input-invalid',
    });
    assert.deepEqual(await run(stateDir, postToolUse('reply', { session_id: '../x' })), {
      kind: 'skip',
      step: 'input',
      reason: 'input-invalid',
    });
    const lines = await hookLogLines(stateDir);
    assert.deepEqual(
      lines.map((line) => line.reason),
      ['input-not-json', 'input-invalid', 'input-invalid'],
    );
    for (const line of lines) {
      assertSafeLogLine(line);
      assert.equal(line.sessionId, undefined);
    }
  });

  test('the state directory comes from CLAUDE_PLUGIN_DATA', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    const result = await setUpWaiter({
      stdin: inputStream(postToolUse(replyText(formatTurnTrailer(meta.launchId, 1)))),
      env: { CLAUDE_PLUGIN_DATA: stateDir },
      clock: new FakeClock(),
    });
    assert.equal(result.kind === 'turn' ? result.stateDir : null, stateDir);
  });

  test('hooks.log holds no tool text, prompt or error message', async (t) => {
    const stateDir = await tempDir(t);
    const secretText = 'SENTINEL-TOOL-TEXT-7f3a';
    const secretPrompt = 'SENTINEL-PROMPT-9c2e';
    await run(
      stateDir,
      postToolUse(`${secretText}\nkiro-turn: ks_../#1`, { tool_input: { prompt: secretPrompt } }),
    );
    await setUpWaiter({
      stdin: Readable.from([`{"session_id": "${secretText}`]),
      stateDir,
      clock: new FakeClock(),
    });
    await ensureDir(callsDir(stateDir));
    await writeFile(join(callsDir(stateDir), `${TOOL_USE_ID}.json`), `{"launchId": "${secretText}`, 'utf8');
    await run(stateDir, postToolUse(secretText, { tool_input: { prompt: secretPrompt } }));
    const text = await readFile(hooksLogPath(stateDir), 'utf8');
    assert.ok(!text.includes('SENTINEL'), text);
    const lines = await hookLogLines(stateDir);
    assert.deepEqual(
      lines.map((line) => line.reason),
      ['trailer-invalid', 'input-not-json', 'call-unreadable'],
    );
    lines.forEach(assertSafeLogLine);
    assert.equal((await stat(hooksLogPath(stateDir))).mode & 0o777, 0o600);
  });
});

describe('setUpWaiter: ids that hold a secret', () => {
  const secret = 'planted-secret-value-0123456789';
  const env = { CLAUDE_PLUGIN_OPTION_API_KEY: secret };
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ['session_id', { session_id: secret }],
    ['agent_id', { agent_id: `agent-${secret}` }],
    ['agent_type', { agent_id: 'a1b2c3d4e5', agent_type: `plugin:${secret}` }],
    ['tool_use_id', { tool_use_id: `toolu_${secret}` }],
  ];

  for (const [field, overrides] of cases) {
    test(`${field} that redaction would change: a skip that writes no id`, async (t) => {
      const stateDir = await tempDir(t);
      const meta = await ownRun(stateDir);
      await writeTurn(stateDir, meta, 1);
      const result = await run(stateDir, postToolUse(replyText(formatTurnTrailer(meta.launchId, 1)), overrides), { env });
      if (result.kind === 'turn') {
        // What the waiter does next with a turn it found.
        await pollTurn(result, { deadlineMs: 2_000, clock: new FakeClock(), env, liveness: () => Promise.resolve('alive') });
      }
      assert.deepEqual(await filesHolding(stateDir, secret), []);
      assert.deepEqual(result, { kind: 'skip', step: 'input', reason: 'input-secret' });
      const lines = await hookLogLines(stateDir);
      assert.equal(lines.length, 1);
      lines.forEach(assertSafeLogLine);
      assert.deepEqual(Object.keys(lines[0] ?? {}), ['at', 'hook', 'step', 'reason']);
      assert.deepEqual(await readClaudeSessions(stateDir, meta.launchId), []);
    });
  }
});

describe('setUpWaiter: owner check', () => {
  test('a run of this hook parent process passes', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    const result = await run(stateDir, postToolUse(replyText(formatTurnTrailer(meta.launchId, 1))));
    assert.equal(result.kind, 'turn');
  });

  test('an injected owner is compared the same way', async (t) => {
    const stateDir = await tempDir(t);
    const driver = await currentDriver();
    const meta = await ownRun(stateDir, { ownerKey: ownerKey(driver) });
    const result = await run(stateDir, postToolUse(replyText(formatTurnTrailer(meta.launchId, 1))), {
      owner: async () => driver,
    });
    assert.equal(result.kind, 'turn');
  });

  test("another owner's run is a logged skip and records no session", async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir, { ownerKey: OWNER });
    const result = await run(
      stateDir,
      postToolUse(replyText(formatTurnTrailer(meta.launchId, 1)), { agent_id: 'a1b2c3d4e5', agent_type: 'Explore' }),
    );
    assert.deepEqual(result, { kind: 'skip', step: 'owner', reason: 'owner-mismatch' });
    assert.deepEqual(await readClaudeSessions(stateDir, meta.launchId), []);
    assert.deepEqual(await hookLogLines(stateDir), [
      {
        at: CLOCK_AT,
        hook: 'waiter',
        step: 'owner',
        reason: 'owner-mismatch',
        launchId: meta.launchId,
        turn: 1,
        toolUseId: TOOL_USE_ID,
        sessionId: SESSION_ID,
        agentId: 'a1b2c3d4e5',
      },
    ]);
  });

  test('an owner that cannot be read is a logged skip', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    const result = await run(stateDir, postToolUse(replyText(formatTurnTrailer(meta.launchId, 1))), {
      owner: async () => {
        throw Object.assign(new Error('Process 1 is not running'), { code: 'ESRCH' });
      },
    });
    assert.deepEqual(result, { kind: 'skip', step: 'owner', reason: 'owner-unknown' });
    const [line] = await hookLogLines(stateDir);
    assert.equal(line?.code, 'ESRCH');
    assert.equal(line?.reason, 'owner-unknown');
  });
});

describe('setUpWaiter: claude-sessions.jsonl', () => {
  test('a subagent call records its agent type; the event names the tool', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir, { currentTurn: 2 });
    const result = await run(
      stateDir,
      postToolUse(replyText(formatTurnTrailer(meta.launchId, 2)), {
        tool_name: SEND_TOOL,
        agent_id: 'a1b2c3d4e5',
        agent_type: 'code-reviewer',
      }),
    );
    assert.equal(result.kind, 'turn');
    if (result.kind === 'turn') {
      assert.equal(result.agentType, 'code-reviewer');
      assert.equal(result.agentId, 'a1b2c3d4e5');
    }
    assert.deepEqual(await readClaudeSessions(stateDir, meta.launchId), [
      { id: SESSION_ID, event: 'send', at: CLOCK_AT, agentType: 'code-reviewer' },
    ]);
    const raw = await readFile(runPaths(stateDir, meta.launchId).claudeSessions, 'utf8');
    assert.equal(raw, `{"id":"${SESSION_ID}","event":"send","at":"${CLOCK_AT}","agentType":"code-reviewer"}\n`);
  });

  test('a main-conversation call records no agent type', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    await run(stateDir, postToolUse(replyText(formatTurnTrailer(meta.launchId, 1))));
    const raw = await readFile(runPaths(stateDir, meta.launchId).claudeSessions, 'utf8');
    assert.equal(raw, `{"id":"${SESSION_ID}","event":"start","at":"${CLOCK_AT}"}\n`);
  });

  test('an agent type outside its pattern is dropped and logged; the turn goes on', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    const result = await run(
      stateDir,
      postToolUse(replyText(formatTurnTrailer(meta.launchId, 1)), { agent_type: 'two words\n' }),
    );
    assert.equal(result.kind === 'turn' ? result.agentType : 'skip', null);
    assert.deepEqual(await readClaudeSessions(stateDir, meta.launchId), [
      { id: SESSION_ID, event: 'start', at: CLOCK_AT },
    ]);
    assert.deepEqual(
      (await hookLogLines(stateDir)).map((line) => `${String(line.step)}:${String(line.reason)}`),
      ['input:agent-type-invalid'],
    );
  });

  test('a session line that cannot be written is logged and the turn goes on', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    await mkdir(runPaths(stateDir, meta.launchId).claudeSessions);
    const result = await run(stateDir, postToolUse(replyText(formatTurnTrailer(meta.launchId, 1))));
    assert.equal(result.kind, 'turn');
    const [line] = await hookLogLines(stateDir);
    assert.equal(line?.step, 'session');
    assert.equal(line?.reason, 'session-log-failed');
    assert.equal(line?.code, 'EISDIR');
  });

  test('sessionEvent', () => {
    assert.equal(sessionEvent('mcp__plugin_kiro-sidecar_kiro__start'), 'start');
    assert.equal(sessionEvent('mcp__plugin_kiro-sidecar_kiro__send'), 'send');
    assert.equal(sessionEvent('mcp__plugin_kiro-sidecar_kiro__wait'), 'post_tool_use');
    assert.equal(sessionEvent(null), 'post_tool_use');
  });
});
