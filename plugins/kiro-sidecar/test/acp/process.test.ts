import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { spawnProcess } from '../../src/acp/process.ts';
import { LOCAL_KIRO_ARGS, buildLocalEnvironment, localKiroSpec } from '../../src/acp/local.ts';
import { startFakeKiro } from '../helpers/fake-kiro.ts';
import { tempDir } from '../helpers/processes.ts';

const PROCESS_TIMEOUT = { timeout: 15_000 };

/** A server environment with every allowlisted name, the proxies, and names that must not pass. */
const SERVER_ENV = Object.freeze({
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  HOME: '/home/tester',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  LC_TIME: 'C',
  TERM: 'xterm-256color',
  TMPDIR: '/tmp',
  KIRO_HOME: '/home/tester/.kiro',
  KIRO_API_KEY: 'test-api-key',
  HTTP_PROXY: 'http://proxy.example.test:3128',
  HTTPS_PROXY: 'http://proxy.example.test:3128',
  NO_PROXY: '',
  http_proxy: 'http://proxy.example.test:3128',
  https_proxy: 'http://proxy.example.test:3128',
  no_proxy: 'localhost,127.0.0.1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_API_KEY: 'must-not-pass',
  CLAUDECODE: '1',
  KIRO_SIDECAR_API_KEY: 'must-not-pass',
  AWS_PROFILE: 'must-not-pass',
  NODE_OPTIONS: '--max-old-space-size=64',
  UNSET_VALUE: undefined,
});

const ALLOWED = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_TIME',
  'TERM',
  'TMPDIR',
  'KIRO_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
].sort();

describe('buildLocalEnvironment', () => {
  test('keeps exactly the allowlisted names, LC_* and the set proxies, unchanged', () => {
    const env = buildLocalEnvironment(SERVER_ENV);
    assert.deepEqual(Object.keys(env).sort(), ALLOWED);
    for (const name of ALLOWED) {
      assert.equal(env[name], SERVER_ENV[name as keyof typeof SERVER_ENV], name);
    }
  });

  test("never copies the server's own KIRO_API_KEY", () => {
    assert.equal(buildLocalEnvironment(SERVER_ENV)['KIRO_API_KEY'], undefined);
    assert.equal(buildLocalEnvironment(SERVER_ENV, { KIRO_HOME: '/runs/view' })['KIRO_API_KEY'], undefined);
  });

  test('passes no proxy that is not set, and strips every CLAUDE_* name', () => {
    const env = buildLocalEnvironment({ PATH: '/bin', CLAUDE_CODE_SSE_PORT: '1', CLAUDE_: 'x' });
    assert.deepEqual(env, { PATH: '/bin' });
  });

  test('overrides set KIRO_HOME and KIRO_API_KEY', () => {
    const env = buildLocalEnvironment(SERVER_ENV, { KIRO_HOME: '/runs/view', KIRO_API_KEY: 'token' });
    assert.equal(env['KIRO_HOME'], '/runs/view');
    assert.equal(env['KIRO_API_KEY'], 'token');
  });

  test('a proxy override replaces the inherited value and leaves the others', () => {
    const env = buildLocalEnvironment(SERVER_ENV, {
      proxy: { https_proxy: 'http://127.0.0.1:10817', no_proxy: '.internal.example' },
    });
    assert.equal(env['https_proxy'], 'http://127.0.0.1:10817');
    assert.equal(env['no_proxy'], '.internal.example');
    assert.equal(env['HTTP_PROXY'], SERVER_ENV.HTTP_PROXY);
    assert.deepEqual(Object.keys(env).sort(), ALLOWED);
  });

  test('a proxy override is passed even when the server has no proxy', () => {
    const env = buildLocalEnvironment({ PATH: '/bin' }, { proxy: { HTTPS_PROXY: 'http://proxy.example:3128' } });
    assert.deepEqual(env, { PATH: '/bin', HTTPS_PROXY: 'http://proxy.example:3128' });
  });
});

describe('localKiroSpec', () => {
  test('runs kiro_command with acp --agent-engine v3 in dir', () => {
    const spec = localKiroSpec({ kiroCommand: 'kiro-cli', dir: '/work', serverEnv: SERVER_ENV });
    assert.deepEqual(spec.argv, ['kiro-cli', 'acp', '--agent-engine', 'v3']);
    assert.equal(spec.cwd, '/work');
    assert.deepEqual(Object.keys(spec.env).sort(), ALLOWED);
    assert.equal(spec.processGroup, true);
  });

  test('rejects an empty command', () => {
    assert.throws(() => localKiroSpec({ kiroCommand: '', dir: '/work', serverEnv: {} }), TypeError);
  });

  test('the spawned child sees the argv, cwd and filtered environment', PROCESS_TIMEOUT, async (t) => {
    const fake = await startFakeKiro(t, 'idle', { serverEnv: SERVER_ENV });
    await fake.client.initialize({ timeoutMs: 10_000 });
    const started = await fake.started();
    assert.deepEqual(started.argv, [...LOCAL_KIRO_ARGS]);
    assert.equal(started.cwd, await realpath(fake.dir));
    // macOS adds __CF_USER_TEXT_ENCODING to the environment of every process it starts.
    const seen = Object.keys(started.env).filter((name) => name !== '__CF_USER_TEXT_ENCODING');
    assert.deepEqual(seen.sort(), ALLOWED);
    assert.equal(Object.keys(started.env).some((name) => name.startsWith('CLAUDE')), false);
    assert.equal(started.env['NO_PROXY'], '');
    assert.equal(started.env['no_proxy'], 'localhost,127.0.0.1');
  });
});

/**
 * A child that starts a grandchild (one that ignores SIGTERM when the first
 * argument is `ignore-term`), prints the grandchild's pid once the grandchild
 * is ready, and exits when its stdin ends, leaving the grandchild running.
 */
const LEAVES_GRANDCHILD = [
  "const { spawn } = require('node:child_process');",
  "const ignore = process.argv[1] === 'ignore-term' ? \"process.on('SIGTERM', () => {});\" : '';",
  "const script = ignore + \"process.stdout.write('ready\\\\n'); setInterval(() => {}, 60_000);\";",
  "const grandchild = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });",
  "grandchild.stdout.once('data', () => process.stdout.write(grandchild.pid + '\\n'));",
  "process.stdin.on('end', () => process.exit(0));",
  'process.stdin.resume();',
].join('\n');

async function spawnWithGrandchild(t: TestContext, options: { ignoreTerm?: boolean; graceMs?: number } = {}) {
  const dir = await tempDir(t);
  const handle = spawnProcess(
    {
      argv: [process.execPath, '-e', LEAVES_GRANDCHILD, options.ignoreTerm === true ? 'ignore-term' : 'plain'],
      env: {},
      cwd: dir,
      processGroup: true,
    },
    { killGraceMs: options.graceMs ?? 5_000 },
  );
  const grandchild = await new Promise<number>((resolve) => {
    handle.stdout.once('data', (data: Buffer) => resolve(Number(data.toString().trim())));
  });
  t.after(() => {
    if (!isGone(grandchild)) {
      process.kill(grandchild, 'SIGKILL');
    }
  });
  return { handle, grandchild };
}

/** True when `pid` has ended: no such process, or a zombie nobody has reaped yet. */
function isGone(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }
}

async function waitGone(pid: number, timeoutMs: number): Promise<number> {
  const started = performance.now();
  while (!isGone(pid)) {
    if (performance.now() - started > timeoutMs) {
      assert.fail(`process ${pid} still runs after ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return performance.now() - started;
}

describe('ProcessHandle: a process group leader', () => {
  test('kill() ends the leader and every process it started', PROCESS_TIMEOUT, async (t) => {
    const { handle, grandchild } = await spawnWithGrandchild(t);
    assert.equal(isGone(grandchild), false);
    const exit = await handle.kill(2_000);
    assert.equal(exit.signal, 'SIGTERM');
    await waitGone(grandchild, 2_000);
  });

  test('kill() escalates to SIGKILL for a process that ignores SIGTERM', PROCESS_TIMEOUT, async (t) => {
    const { handle, grandchild } = await spawnWithGrandchild(t, { ignoreTerm: true, graceMs: 300 });
    await handle.kill(300);
    const elapsed = await waitGone(grandchild, 3_000);
    t.diagnostic(`the grandchild was gone ${Math.round(elapsed)} ms after the leader`);
  });

  test('when the leader exits after stdin is closed, what it started is ended too', PROCESS_TIMEOUT, async (t) => {
    const { handle, grandchild } = await spawnWithGrandchild(t);
    handle.stdin.end();
    assert.deepEqual(await handle.exited, { code: 0, signal: null });
    await waitGone(grandchild, 2_000);
  });

  test('a process left by the leader that ignores SIGTERM gets SIGKILL after the grace', PROCESS_TIMEOUT, async (t) => {
    const { handle, grandchild } = await spawnWithGrandchild(t, { ignoreTerm: true, graceMs: 300 });
    handle.stdin.end();
    await handle.exited;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(isGone(grandchild), false, 'SIGTERM alone does not end it');
    await waitGone(grandchild, 3_000);
  });
});

describe('ProcessHandle', () => {
  test('kill() escalates to SIGKILL when SIGTERM is ignored', PROCESS_TIMEOUT, async (t) => {
    const dir = await tempDir(t);
    const handle = spawnProcess({
      argv: [
        process.execPath,
        '-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 60_000);",
      ],
      env: {},
      cwd: dir,
    });
    await new Promise<void>((resolve) => handle.stdout.once('data', () => resolve()));
    const started = performance.now();
    const exit = await handle.kill(300);
    const elapsed = performance.now() - started;
    assert.equal(exit.signal, 'SIGKILL');
    assert.equal(exit.code, null);
    assert.ok(elapsed >= 250, `escalated after ${elapsed} ms`);
    assert.equal(handle.exit, exit);
  });

  test('kill() ends a cooperative child with SIGTERM and is idempotent', PROCESS_TIMEOUT, async (t) => {
    const dir = await tempDir(t);
    const handle = spawnProcess({ argv: [process.execPath, '-e', 'setInterval(() => {}, 60_000)'], env: {}, cwd: dir });
    const [first, second] = await Promise.all([handle.kill(5_000), handle.kill(5_000)]);
    assert.equal(first.signal, 'SIGTERM');
    assert.equal(second, first);
    assert.equal(await handle.kill(), first);
  });

  test('forwards stderr as raw byte chunks, long lines uncut, and reports the exit code', PROCESS_TIMEOUT, async (t) => {
    const dir = await tempDir(t);
    const written = `first\r\n${'y'.repeat(20_000)} é✓\nthird`;
    const expected = Buffer.from(written, 'utf8');
    const chunks: Buffer[] = [];
    const handle = spawnProcess(
      {
        argv: [process.execPath, '-e', 'process.stderr.write(process.argv[1]); process.exitCode = 4;', written],
        env: {},
        cwd: dir,
      },
      { onStderr: (chunk) => chunks.push(chunk) },
    );
    const exit = await handle.exited;
    assert.equal(exit.code, 4);
    assert.equal(exit.signal, null);
    const deadline = performance.now() + 2_000;
    while (Buffer.concat(chunks).length < expected.length && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(chunks.every((chunk) => Buffer.isBuffer(chunk)), 'every chunk is a Buffer');
    const received = Buffer.concat(chunks);
    assert.equal(received.length, expected.length, 'every stderr byte arrived');
    assert.ok(received.equals(expected), 'the stderr bytes arrived unchanged');
  });

  test('a command that cannot start resolves exited with the error', PROCESS_TIMEOUT, async (t) => {
    const dir = await tempDir(t);
    const handle = spawnProcess({ argv: [`${dir}/no-such-kiro-cli`], env: {}, cwd: dir });
    const exit = await handle.exited;
    assert.equal(exit.code, null);
    assert.match(String(exit.error?.message), /ENOENT/);
  });

  test('rejects an empty argv', () => {
    assert.throws(() => spawnProcess({ argv: [], env: {}, cwd: '/' }), TypeError);
  });
});
