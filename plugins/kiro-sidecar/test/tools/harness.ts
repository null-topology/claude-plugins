/**
 * An MCP client connected over an in-memory transport to the real server,
 * whose session manager runs the fake Kiro agent in local mode.
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { spawnProcess } from '../../src/acp/process.ts';
import type { ProcessHandle } from '../../src/acp/process.ts';
import { createServer } from '../../src/mcp-server.ts';
import type { RuntimeOptions } from '../../src/tools/runtime.ts';
import type { Environment } from '../../src/settings.ts';
import { createFakeWorkspace } from '../helpers/fake-kiro.ts';
import type { FakeWorkspace } from '../helpers/fake-kiro.ts';
import { endProcesses, removeTree } from '../helpers/processes.ts';
import { TEST_TOKEN, TOOL_SERVER_FILE, testEnvironment } from '../session/manager-helpers.ts';

export interface Reply {
  readonly text: string;
  readonly isError: boolean;
  /** The reply's lines. */
  readonly lines: readonly string[];
}

export interface Harness {
  readonly client: Client;
  readonly stateDir: string;
  readonly workspace: FakeWorkspace;
  /** Diagnostic lines the server wrote. */
  readonly logs: string[];
  call(name: string, args?: Record<string, unknown>, options?: CallOptions): Promise<Reply>;
}

export interface CallOptions extends RequestOptions {
  readonly meta?: Record<string, unknown>;
}

export interface HarnessOptions extends Omit<RuntimeOptions, 'env' | 'stateDir' | 'log'> {
  /**
   * Extra server environment, on top of a small test environment that points
   * at the fake and sets `KIRO_SIDECAR_API_KEY` to `TEST_TOKEN`; an entry set
   * to undefined removes a variable.
   */
  readonly env?: Environment;
}

export async function harness(t: TestContext, scenario: string, options: HarnessOptions = {}): Promise<Harness> {
  const workspace = await createFakeWorkspace(scenario);
  const stateDir = await mkdtemp(join(tmpdir(), 'kiro-sidecar-tools-'));
  const logs: string[] = [];
  const { env: extraEnv, ...runtimeOptions } = options;
  const env = testEnvironment({
    KIRO_SIDECAR_API_KEY: TEST_TOKEN,
    KIRO_SIDECAR_KIRO_COMMAND: workspace.command,
    KIRO_SIDECAR_DEFAULT_MODE: 'local',
    ...extraEnv,
  });
  const handles: ProcessHandle[] = [];
  const spawn = runtimeOptions.deps?.spawn ?? spawnProcess;
  const { server, runtime } = createServer({
    pollMs: 20,
    toolServerFile: TOOL_SERVER_FILE,
    ...runtimeOptions,
    deps: {
      // The sweep never lists this host's real containers unless a test asks it to.
      listHostContainers: async () => [],
      ...runtimeOptions.deps,
      spawn: (spec, processOptions) => {
        const handle = spawn(spec, processOptions);
        handles.push(handle);
        return handle;
      },
    },
    env,
    stateDir,
    log: (line) => logs.push(line),
  });
  const client = new Client({ name: 'kiro-sidecar-harness', version: '0.0.0' });
  // One hook, children first: the shutdown returns within its budget, maybe
  // before a child has ended, so every child is ended and reaped before the
  // directories it writes into are removed. A failing step cannot skip that.
  t.after(async () => {
    const context = await runtime.context().catch(() => undefined);
    try {
      await runtime.shutdown();
    } finally {
      await endProcesses(handles);
      await context?.manager.settled();
      await client.close();
      await Promise.all([workspace.remove(), removeTree(stateDir)]);
    }
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  // The handshake starts the startup sweep; runs a test writes afterwards are not swept.
  await runtime.sweep();
  return {
    client,
    stateDir,
    workspace,
    logs,
    async call(name, args = {}, callOptions = {}) {
      const { meta, ...requestOptions } = callOptions;
      const result = await client.callTool(
        { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) },
        undefined,
        requestOptions,
      );
      const content = result.content as { type: string; text?: string }[];
      assert.equal(content.length, 1, 'a reply has one content part');
      assert.equal(content[0]?.type, 'text');
      const text = content[0]?.text ?? '';
      return { text, isError: result.isError === true, lines: text.split('\n') };
    },
  };
}

/** The JSON object a reply starts with. */
export function replyJson(reply: Reply): Record<string, unknown> {
  const end = reply.lines.indexOf('}');
  assert.ok(end !== -1, `no JSON object in ${reply.text}`);
  return JSON.parse(reply.lines.slice(0, end + 1).join('\n')) as Record<string, unknown>;
}

/** The last line of a reply. */
export function lastLine(reply: Reply): string {
  return reply.lines[reply.lines.length - 1] ?? '';
}

/** Asserts an error reply with this code; returns its message. */
export function assertError(reply: Reply, code: string, pattern?: RegExp): string {
  assert.ok(reply.isError, `expected ${code}, got a reply: ${reply.text}`);
  assert.ok(reply.text.startsWith(`${code} `), `expected ${code}, got ${reply.text}`);
  if (pattern !== undefined) {
    assert.match(reply.text, pattern);
  }
  return reply.text.slice(code.length + 1);
}

/** Asserts a reply that is not an error. */
export function assertOk(reply: Reply): Reply {
  assert.ok(!reply.isError, `unexpected error: ${reply.text}`);
  return reply;
}

/** Every file under a directory with its content. */
export async function filesUnder(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files.set(path, await readFile(path, 'utf8'));
    }
  }
  return files;
}
