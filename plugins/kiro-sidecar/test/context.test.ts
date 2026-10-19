import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONTEXT_HOW_TO } from '../src/hooks/context.ts';
import type { Environment } from '../src/settings.ts';
import { currentOwner, ownerKey, processIdentity } from '../src/store/identity.ts';
import { runsDir } from '../src/store/paths.ts';
import { readClaudeSessions } from '../src/store/runs.ts';
import type { RunMeta } from '../src/store/runs.ts';
import { REDACTED } from '../src/text/redact.ts';
import { tempDir } from './helpers/processes.ts';
import { NEW_SESSION_ID, sessionStart } from './hooks/context-helpers.ts';
import { hookLogLines } from './hooks/helpers.ts';
import { OWNER, writeRun, writeTurn } from './session/helpers-runs.ts';

/** The hook's entry point run from source; this test process is its parent, so its owner. */
const CONTEXT_PATH = fileURLToPath(new URL('../src/context.ts', import.meta.url));
const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TOKEN = 'planted-secret-fedcba9876543210';

interface HookRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runHook(t: TestContext, stateDir: string, input: string, extraEnv: Environment = {}): Promise<HookRun> {
  // A minimal environment: no secrets of the test run reach the hook.
  const env: Environment = { PATH: process.env.PATH ?? '', CLAUDE_PLUGIN_DATA: stateDir, ...extraEnv };
  const child = spawn(process.execPath, [CONTEXT_PATH], { stdio: ['pipe', 'pipe', 'pipe'], env });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => stdout.push(chunk));
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));
  const closed = new Promise<HookRun>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout: stdout.join(''), stderr: stderr.join('') }));
  });
  child.stdin.end(input);
  return closed;
}

/** A run owned and driven by this test process, the hook's parent. */
async function ownRun(stateDir: string, overrides: Partial<RunMeta> = {}): Promise<RunMeta> {
  const self = await processIdentity(process.pid);
  assert.ok(self !== null);
  return writeRun(stateDir, { ownerKey: ownerKey(self), driver: self, ...overrides });
}

describe('context.ts', () => {
  test('no runs: exit 0 with nothing on stdout or stderr', { timeout: 15_000 }, async (t) => {
    const stateDir = await tempDir(t);
    const result = await runHook(t, stateDir, JSON.stringify(sessionStart()));
    assert.deepEqual(result, { code: 0, signal: null, stdout: '', stderr: '' });
    assert.deepEqual(await hookLogLines(stateDir), []);
  });

  test('own live sessions: one JSON object on stdout, redacted, and the session recorded', { timeout: 15_000 }, async (t) => {
    const stateDir = await tempDir(t);
    const idle = await ownRun(stateDir, { label: `docs-${TOKEN}` });
    const running = await ownRun(stateDir, { label: null, state: 'running', currentTurn: 2, mode: 'local', dir: '/work/lib' });
    await writeTurn(stateDir, running, 1);
    // Owned by the process that runs this test file, not by this test process.
    const grandparent = await writeRun(stateDir, { ownerKey: ownerKey(await currentOwner()) });
    const other = await writeRun(stateDir, { ownerKey: OWNER, home: '' });
    const stopped = await ownRun(stateDir, { state: 'stopped' });

    const result = await runHook(t, stateDir, JSON.stringify(sessionStart('resume')), { CLAUDE_PLUGIN_OPTION_API_KEY: TOKEN });
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.endsWith('}\n'), 'one JSON object and a line break');
    assert.ok(!result.stdout.includes(TOKEN), 'the secret is not in the output');
    const value = JSON.parse(result.stdout) as { hookSpecificOutput: Record<string, unknown> };
    assert.deepEqual(value, {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: [
          '[kiro-sidecar] Live Kiro sessions owned by this Claude process: 2.',
          `- "docs-${REDACTED}" (${idle.launchId}, Kiro ${idle.kiroSessionId ?? ''}): dir /work/app, mode docker, state idle.`,
          `- ${running.launchId} (Kiro ${running.kiroSessionId ?? ''}): dir /work/lib, mode local, state running, current turn 2 (running).`,
          CONTEXT_HOW_TO,
        ].join('\n'),
      },
    });

    for (const meta of [idle, running]) {
      const entries = await readClaudeSessions(stateDir, meta.launchId);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.id, NEW_SESSION_ID);
      assert.equal(entries[0]?.event, 'resume');
      assert.match(entries[0]?.at ?? '', AT_PATTERN);
    }
    for (const meta of [grandparent, other, stopped]) {
      assert.deepEqual(await readClaudeSessions(stateDir, meta.launchId), []);
    }
    assert.deepEqual(await hookLogLines(stateDir), []);
  });

  test('invalid stdin: exit 0, nothing on stdout, one log line', { timeout: 15_000 }, async (t) => {
    const stateDir = await tempDir(t);
    const meta = await ownRun(stateDir);
    for (const input of ['{"source": "clear"', JSON.stringify(sessionStart('clear', { session_id: 7 }))]) {
      const result = await runHook(t, stateDir, input);
      assert.deepEqual(result, { code: 0, signal: null, stdout: '', stderr: '' });
    }
    const lines = await hookLogLines(stateDir);
    assert.deepEqual(
      lines.map((line) => [line.hook, line.step, line.reason]),
      [
        ['context', 'input', 'input-not-json'],
        ['context', 'input', 'input-invalid'],
      ],
    );
    assert.deepEqual(await readClaudeSessions(stateDir, meta.launchId), []);
  });

  test('an unexpected error: exit 0, nothing on stdout, an internal line', { timeout: 15_000 }, async (t) => {
    const stateDir = await tempDir(t);
    await writeFile(runsDir(stateDir), 'not a directory', 'utf8');
    const result = await runHook(t, stateDir, JSON.stringify(sessionStart()));
    assert.deepEqual(result, { code: 0, signal: null, stdout: '', stderr: '' });
    const lines = await hookLogLines(stateDir);
    assert.deepEqual(
      lines.map((line) => [line.hook, line.step, line.reason, line.code, line.sessionId]),
      [['context', 'session', 'internal', 'ENOTDIR', NEW_SESSION_ID]],
    );
  });
});
