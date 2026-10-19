import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SERVER_NAME, TOOL_SERVER_TOOLS } from '../src/session/tool-server.ts';
import { SERVER_VERSION } from '../src/version.ts';
import { removeTree } from './helpers/processes.ts';

const TOOLS_PATH = fileURLToPath(new URL('../dist/sidecar-tools.js', import.meta.url));

const METHOD_NOT_FOUND = -32601;
/** An exit this much later than its cause fails the test. */
const EXIT_WITHIN_MS = 2_000;

const SEND_MESSAGE_DESCRIPTION =
  'Send a message to the Claude session that controls you: to report something or to ask a question. ' +
  'It is delivered when your turn ends. To ask, call it and then end your turn; the answer arrives as ' +
  'your next prompt. Do not call it after complete_task.';
const SEND_MESSAGE_REPLY =
  'Recorded; it is delivered when your turn ends. If you asked a question, end your turn now; otherwise go on.';
const COMPLETE_TASK_DESCRIPTION =
  'Declare the whole task finished and hand over its result. Call it once, at the very end, then end ' +
  'your turn. The session ends after this turn. Keep the result short; put a long report in a file and ' +
  'name the file.';
const COMPLETE_TASK_REPLY = 'Recorded. End your turn now.';

function keptNote(chars: number): string {
  return ` Only the first ${chars} characters are kept; put the rest in a file.`;
}

interface ToolReply {
  readonly content: unknown;
  readonly isError: boolean;
}

/** The built tool server behind an MCP SDK client over stdio; closed when the test ends. */
async function connectClient(t: TestContext, path = TOOLS_PATH): Promise<{ client: Client; stderr: string[] }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path], stderr: 'pipe' });
  const stderr: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
  const client = new Client({ name: 'kiro-sidecar-test', version: '0.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  return { client, stderr };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolReply> {
  const result = await client.callTool({ name, arguments: args });
  return { content: result.content, isError: result.isError === true };
}

function textReply(text: string): ToolReply {
  return { content: [{ type: 'text', text }], isError: false };
}

interface Message {
  readonly jsonrpc: string;
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** The built tool server on stdio, driven with raw JSON-RPC lines. */
interface RawTools {
  readonly pid: number;
  /** Every line the server wrote to stdout. */
  readonly lines: string[];
  readonly stderr: string[];
  readonly exited: Promise<Exit>;
  /** Writes one JSON-RPC message; with `end`, stdin is ended in the same write. */
  send(message: object, end?: boolean): void;
  /** The reply to the request with this id. */
  reply(id: number): Promise<Message>;
  request(id: number, method: string, params?: Record<string, unknown>): Promise<Message>;
  initialize(id: number): Promise<void>;
}

function rawTools(t: TestContext): RawTools {
  const child = spawn(process.execPath, [TOOLS_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pid = child.pid;
  assert.ok(pid !== undefined, 'the tool server started');
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));
  const exited = new Promise<Exit>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  const lines: string[] = [];
  const received = new Map<number, Message>();
  const waiting = new Map<number, (message: Message) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(line);
    const message = JSON.parse(line) as Message;
    if (message.id === undefined) {
      return;
    }
    const resolve = waiting.get(message.id);
    if (resolve === undefined) {
      received.set(message.id, message);
    } else {
      waiting.delete(message.id);
      resolve(message);
    }
  });
  const send = (message: object, end = false): void => {
    const line = `${JSON.stringify(message)}\n`;
    if (end) {
      child.stdin.end(line);
    } else {
      child.stdin.write(line);
    }
  };
  const reply = (id: number): Promise<Message> => {
    const message = received.get(id);
    if (message !== undefined) {
      received.delete(id);
      return Promise.resolve(message);
    }
    return new Promise((resolve) => waiting.set(id, resolve));
  };
  const request = (id: number, method: string, params: Record<string, unknown> = {}): Promise<Message> => {
    send({ jsonrpc: '2.0', id, method, params });
    return reply(id);
  };
  return {
    pid,
    lines,
    stderr,
    exited,
    send,
    reply,
    request,
    async initialize(id) {
      const answer = await request(id, 'initialize', {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'kiro-sidecar-test', version: '0.0.0' },
      });
      assert.equal((answer.result?.['serverInfo'] as { name: string } | undefined)?.name, 'sidecar');
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
  };
}

/** Waits for the exit and fails when it takes longer than `EXIT_WITHIN_MS`. */
async function exitWithin(t: TestContext, tools: RawTools, began: number): Promise<Exit> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no exit within ${EXIT_WITHIN_MS} ms`)), EXIT_WITHIN_MS);
  });
  try {
    const exit = await Promise.race([tools.exited, late]);
    t.diagnostic(`exited after ${Math.round(performance.now() - began)} ms`);
    return exit;
  } finally {
    clearTimeout(timer);
  }
}

function assertJsonRpcOnly(lines: readonly string[]): void {
  for (const line of lines) {
    assert.equal((JSON.parse(line) as Message).jsonrpc, '2.0', `stdout carries only JSON-RPC: ${line}`);
  }
}

describe('sidecar tool server over stdio', () => {
  test('is named sidecar and lists exactly send_message and complete_task', { timeout: 15_000 }, async (t) => {
    const { client, stderr } = await connectClient(t);

    assert.deepEqual(client.getServerVersion(), { name: TOOL_SERVER_NAME, version: SERVER_VERSION });
    assert.ok(client.getServerCapabilities()?.tools, 'tools capability is advertised');

    const { tools } = await client.listTools();
    // The step `tools` waits for exactly the tools this server lists.
    assert.deepEqual(tools.map((tool) => tool.name), TOOL_SERVER_TOOLS);
    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.description]),
      [
        ['send_message', SEND_MESSAGE_DESCRIPTION],
        ['complete_task', COMPLETE_TASK_DESCRIPTION],
      ],
    );
    for (const [tool, argument] of [
      [tools[0], 'text'],
      [tools[1], 'result'],
    ] as const) {
      const schema = tool?.inputSchema;
      assert.equal(schema?.type, 'object');
      assert.deepEqual(schema?.properties, { [argument]: { type: 'string' } });
      assert.deepEqual(schema?.required, [argument]);
      // Extra keys are ignored, not refused, so the listed schema does not forbid them.
      assert.equal(schema?.['additionalProperties'], undefined);
    }
    assert.deepEqual(stderr, []);
  });

  test('runs as sidecar-tools.mjs from a directory with no package.json, as docker mounts it', { timeout: 15_000 }, async (t) => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'kiro-sidecar-tools-mjs-')));
    t.after(() => removeTree(base));
    const copy = join(base, 'sidecar-tools.mjs');
    await copyFile(TOOLS_PATH, copy);
    const { client, stderr } = await connectClient(t, copy);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), TOOL_SERVER_TOOLS);
    assert.deepEqual(await callTool(client, 'complete_task', { result: 'ok' }), textReply(COMPLETE_TASK_REPLY));
    assert.deepEqual(stderr, []);
  });

  test('answers each tool with its reply, byte for byte', { timeout: 15_000 }, async (t) => {
    const { client } = await connectClient(t);
    assert.deepEqual(await callTool(client, 'send_message', { text: 'Should I keep the old flag?' }), textReply(SEND_MESSAGE_REPLY));
    assert.deepEqual(await callTool(client, 'send_message', { text: '' }), textReply(SEND_MESSAGE_REPLY));
    assert.deepEqual(await callTool(client, 'complete_task', { result: 'Done; the report is in REPORT.md.' }), textReply(COMPLETE_TASK_REPLY));
    assert.deepEqual(await callTool(client, 'complete_task', { result: '' }), textReply(COMPLETE_TASK_REPLY));
  });

  test('a text over the kept length gets the note; one at the length does not', { timeout: 15_000 }, async (t) => {
    const { client } = await connectClient(t);
    const cases = [
      ['send_message', 'text', SEND_MESSAGE_REPLY, 4_000],
      ['complete_task', 'result', COMPLETE_TASK_REPLY, 20_000],
    ] as const;
    for (const [name, argument, base, kept] of cases) {
      assert.deepEqual(await callTool(client, name, { [argument]: 'a'.repeat(kept) }), textReply(base), `${name} at ${kept}`);
      assert.deepEqual(
        await callTool(client, name, { [argument]: 'a'.repeat(kept + 1) }),
        textReply(`${base}${keptNote(kept)}`),
        `${name} at ${kept + 1}`,
      );
      assert.deepEqual(
        await callTool(client, name, { [argument]: 'a'.repeat(kept * 3) }),
        textReply(`${base}${keptNote(kept)}`),
        `${name} at ${kept * 3}`,
      );
    }
  });

  test('characters are counted in UTF-16 code units, as the plugin cuts them', { timeout: 15_000 }, async (t) => {
    // Non-Latin on purpose: each of these characters is one code point and two UTF-16 code units.
    const astral = String.fromCodePoint(0x1f600);
    assert.equal(astral.length, 2);
    const { client } = await connectClient(t);
    assert.deepEqual(await callTool(client, 'send_message', { text: astral.repeat(2_000) }), textReply(SEND_MESSAGE_REPLY));
    // 2001 code points, 4002 code units: over the bound only when counted in code units.
    assert.deepEqual(
      await callTool(client, 'send_message', { text: astral.repeat(2_001) }),
      textReply(`${SEND_MESSAGE_REPLY}${keptNote(4_000)}`),
    );
    assert.deepEqual(
      await callTool(client, 'complete_task', { result: astral.repeat(10_001) }),
      textReply(`${COMPLETE_TASK_REPLY}${keptNote(20_000)}`),
    );
  });

  test('an extra argument is ignored and the call gets the normal reply', { timeout: 15_000 }, async (t) => {
    const { client } = await connectClient(t);
    assert.deepEqual(await callTool(client, 'send_message', { text: 'a', extra: 'b' }), textReply(SEND_MESSAGE_REPLY));
    assert.deepEqual(
      await callTool(client, 'send_message', { text: 'a'.repeat(4_001), result: 'b' }),
      textReply(`${SEND_MESSAGE_REPLY}${keptNote(4_000)}`),
    );
    assert.deepEqual(await callTool(client, 'complete_task', { result: 'ok', text: 'b', count: 3 }), textReply(COMPLETE_TASK_REPLY));
  });

  test('a missing or non-string argument is refused with an error result', { timeout: 15_000 }, async (t) => {
    const { client } = await connectClient(t);
    const refusals = [
      ['send_message', {}],
      ['send_message', { text: 42 }],
      ['send_message', { text: null }],
      ['send_message', { text: ['a'] }],
      ['send_message', { result: 'a' }],
      ['complete_task', {}],
      ['complete_task', { result: 7 }],
      ['complete_task', { result: { text: 'a' } }],
      ['complete_task', { text: 'a' }],
    ] as const;
    for (const [name, args] of refusals) {
      // The SDK's McpServer turns the schema failure into a tool result with isError, not a JSON-RPC error.
      const reply = await callTool(client, name, args);
      assert.equal(reply.isError, true, `${name} ${JSON.stringify(args)}`);
      const content = reply.content as { type: string; text: string }[];
      assert.equal(content.length, 1);
      assert.equal(content[0]?.type, 'text');
      assert.match(
        content[0]?.text ?? '',
        new RegExp(`^MCP error -32602: Input validation error: Invalid arguments for tool ${name}: `),
      );
    }
    // The server answers normally after the refusals.
    assert.deepEqual(await callTool(client, 'send_message', { text: 'still here' }), textReply(SEND_MESSAGE_REPLY));
  });

  test('server/discover before initialize, as Kiro probes: method-not-found, then SIGTERM exits 0', { timeout: 15_000 }, async (t) => {
    const tools = rawTools(t);
    const discover = await tools.request(1, 'server/discover');
    assert.equal(discover.error?.code, METHOD_NOT_FOUND);
    assert.equal(discover.result, undefined);

    const began = performance.now();
    process.kill(tools.pid, 'SIGTERM');
    assert.deepEqual(await exitWithin(t, tools, began), { code: 0, signal: null });
    assertJsonRpcOnly(tools.lines);
    assert.deepEqual(tools.stderr, []);
  });

  test('an unknown method gets method-not-found and the server stays usable', { timeout: 15_000 }, async (t) => {
    const tools = rawTools(t);
    assert.equal((await tools.request(1, 'server/discover')).error?.code, METHOD_NOT_FOUND);
    await tools.initialize(2);
    assert.equal((await tools.request(3, 'sidecar/unknown')).error?.code, METHOD_NOT_FOUND);
    const listed = await tools.request(4, 'tools/list');
    assert.deepEqual(
      (listed.result?.['tools'] as { name: string }[]).map((tool) => tool.name),
      TOOL_SERVER_TOOLS,
    );
    const called = await tools.request(5, 'tools/call', { name: 'complete_task', arguments: { result: 'ok' } });
    assert.deepEqual(called.result, { content: [{ type: 'text', text: COMPLETE_TASK_REPLY }] });
    assertJsonRpcOnly(tools.lines);
  });

  test('exits 0 on SIGTERM when connected', { timeout: 15_000 }, async (t) => {
    const tools = rawTools(t);
    await tools.initialize(1);
    const began = performance.now();
    process.kill(tools.pid, 'SIGTERM');
    assert.deepEqual(await exitWithin(t, tools, began), { code: 0, signal: null });
  });

  test('exits 0 on the end of stdin', { timeout: 15_000 }, async (t) => {
    const tools = rawTools(t);
    await tools.initialize(1);
    const began = performance.now();
    tools.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } }, true);
    assert.deepEqual(await exitWithin(t, tools, began), { code: 0, signal: null });
    assertJsonRpcOnly(tools.lines);
  });

  test('a call written together with the end of stdin is still answered before the exit', { timeout: 15_000 }, async (t) => {
    const tools = rawTools(t);
    await tools.initialize(1);
    const began = performance.now();
    tools.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_message', arguments: { text: 'last' } } }, true);
    assert.deepEqual(await exitWithin(t, tools, began), { code: 0, signal: null });
    const answer = await tools.reply(2);
    assert.deepEqual(answer.result, { content: [{ type: 'text', text: SEND_MESSAGE_REPLY }] });
    assertJsonRpcOnly(tools.lines);
  });
});
