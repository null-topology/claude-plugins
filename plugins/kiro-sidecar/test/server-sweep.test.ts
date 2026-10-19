import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { deadIdentity, tempDir } from './helpers/processes.ts';
import { writeRun } from './session/helpers-runs.ts';
import { TEST_TOKEN, metaOf, testEnvironment, waitFor } from './session/manager-helpers.ts';

const SERVER_PATH = fileURLToPath(new URL('../dist/server.js', import.meta.url));

interface Connected {
  readonly client: Client;
  /** Everything the server wrote to stderr so far. */
  stderr(): string;
}

/** The built server on stdio, connected as Claude Code connects it: the handshake ends with `notifications/initialized`. */
async function connect(t: TestContext, stateDir: string): Promise<Connected> {
  const env: Record<string, string> = {};
  const variables = testEnvironment({ KIRO_SIDECAR_API_KEY: TEST_TOKEN, KIRO_SIDECAR_DEFAULT_MODE: 'local', CLAUDE_PLUGIN_DATA: stateDir });
  for (const [name, value] of Object.entries(variables)) {
    if (value !== undefined) {
      env[name] = value;
    }
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_PATH], env, stderr: 'pipe' });
  const chunks: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer | string) => chunks.push(String(chunk)));
  const client = new Client({ name: 'kiro-sidecar-test', version: '0.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  return { client, stderr: () => chunks.join('') };
}

describe('built server: the startup sweep', () => {
  test('the handshake starts it: the run of a dead server becomes lost', { timeout: 15_000 }, async (t) => {
    const stateDir = await tempDir(t);
    const meta = await writeRun(stateDir, {
      driver: await deadIdentity(), mode: 'local', containerName: null, state: 'running', currentTurn: 1,
    });

    const server = await connect(t, stateDir);

    await waitFor(async () => (await metaOf(stateDir, meta.launchId)).state === 'lost', 'the sweep to settle the run');
    await waitFor(
      () => server.stderr().includes(`startup sweep: ${meta.launchId}: state lost; turn 1 result created`),
      'the sweep log line',
    );
    const tools = await server.client.listTools();
    assert.equal(tools.tools.length, 8);
  });

  test('a sweep that fails is logged, and the server keeps answering', { timeout: 15_000 }, async (t) => {
    const stateDir = await tempDir(t);
    // A file where the runs directory belongs: the sweep cannot read it.
    await writeFile(join(stateDir, 'runs'), 'not a directory\n', 'utf8');

    const server = await connect(t, stateDir);

    // The sweep ends in a log line, or, had its failure escaped, in a crash report.
    await waitFor(() => server.stderr() !== '', 'the server to report the sweep');
    const tools = await server.client.listTools();
    assert.equal(tools.tools.length, 8);
    const reply = await server.client.callTool({ name: 'status', arguments: { launchId: 'ks_0123456789ab' } });
    assert.equal(reply.isError, true);
    assert.equal(typeof (reply.content as { text?: unknown }[])[0]?.text, 'string');
    assert.match(server.stderr(), /^kiro-sidecar: startup sweep failed: /m);
  });
});
