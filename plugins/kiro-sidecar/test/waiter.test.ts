import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildWakeMessage } from '../src/hooks/wake.ts';
import type { Environment } from '../src/settings.ts';
import { ownerKey, processIdentity } from '../src/store/identity.ts';
import { turnPaths } from '../src/store/paths.ts';
import type { RunMeta } from '../src/store/runs.ts';
import { formatTurnTrailer } from '../src/text/format.ts';
import { SecretSet } from '../src/text/redact.ts';
import { tempDir } from './helpers/processes.ts';
import { hookLogLines, postToolUse, replyText } from './hooks/helpers.ts';
import { waitFor } from './session/manager-helpers.ts';
import { writeRun, writeTurn } from './session/helpers-runs.ts';

/** The waiter's entry point run from source; this test process is its parent, so its owner. */
const WAITER_PATH = fileURLToPath(new URL('../src/waiter.ts', import.meta.url));

interface Waiter {
  readonly pid: number;
  readonly stderr: string[];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(signal: NodeJS.Signals): void;
}

function startWaiter(t: TestContext, stateDir: string, args: readonly string[], input: unknown): Waiter {
  // A minimal environment: no secrets of the test run reach the waiter.
  const env: Environment = { PATH: process.env.PATH ?? '', CLAUDE_PLUGIN_DATA: stateDir };
  const child = spawn(process.execPath, [WAITER_PATH, ...args], { stdio: ['pipe', 'ignore', 'pipe'], env });
  const pid = child.pid;
  assert.ok(pid !== undefined, 'the waiter started');
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(JSON.stringify(input));
  return { pid, stderr, exited, kill: (signal) => child.kill(signal) };
}

/** A running turn of a run owned and driven by this test process. */
async function ownRun(stateDir: string): Promise<RunMeta> {
  const self = await processIdentity(process.pid);
  assert.ok(self !== null);
  return writeRun(stateDir, { ownerKey: ownerKey(self), driver: self, currentTurn: 1, state: 'running' });
}

function hookInput(meta: RunMeta): Record<string, unknown> {
  return postToolUse(replyText(formatTurnTrailer(meta.launchId, 1)));
}

describe('waiter.ts', () => {
  test('invalid arguments: exit 0, nothing on stderr, one log line', { timeout: 15_000 }, async (t) => {
    const stateDir = await tempDir(t);
    for (const args of [[], ['--deadline-s', '0'], ['--deadline-s', 'soon']]) {
      const waiter = startWaiter(t, stateDir, args, {});
      assert.deepEqual(await waiter.exited, { code: 0, signal: null });
      assert.equal(waiter.stderr.join(''), '');
    }
    const lines = await hookLogLines(stateDir);
    assert.deepEqual(
      lines.map((line) => [line.step, line.reason]),
      [
        ['input', 'bad-arguments'],
        ['input', 'bad-arguments'],
        ['input', 'bad-arguments'],
      ],
    );
  });

  test('a finished turn: exit 2 with the whole wake message on stderr', { timeout: 15_000 }, async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    // A final text longer than the message, so the message is cut to its limit.
    const final = Array.from({ length: 250 }, (_, index) => `Line ${index} of the review notes.`).join('\n');
    const result = await writeTurn(stateDir, meta, 1, final, { final });
    const expected = buildWakeMessage({ run: meta, result, agentType: null, secrets: new SecretSet() });
    assert.ok(expected.length > 5_000, `the message has ${expected.length} characters`);

    const waiter = startWaiter(t, stateDir, ['--deadline-s', '30'], hookInput(meta));

    assert.deepEqual(await waiter.exited, { code: 2, signal: null });
    assert.equal(waiter.stderr.join(''), expected);
    assert.ok(existsSync(turnPaths(stateDir, meta.launchId, 1).pushed));
    const lines = await hookLogLines(stateDir);
    assert.deepEqual(lines.map((line) => line.reason), ['pushed']);
  });

  test('SIGTERM while polling: exit 0 promptly, nothing on stderr, one log line', { timeout: 15_000 }, async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    const waiter = startWaiter(t, stateDir, ['--deadline-s', '60'], hookInput(meta));
    const armed = turnPaths(stateDir, meta.launchId, 1).armed;
    await waitFor(() => existsSync(armed), 'the first poll');

    const killedAt = performance.now();
    waiter.kill('SIGTERM');
    assert.deepEqual(await waiter.exited, { code: 0, signal: null });
    assert.ok(performance.now() - killedAt < 2_000, 'the waiter exits within 2 s of the signal');
    assert.equal(waiter.stderr.join(''), '');
    assert.equal(existsSync(turnPaths(stateDir, meta.launchId, 1).pushed), false);
    const lines = await hookLogLines(stateDir);
    assert.deepEqual(lines.map((line) => [line.step, line.reason, line.launchId]), [['turn', 'signal', meta.launchId]]);
  });

  test('SIGHUP and SIGINT stop it the same way', { timeout: 15_000 }, async (t) => {
    for (const signal of ['SIGHUP', 'SIGINT'] as const) {
      const stateDir = await tempDir(t);
      const meta = await ownRun(stateDir);
      const waiter = startWaiter(t, stateDir, ['--deadline-s', '60'], hookInput(meta));
      await waitFor(() => existsSync(turnPaths(stateDir, meta.launchId, 1).armed), 'the first poll');
      waiter.kill(signal);
      assert.deepEqual(await waiter.exited, { code: 0, signal: null }, signal);
      assert.equal(waiter.stderr.join(''), '');
      assert.deepEqual((await hookLogLines(stateDir)).map((line) => line.reason), ['signal']);
    }
  });

  test('the deadline passes with the turn still running: exit 2 with the expired notice', { timeout: 15_000 }, async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    const waiter = startWaiter(t, stateDir, ['--deadline-s', '1'], hookInput(meta));
    assert.deepEqual(await waiter.exited, { code: 2, signal: null });
    assert.match(waiter.stderr.join(''), /: push expired\n/);
    assert.equal(existsSync(turnPaths(stateDir, meta.launchId, 1).pushed), false);
    assert.deepEqual((await hookLogLines(stateDir)).map((line) => line.reason), ['expired']);
  });

  test('a run of another owner: exit 0 without polling', { timeout: 15_000 }, async (t) => {
    const stateDir = await tempDir(t);
    const meta = await writeRun(stateDir, { currentTurn: 1, state: 'running' });
    await writeTurn(stateDir, meta, 1);
    const waiter = startWaiter(t, stateDir, ['--deadline-s', '30'], hookInput(meta));
    assert.deepEqual(await waiter.exited, { code: 0, signal: null });
    assert.equal(waiter.stderr.join(''), '');
    assert.equal(existsSync(turnPaths(stateDir, meta.launchId, 1).armed), false);
    assert.deepEqual((await hookLogLines(stateDir)).map((line) => [line.step, line.reason]), [['owner', 'owner-mismatch']]);
  });
});
