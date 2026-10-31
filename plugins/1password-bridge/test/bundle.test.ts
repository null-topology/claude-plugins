/**
 * The committed bundles in dist/: what they contain, that the broker starts
 * without WebAssembly, that the server lists its tools, that bin/op-bridge
 * runs the CLI, and one run of the hook per event with crafted stdin and a
 * temporary state directory. No run reaches 1Password, the op CLI or a
 * window: the broker only answers `status`, the server only `initialize` and
 * `tools/list`, the CLI finds no broker in its sandbox.
 */

import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { withheldNote } from '../src/hooks/post-tool-use.ts';
import { exitTrapLine, pathLine, stateDirLine } from '../src/hooks/session-start.ts';
import { BrokerError, brokerSocketPath, request } from '../src/mcp/broker-client.ts';
import { TOOL_NAMES } from '../src/mcp/tools.ts';
import { sessionDir } from '../src/paths.ts';
import type { Response } from '../src/protocol.ts';
import { markTicket } from '../src/session-files.ts';
import { PROTOCOL_VERSION, VERSION } from '../src/version.ts';
import { sandbox, SECRET, SESSION_ID, type Sandbox } from './hooks/helpers.ts';

const TICKET = 'tkt_aaaaaaaaaaaaaaaa';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const BROKER = join(DIST, 'broker.js');
const CLI = join(DIST, 'cli.js');
const HOOK = join(DIST, 'hook.js');
const SERVER = join(DIST, 'server.js');
const GUARD = fileURLToPath(new URL('./wasm-guard.mjs', import.meta.url));

function bundleText(path: string): string {
  return readFileSync(path, 'utf8');
}

function scratch(t: TestContext): Sandbox {
  const sb = sandbox('op-bridge-bundle-');
  t.after(sb.cleanup);
  return sb;
}

/** Polls `ready` every 25 ms until it holds; fails after `ms` or when `failed` says why. */
async function until(ready: () => boolean, ms: number, failed: () => string | undefined): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    const reason = failed();
    if (reason !== undefined) assert.fail(reason);
    if (Date.now() > deadline) assert.fail('timed out');
    await sleep(25);
  }
}

describe('bundle contents', () => {
  test('dist/ holds exactly the broker, cli, hook and server bundles', () => {
    assert.deepEqual(readdirSync(DIST).sort(), ['broker.js', 'cli.js', 'hook.js', 'server.js']);
  });

  test('no bundle ships or names a .wasm file', () => {
    for (const path of [BROKER, CLI, HOOK, SERVER]) {
      const text = bundleText(path);
      assert.equal(text.includes('core_bg'), false, `${path} names core_bg`);
      assert.doesNotMatch(text, /\.wasm\b/, `${path} names a .wasm file`);
    }
  });

  test('the broker bundles the SDK with the sdk-core stub in place of its WebAssembly core', () => {
    const text = bundleText(BROKER);
    assert.ok(text.includes('// node_modules/@1password/sdk/'), 'the SDK is bundled');
    assert.ok(text.includes('// src/sdk-core-stub.ts'), 'the stub is bundled');
    assert.equal(text.includes('@1password/sdk-core'), false, 'sdk-core is not bundled or imported');
  });

  test('the hook, the server and the CLI bundle no 1Password SDK code', () => {
    for (const path of [CLI, HOOK, SERVER]) {
      assert.equal(bundleText(path).includes('@1password'), false, path);
    }
  });

  test('the hook bundles no broker module: it reaches the broker through the client only', () => {
    const text = bundleText(HOOK);
    assert.match(text, /^\/\/ src\/mcp\/broker-client\.ts$/m, 'the client is bundled');
    assert.doesNotMatch(text, /^\/\/ src\/broker\//m);
  });
});

describe('dist/broker.js', () => {
  test('the wasm guard reports a .wasm read and a WebAssembly compile', (t) => {
    const sb = scratch(t);
    const probe = join(sb.root, 'probe.mjs');
    writeFileSync(
      probe,
      [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "const file = new URL('./probe.wasm', import.meta.url);",
        'writeFileSync(file, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));',
        'await WebAssembly.compile(readFileSync(file));',
      ].join('\n'),
    );
    const run = spawnSync(process.execPath, [GUARD, probe], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /^WASM fs\.readFileSync .*probe\.wasm$/m);
    assert.match(run.stderr, /^WASM WebAssembly\.compile$/m);
    assert.match(run.stderr, /^IMPORTED$/m);
  });

  test('imports without reading a .wasm file or using WebAssembly, then answers status', { timeout: 30_000 }, async (t) => {
    const sb = scratch(t);
    const child = spawn(process.execPath, [GUARD, BROKER], {
      env: { PATH: process.env['PATH'] ?? '', HOME: sb.root, CLAUDE_PLUGIN_DATA: sb.stateDir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let stderr = '';
    let exit: string | undefined;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const closed = new Promise<void>((resolve) => {
      child.on('close', (code, signal) => {
        exit = `the broker exited (${code ?? signal}): ${stderr}`;
        resolve();
      });
    });

    await until(() => stderr.includes('IMPORTED\n'), 10_000, () => exit);

    let status: Response | undefined;
    const deadline = Date.now() + 10_000;
    while (status === undefined) {
      if (Date.now() > deadline) assert.fail(`no status answer: ${stderr}`);
      try {
        status = await request(
          { v: PROTOCOL_VERSION, op: 'status' },
          {
            stateDir: sb.stateDir,
            spawnBroker: () => assert.fail('status never starts a broker'),
            timeoutMs: 2000,
          },
        );
      } catch (err) {
        if (!(err instanceof BrokerError) || err.code !== 'unavailable' || exit !== undefined) throw err;
        await sleep(50);
      }
    }
    assert.equal(status.ok, true);
    assert.equal(status.ok && status.op, 'status');
    assert.deepEqual(status.ok && status.op === 'status' ? status.accounts : undefined, []);
    assert.doesNotMatch(stderr, /^WASM /m);

    child.kill('SIGTERM');
    await closed;
  });
});

interface RpcMessage {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: unknown;
}

describe('dist/server.js', () => {
  test('initializes with the instructions and lists accounts, fields, issue_tickets and release', { timeout: 30_000 }, async (t) => {
    const sb = scratch(t);
    const child = spawn(process.execPath, [SERVER], {
      env: { PATH: process.env['PATH'] ?? '', HOME: sb.root, CLAUDE_PLUGIN_DATA: sb.stateDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    const messages: RpcMessage[] = [];
    let buffered = '';
    let stderr = '';
    let exit: string | undefined;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        messages.push(JSON.parse(buffered.slice(0, newline)) as RpcMessage);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const closed = new Promise<number | null>((resolve) => {
      child.on('close', (code) => {
        exit = `the server exited (${code}): ${stderr}`;
        resolve(code);
      });
    });
    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const answer = async (id: number): Promise<Record<string, unknown>> => {
      await until(() => messages.some((m) => m.id === id), 10_000, () => exit);
      const message = messages.find((m) => m.id === id);
      assert.equal(message?.error, undefined, JSON.stringify(message?.error));
      return message?.result ?? {};
    };

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'bundle-test', version: '0' } },
    });
    const init = await answer(1);
    assert.deepEqual(init['serverInfo'], { name: '1password-bridge', version: VERSION });
    assert.match(String(init['instructions']), /"\$\(op-bridge redeem <ticket>\)"/);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const listed = (await answer(2))['tools'] as { name: string }[];
    assert.deepEqual(
      listed.map((tool) => tool.name),
      [...TOOL_NAMES],
    );

    child.stdin.end();
    assert.equal(await closed, 0);
    assert.equal(stderr, '');
  });
});

describe('dist/cli.js', () => {
  test('bin/op-bridge is executable and runs the CLI bundle', () => {
    const shim = join(ROOT, 'bin', 'op-bridge');
    assert.ok((statSync(shim).mode & 0o111) !== 0, 'bin/op-bridge is executable');
    const usage = spawnSync(shim, [], { env: { PATH: process.env['PATH'] ?? '' }, encoding: 'utf8' });
    assert.equal(usage.status, 2);
    assert.equal(usage.stderr, 'usage: op-bridge redeem <ticket>\n');
    const noSession = spawnSync(shim, ['redeem', 'tkt_abcdefghijklmnop'], { env: { PATH: process.env['PATH'] ?? '' }, encoding: 'utf8' });
    assert.equal(noSession.status, 13);
    assert.equal(noSession.stdout, '');
  });

  test('a /dev/null or closed stdout is refused before connecting; a pipe or a file is not', (t) => {
    const sb = scratch(t);
    const shim = join(ROOT, 'bin', 'op-bridge');
    // TMPDIR inside the sandbox keeps even a fallback socket path away from a real broker.
    const env = { PATH: process.env['PATH'] ?? '', TMPDIR: sb.root, CLAUDE_CODE_SESSION_ID: SESSION_ID, OP_BRIDGE_STATE_DIR: sb.stateDir };
    const file = join(sb.root, 'out');
    const run = (redirect: string) =>
      spawnSync('/bin/sh', ['-c', `"$0" redeem ${TICKET} ${redirect}`, shim, file], { env, encoding: 'utf8', timeout: 10_000 });
    for (const redirect of ['>/dev/null', '>&-']) {
      const refused = run(redirect);
      assert.equal(refused.status, 2, redirect);
      assert.equal(
        refused.stderr,
        'op-bridge: usage: stdout is closed or /dev/null, so the value would be lost; nothing was sent: capture it with "$(op-bridge redeem <ticket>)"\n',
        redirect,
      );
    }
    // No broker listens in the sandbox: reaching the connection step proves the output was accepted.
    const piped = run('');
    assert.equal(piped.status, 20);
    assert.equal(piped.stdout, '');
    const toFile = run('>"$1"');
    assert.equal(toFile.status, 20);
    assert.equal(readFileSync(file, 'utf8'), '');
    // The main use: spawnSync's default stdout is a socket on macOS, a command substitution is a
    // FIFO. Exit 99 means the shell did not give the CLI a FIFO and the case was not exercised.
    const captured = spawnSync(
      '/bin/sh',
      ['-c', `v="$(test -p /dev/stdout || exit 99; "$0" redeem ${TICKET})"; s=$?; printf %s "$v"; exit "$s"`, shim],
      { env, encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(captured.status, 20);
    assert.equal(captured.stdout, '');
  });
});

interface HookRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runHook(sb: Sandbox, input: string | object, env: Record<string, string> = {}): HookRun {
  const run = spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: process.env['PATH'] ?? '', HOME: sb.root, CLAUDE_PLUGIN_DATA: sb.stateDir, CLAUDE_PLUGIN_ROOT: ROOT, ...env },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** The parsed stdout of a run that exited 0 without stderr. */
function output(run: HookRun): Record<string, unknown> | undefined {
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  return run.stdout === '' ? undefined : (JSON.parse(run.stdout) as Record<string, unknown>);
}

const BASH_OUTPUT = (stdout: string) => ({ stdout, stderr: '', interrupted: false, isImage: false });

function postToolUse(stdout: string): object {
  return {
    hook_event_name: 'PostToolUse',
    session_id: SESSION_ID,
    tool_name: 'Bash',
    tool_input: { command: 'cat config' },
    tool_response: BASH_OUTPUT(stdout),
  };
}

describe('dist/hook.js', () => {
  test('PostToolUse without a marker under 150 ms (median of 10)', { timeout: 60_000 }, (t) => {
    const sb = scratch(t);
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      const run = runHook(sb, postToolUse('plain output'));
      times.push(performance.now() - started);
      assert.equal(output(run), undefined);
    }
    times.sort((a, b) => a - b);
    const median = ((times[4] ?? 0) + (times[5] ?? 0)) / 2;
    assert.ok(median < 150, `median ${median.toFixed(1)} ms`);
  });

  test('SessionStart appends the state directory, PATH and exit-trap lines', (t) => {
    const sb = scratch(t);
    const envFile = join(sb.root, 'claude-env.sh');
    const result = output(runHook(sb, { hook_event_name: 'SessionStart', session_id: SESSION_ID, source: 'startup' }, { CLAUDE_ENV_FILE: envFile }));
    assert.ok(existsSync(sessionDir(sb.stateDir, SESSION_ID)));
    assert.equal(readFileSync(envFile, 'utf8'), [stateDirLine(sb.stateDir), pathLine(ROOT), exitTrapLine(ROOT), ''].join('\n'));
    // Diagnostics depend on what this machine has installed; their shape does not.
    if (result !== undefined) {
      assert.deepEqual(Object.keys(result).sort(), ['hookSpecificOutput', 'systemMessage']);
      assert.equal((result['hookSpecificOutput'] as { hookEventName: string }).hookEventName, 'SessionStart');
    }
  });

  test('PreToolUse writes the live session id and transcript path into a bridge call', (t) => {
    const sb = scratch(t);
    const transcript = join(sb.root, 'transcript.jsonl');
    const result = output(
      runHook(sb, {
        hook_event_name: 'PreToolUse',
        session_id: SESSION_ID,
        transcript_path: transcript,
        tool_name: 'mcp__plugin_1password-bridge_op__issue_tickets',
        tool_input: { ref: 'op://Vault/Item/token', reason: 'deploy the service', session_id: 'stale-session' },
      }),
    );
    assert.deepEqual(result, {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ref: 'op://Vault/Item/token', reason: 'deploy the service', session_id: SESSION_ID, transcript_path: transcript, agent_id: 'main' },
      },
    });
  });

  test('PostToolUse without a marker exits 0 with no output', (t) => {
    const sb = scratch(t);
    const run = runHook(sb, postToolUse(`token=${SECRET}\n`));
    assert.equal(output(run), undefined);
    assert.equal(run.stdout, '');
  });

  test('PostToolUse with a marker and no broker running withholds the output, naming the ticket', (t) => {
    const sb = scratch(t);
    assert.ok(brokerSocketPath(sb.stateDir, {}).startsWith(sb.stateDir), 'the socket the hook tries must live in the sandbox');
    markTicket(sb.stateDir, SESSION_ID, TICKET);
    const run = runHook(sb, postToolUse(`token=${SECRET}\n`));
    assert.equal(run.stdout.includes(SECRET), false);
    const note = withheldNote([TICKET]);
    assert.deepEqual(output(run), {
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { stdout: note, stderr: note, interrupted: false, isImage: false } },
    });
  });

  test('PostToolUseFailure with a marker and no broker running warns without repeating the error', (t) => {
    const sb = scratch(t);
    assert.ok(brokerSocketPath(sb.stateDir, {}).startsWith(sb.stateDir), 'the socket the hook tries must live in the sandbox');
    markTicket(sb.stateDir, SESSION_ID, TICKET);
    const run = runHook(sb, {
      hook_event_name: 'PostToolUseFailure',
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      error: `failed near ${SECRET}`,
    });
    assert.equal(run.stdout.includes(SECRET), false);
    const specific = output(run)?.['hookSpecificOutput'] as { hookEventName: string; additionalContext: string };
    assert.equal(specific.hookEventName, 'PostToolUseFailure');
    assert.match(specific.additionalContext, /may contain an unmasked secret value/);
  });

  test('PostToolUse and PostToolUseFailure of another tool exit 0 with no output, even with a marker and no broker', (t) => {
    const sb = scratch(t);
    markTicket(sb.stateDir, SESSION_ID, TICKET);
    const read = runHook(sb, {
      hook_event_name: 'PostToolUse',
      session_id: SESSION_ID,
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/config' },
      tool_response: { type: 'text', file: { filePath: '/tmp/config', content: `token=${SECRET}\n` } },
    });
    assert.equal(output(read), undefined);
    const failed = runHook(sb, {
      hook_event_name: 'PostToolUseFailure',
      session_id: SESSION_ID,
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/config' },
      error: `failed near ${SECRET}`,
    });
    assert.equal(output(failed), undefined);
  });

  test('SessionEnd with no broker running removes the session directory', (t) => {
    const sb = scratch(t);
    markTicket(sb.stateDir, SESSION_ID, TICKET);
    const dir = sessionDir(sb.stateDir, SESSION_ID);
    assert.ok(existsSync(dir));
    assert.equal(output(runHook(sb, { hook_event_name: 'SessionEnd', session_id: SESSION_ID, reason: 'clear' })), undefined);
    assert.equal(existsSync(dir), false);
  });

  test('a Bash PreToolUse exits 0 with no output', (t) => {
    const sb = scratch(t);
    const run = runHook(sb, {
      hook_event_name: 'PreToolUse',
      session_id: SESSION_ID,
      cwd: sb.root,
      tool_name: 'Bash',
      tool_use_id: 'toolu_bundle',
      tool_input: { command: 'true' },
    });
    assert.equal(output(run), undefined);
    assert.equal(run.stdout, '');
  });

  test('Stop exits 0 with no output', (t) => {
    const sb = scratch(t);
    const run = runHook(sb, { hook_event_name: 'Stop', session_id: SESSION_ID, stop_hook_active: false });
    assert.equal(output(run), undefined);
    assert.equal(run.stdout, '');
  });

  test('SubagentStop exits 0 with no output', (t) => {
    const sb = scratch(t);
    const run = runHook(sb, { hook_event_name: 'SubagentStop', session_id: SESSION_ID, agent_id: 'agent-bundle', agent_type: 'general-purpose' });
    assert.equal(output(run), undefined);
    assert.equal(run.stdout, '');
  });

  test('input that is not JSON exits 0 with no output', (t) => {
    const sb = scratch(t);
    assert.equal(output(runHook(sb, 'not json')), undefined);
  });
});
