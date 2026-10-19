import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { SessionManager } from '../src/session/manager.ts';
import { DEFAULTS } from '../src/settings.ts';
import type { Environment } from '../src/settings.ts';
import { prepareFakeKiro } from './helpers/fake-kiro.ts';
import { tempDir } from './helpers/processes.ts';
import { ESCAPED_TOKEN, TEST_TOKEN, isAlive, metaOf, testEnvironment, waitFor } from './session/manager-helpers.ts';
import { filesUnder } from './tools/harness.ts';

const SERVER_PATH = fileURLToPath(new URL('../dist/server.js', import.meta.url));
const PACKAGE = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const METHOD_NOT_FOUND = -32601;
const TOOL_NAMES = ['start', 'resume', 'send', 'wait', 'status', 'cancel', 'stop', 'list'];

interface Message {
  readonly jsonrpc: string;
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

interface ToolReply {
  readonly text: string;
  readonly isError: boolean;
}

/** The built server on stdio, driven with raw JSON-RPC lines. */
interface RawServer {
  readonly pid: number;
  readonly stderr: string[];
  /** Every line the server wrote to stdout. */
  readonly lines: string[];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  request(method: string, params: Record<string, unknown>): Promise<Message>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolReply>;
  /** Ends the server's stdin, as Claude Code does when it closes the connection. */
  closeStdin(): void;
}

async function rawServer(t: TestContext, env: Environment, path: string = SERVER_PATH): Promise<RawServer> {
  const child = spawn(process.execPath, [path], { stdio: ['pipe', 'pipe', 'pipe'], env });
  const pid = child.pid;
  assert.ok(pid !== undefined, 'the server started');
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  const lines: string[] = [];
  const pending = new Map<number, (message: Message) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(line);
    const message = JSON.parse(line) as Message;
    if (message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown>): Promise<Message> =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'kiro-sidecar-test', version: '0.0.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    pid,
    stderr,
    lines,
    exited,
    request,
    async callTool(name, args) {
      const message = await request('tools/call', { name, arguments: args });
      const result = message.result as { content: { text: string }[]; isError?: boolean };
      return { text: result.content[0]?.text ?? '', isError: result.isError === true };
    },
    closeStdin() {
      child.stdin.end();
    },
  };
}

/** True when the process is gone or a zombie; without `/proc` (macOS), when it takes no signal. */
async function isGone(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
  } catch {
    return !isAlive(pid);
  }
}

function assertJsonRpcOnly(lines: readonly string[]): void {
  for (const line of lines) {
    assert.equal((JSON.parse(line) as Message).jsonrpc, '2.0', `stdout carries only JSON-RPC: ${line}`);
  }
}

describe('built server over stdio', () => {
  test('completes the MCP handshake and lists the eight tools at once', { timeout: 15_000 }, async (t) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      stderr: 'pipe',
    });
    const client = new Client({ name: 'kiro-sidecar-test', version: '0.0.0' });
    t.after(() => client.close());

    const began = performance.now();
    await client.connect(transport);

    const info = client.getServerVersion();
    assert.equal(info?.name, 'kiro');
    assert.equal(info?.version, PACKAGE.version);
    assert.ok(client.getServerCapabilities()?.tools, 'tools capability is advertised');

    const result = await client.listTools();
    const elapsed = performance.now() - began;
    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      TOOL_NAMES,
    );
    t.diagnostic(`spawn, handshake and tools/list took ${Math.round(elapsed)} ms`);
    assert.ok(elapsed < 5_000, `tools/list answered after ${Math.round(elapsed)} ms`);
  });

  test('with invalid settings it still lists every tool, and each call answers E_INVALID', { timeout: 15_000 }, async (t) => {
    const server = await rawServer(
      t,
      testEnvironment({ KIRO_SIDECAR_DEFAULT_MODE: 'bogus', KIRO_SIDECAR_RETENTION_DAYS: '0' }),
    );
    const listed = await server.request('tools/list', {});
    assert.deepEqual(
      (listed.result?.['tools'] as { name: string }[]).map((tool) => tool.name),
      TOOL_NAMES,
    );
    for (const name of ['status', 'list', 'start']) {
      const reply = await server.callTool(name, name === 'start' ? { dir: '/tmp' } : {});
      assert.ok(reply.isError);
      assert.match(reply.text, /^E_INVALID Invalid plugin settings:/);
      assert.match(reply.text, /KIRO_SIDECAR_DEFAULT_MODE/);
      assert.match(reply.text, /KIRO_SIDECAR_RETENTION_DAYS/);
      assert.match(reply.text, /^- The Kiro token is not set: KIRO_SIDECAR_API_KEY /m);
    }
    assertJsonRpcOnly(server.lines);
  });

  test('without a token, under CLAUDE_PLUGIN_ROOT, each call names the plugin .mcp.json and warns against writing the token into it', { timeout: 15_000 }, async (t) => {
    const root = '/opt/claude/plugins/kiro-sidecar';
    const server = await rawServer(t, testEnvironment({ KIRO_SIDECAR_API_KEY: '', CLAUDE_PLUGIN_ROOT: root }));
    for (const name of ['status', 'list', 'start']) {
      const reply = await server.callTool(name, name === 'start' ? { dir: '/tmp' } : {});
      assert.ok(reply.isError);
      assert.match(reply.text, /^E_INVALID Invalid plugin settings:\n- The Kiro token is not set: /);
      assert.ok(
        reply.text.endsWith(
          `This server's MCP config: ${root}/.mcp.json Do not write the token into that file: a plugin update ` +
            'replaces it and it would hold the token in plain text; use "/plugin configure" instead.',
        ),
        reply.text,
      );
    }
    assertJsonRpcOnly(server.lines);
  });

  test('rejects server/discover at once so the client can fall back to initialize', {
    timeout: 15_000,
  }, async (t) => {
    // A state dir of its own: the handshake starts the startup sweep.
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: await tempDir(t) };
    const child = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], env });
    t.after(() => {
      child.kill();
    });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const nextMessage = async (): Promise<Record<string, unknown>> => {
      const { value, done } = await lines.next();
      assert.ok(!done, 'server closed stdout');
      // Stdout must carry nothing but JSON-RPC messages.
      return JSON.parse(value) as Record<string, unknown>;
    };
    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    send({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
    const discover = await nextMessage();
    assert.equal(discover.id, 1);
    assert.equal((discover.error as { code: number } | undefined)?.code, METHOD_NOT_FOUND);

    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'kiro-sidecar-test', version: '0.0.0' },
      },
    });
    const initialize = await nextMessage();
    assert.equal(initialize.id, 2);
    const initResult = initialize.result as { protocolVersion: string; serverInfo: { name: string } };
    assert.equal(initResult.protocolVersion, LATEST_PROTOCOL_VERSION);
    assert.equal(initResult.serverInfo.name, 'kiro');

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const tools = await nextMessage();
    assert.equal(tools.id, 3);
    assert.deepEqual(
      ((tools.result as { tools: { name: string }[] }).tools).map((tool) => tool.name),
      TOOL_NAMES,
    );
  });

  test('exits when its stdin closes', { timeout: 15_000 }, async () => {
    const child = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'ignore', 'pipe'] });
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
    child.stdin.end();
    assert.equal(await exited, 0);
  });

  test('SIGTERM with a live session: exits 0 and the Kiro child is gone within 500 ms', { timeout: 30_000 }, async (t) => {
    const workspace = await prepareFakeKiro(t, 'harness');
    const stateDir = await tempDir(t);
    const server = await rawServer(
      t,
      testEnvironment({
        KIRO_SIDECAR_KIRO_COMMAND: workspace.command,
        KIRO_SIDECAR_DEFAULT_MODE: 'local',
        KIRO_SIDECAR_API_KEY: TEST_TOKEN,
        CLAUDE_PLUGIN_DATA: stateDir,
      }),
    );
    const started = await server.callTool('start', { dir: workspace.dir, prompt: 'hold 60000' });
    assert.ok(!started.isError, started.text);
    const fakePid = (await workspace.started()).pid;
    assert.ok(!(await isGone(fakePid)), 'the fake agent runs');

    const began = performance.now();
    process.kill(server.pid, 'SIGTERM');
    const exit = await server.exited;
    const serverMs = performance.now() - began;
    await waitFor(() => isGone(fakePid), 'the fake agent to end', 2_000);
    const childMs = performance.now() - began;
    t.diagnostic(`server exited after ${Math.round(serverMs)} ms, Kiro child gone after ${Math.round(childMs)} ms`);
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.ok(childMs <= 500, `the Kiro child was gone after ${Math.round(childMs)} ms`);
    assertJsonRpcOnly(server.lines);
  });

  for (const ending of ['stdin end', 'SIGTERM'] as const) {
    const title = `${ending} during a turn: its result and the exited state are written before the exit; a sweep keeps them`;
    test(title, { timeout: 30_000 }, async (t) => {
      const workspace = await prepareFakeKiro(t, 'harness');
      const stateDir = await tempDir(t);
      const env = testEnvironment({
        KIRO_SIDECAR_KIRO_COMMAND: workspace.command,
        KIRO_SIDECAR_DEFAULT_MODE: 'local',
        KIRO_SIDECAR_API_KEY: TEST_TOKEN,
        CLAUDE_PLUGIN_DATA: stateDir,
      });
      const server = await rawServer(t, env);
      const started = await server.callTool('start', { dir: workspace.dir, prompt: 'hold 60000' });
      assert.ok(!started.isError, started.text);
      const launchId = (JSON.parse(started.text.slice(0, started.text.lastIndexOf('}') + 1)) as { launchId: string }).launchId;

      const began = performance.now();
      if (ending === 'stdin end') {
        server.closeStdin();
      } else {
        process.kill(server.pid, 'SIGTERM');
      }
      const exit = await server.exited;
      const serverMs = performance.now() - began;
      t.diagnostic(`server exited after ${Math.round(serverMs)} ms`);
      assert.deepEqual(exit, { code: 0, signal: null });
      assert.ok(serverMs <= 500, `the server exited after ${Math.round(serverMs)} ms`);

      const turnsDir = join(stateDir, 'runs', launchId, 'turns');
      const turns = await readdir(turnsDir);
      assert.ok(turns.includes('1.json'), `turns/ holds ${turns.join(', ')}`);
      assert.deepEqual(turns.filter((name) => name.endsWith('.tmp')), []);
      const resultText = await readFile(join(turnsDir, '1.json'), 'utf8');
      const result = JSON.parse(resultText) as { outcome: string; endedBy: string | null; error: string | null };
      assert.equal(result.outcome, 'exited');
      assert.equal(result.endedBy, null);
      assert.match(String(result.error), /server shut down/);
      assert.equal((await metaOf(stateDir, launchId)).state, 'exited');

      // The next server's startup sweep finds the run ended and leaves it as it is.
      const next = new SessionManager({
        settings: { ...DEFAULTS, api_key: TEST_TOKEN, default_mode: 'local' },
        stateDir,
        env,
        projectDir: null,
        onError: () => {},
        deps: { listHostContainers: async () => [] },
      });
      t.after(() => next.shutdown());
      const report = await next.sweep();
      const run = report.runs.find((entry) => entry.launchId === launchId);
      assert.equal(run?.action, 'untouched');
      assert.equal(run?.skipped, 'state exited');
      assert.equal(run?.resultCreated, null);
      assert.equal(await readFile(join(turnsDir, '1.json'), 'utf8'), resultText);
      assert.equal((await metaOf(stateDir, launchId)).state, 'exited');
      assertJsonRpcOnly(server.lines);
    });
  }

  const echoed = [
    ['a token', TEST_TOKEN],
    ['a token with URL escapes, also echoed with mixed-case escapes,', ESCAPED_TOKEN],
  ] as const;
  for (const [kind, token] of echoed) {
    test(`${kind} Kiro echoes never reaches a reply, stderr or the state directory`, { timeout: 30_000 }, async (t) => {
      const workspace = await prepareFakeKiro(t, 'secret-echo');
      const stateDir = await tempDir(t);
      const server = await rawServer(
        t,
        testEnvironment({
          KIRO_SIDECAR_KIRO_COMMAND: workspace.command,
          KIRO_SIDECAR_DEFAULT_MODE: 'local',
          KIRO_SIDECAR_API_KEY: token,
          CLAUDE_PLUGIN_DATA: stateDir,
        }),
      );
      const replies: ToolReply[] = [];
      const started = await server.callTool('start', { dir: workspace.dir, prompt: 'echo the token' });
      assert.ok(!started.isError, started.text);
      replies.push(started);
      const launchId = (JSON.parse(started.text.slice(0, started.text.lastIndexOf('}') + 1)) as { launchId: string }).launchId;
      const waited = await server.callTool('wait', { session: launchId });
      assert.ok(!waited.isError, waited.text);
      assert.match(waited.text, /The token is \[REDACTED\]/);
      if (token === TEST_TOKEN) {
        assert.match(waited.text, /^- Is the token \[REDACTED\] right\?$/m);
      } else {
        assert.match(waited.text, /The encoded token is \[REDACTED\]\./);
        assert.match(waited.text, /^- Is the token \[REDACTED\] or \[REDACTED\] right\?$/m);
      }
      replies.push(waited);
      replies.push(await server.callTool('status', { session: launchId }));
      replies.push(await server.callTool('list', {}));
      replies.push(await server.callTool('stop', { session: launchId }));
      replies.push(await server.callTool('wait', { session: launchId, timeout_s: 1 }));
      process.kill(server.pid, 'SIGTERM');
      await server.exited;

      // The URL-encoded form, searched in lower-cased text so no case of its escapes is missed.
      const encoded = encodeURIComponent(token).toLowerCase();
      const holds = (text: string) => text.includes(token) || text.toLowerCase().includes(encoded);
      assert.ok((await workspace.started()).env['KIRO_API_KEY'] === token, 'the fake got the token');
      for (const reply of replies) {
        assert.ok(!holds(reply.text), `a reply holds the token: ${reply.text}`);
      }
      assert.ok(!holds(server.lines.join('\n')), 'stdout holds the token');
      assert.ok(!holds(server.stderr.join('')), 'stderr holds the token');
      const files = await filesUnder(stateDir);
      assert.ok(files.size > 0);
      for (const [path, content] of files) {
        assert.ok(!holds(content), `${path} holds the token`);
      }
    });
  }
});

// Run from the bundle: from source the server finds no tool server next to
// itself, and a subprocess cannot be handed the path; `check:dist` keeps the
// bundle equal to the source.
describe('server bundle over stdio: exit', () => {
  test('SIGTERM: a process of the Kiro group that ignores SIGTERM is killed before the server exits', { timeout: 30_000 }, async (t) => {
    const workspace = await prepareFakeKiro(t, 'harness');
    await writeFile(join(workspace.dir, 'fake-leave-grandchild'), 'ignore-term');
    const stateDir = await tempDir(t);
    const server = await rawServer(
      t,
      testEnvironment({
        KIRO_SIDECAR_KIRO_COMMAND: workspace.command,
        KIRO_SIDECAR_DEFAULT_MODE: 'local',
        KIRO_SIDECAR_API_KEY: TEST_TOKEN,
        CLAUDE_PLUGIN_DATA: stateDir,
      }),
    );
    const started = await server.callTool('start', { dir: workspace.dir, prompt: 'hold 60000' });
    assert.ok(!started.isError, started.text);
    await waitFor(() => existsSync(join(workspace.dir, 'fake-grandchild.ready')), 'the grandchild to ignore SIGTERM');
    const grandchild = Number(await readFile(join(workspace.dir, 'fake-grandchild.pid'), 'utf8'));
    t.after(async () => {
      if (!(await isGone(grandchild))) {
        process.kill(grandchild, 'SIGKILL');
      }
    });
    assert.equal(await isGone(grandchild), false, 'the grandchild runs');

    const began = performance.now();
    process.kill(server.pid, 'SIGTERM');
    const exit = await server.exited;
    const serverMs = performance.now() - began;
    t.diagnostic(`server exited after ${Math.round(serverMs)} ms`);
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.ok(serverMs <= 500, `the server exited after ${Math.round(serverMs)} ms`);
    // Well inside the 2 s sweep grace: only a kill at exit ends it this soon.
    await waitFor(() => isGone(grandchild), 'the grandchild to end', 500);
  });
});
