/**
 * A3: each `_kiro/mcp/status` is a full snapshot of its session's MCP
 * servers, as Kiro documents it. The fake sends the notifications of
 * `fake-mcp-script.json` after the `session/new` answer (`fake-mcp-status`
 * `script`).
 */
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AcpClientError } from '../../src/acp/errors.ts';
import { TOOL_SERVER_TOOLS } from '../../src/session/tool-server.ts';
import { startFakeKiro } from '../helpers/fake-kiro.ts';
import type { FakeKiro } from '../helpers/fake-kiro.ts';

const PROCESS_TIMEOUT = { timeout: 30_000 };
const STEP = { timeoutMs: 10_000 } as const;
const SIDECAR_SERVER = { name: 'sidecar', command: '/usr/bin/false', args: [], env: [] };
const TOOLS = TOOL_SERVER_TOOLS.map((name) => ({ name }));

const server = (name: string, status = 'connected') => ({ name, status, tools: status === 'connected' ? TOOLS : [] });
const snapshot = (servers: unknown, extra: Record<string, unknown> = {}) => ({ sessionId: '$SESSION', servers, ...extra });

/** Opens a session whose fake plays `script` as its `_kiro/mcp/status` notifications, and waits until all are handled. */
async function playScript(t: TestContext, script: readonly unknown[]): Promise<{ fake: FakeKiro; sessionId: string }> {
  const fake = await startFakeKiro(t, 'default');
  await writeFile(join(fake.dir, 'fake-mcp-status'), 'script');
  await writeFile(join(fake.dir, 'fake-mcp-script.json'), JSON.stringify(script));
  await fake.client.initialize(STEP);
  const { sessionId } = await fake.client.newSession({ cwd: fake.dir, mcpServers: [SIDECAR_SERVER] }, STEP);
  const deadline = performance.now() + 10_000;
  const handled = () => fake.lifecycle.filter((entry) => entry.event === 'notification' && entry.method === '_kiro/mcp/status').length;
  while (handled() < script.length || !(await scriptDone(fake.dir))) {
    assert.ok(performance.now() < deadline, 'the script was not played');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { fake, sessionId };
}

async function scriptDone(dir: string): Promise<boolean> {
  const log = await readFile(join(dir, 'fake-tools.jsonl'), 'utf8').catch(() => '');
  return log.includes('"mcp_script_done"');
}

describe('KiroAcpClient: _kiro/mcp/status is a snapshot (A3)', () => {
  test('a server a later snapshot does not list is forgotten', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await playScript(t, [
      snapshot([server('sidecar'), server('other')]),
      snapshot([server('other', 'connecting')]),
    ]);
    assert.equal(fake.client.mcpServerStatus(sessionId, 'sidecar'), undefined);
    assert.equal(fake.client.mcpServerStatus(sessionId, 'other')?.status, 'connecting');
  });

  test('an empty snapshot forgets every server of the session', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await playScript(t, [snapshot([server('sidecar')]), snapshot([])]);
    assert.equal(fake.client.mcpServerStatus(sessionId, 'sidecar'), undefined);
    await assert.rejects(
      fake.client.waitForMcpServer(sessionId, 'sidecar', TOOL_SERVER_TOOLS, { timeoutMs: 200 }),
      (error: unknown) => error instanceof AcpClientError && error.code === 'timeout',
    );
  });

  test('a malformed entry is skipped; the rest of its snapshot still replaces the earlier one', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await playScript(t, [
      snapshot([server('sidecar'), server('other')]),
      snapshot([{ name: 'other' }, { status: 'connected' }, 'sidecar', null, server('third', 'failed')]),
    ]);
    assert.equal(fake.client.mcpServerStatus(sessionId, 'sidecar'), undefined);
    assert.equal(fake.client.mcpServerStatus(sessionId, 'other'), undefined);
    assert.equal(fake.client.mcpServerStatus(sessionId, 'third')?.status, 'failed');
  });

  test('a malformed notification changes nothing', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await playScript(t, [
      snapshot([server('sidecar')], { accessModeFilteredServers: [] }),
      { servers: [] },
      { sessionId: 42, servers: [] },
      snapshot('none'),
      snapshot({ sidecar: 'failed' }),
      snapshot(null, { accessModeFilteredServers: ['sidecar'] }),
    ]);
    const status = await fake.client.waitForMcpServer(sessionId, 'sidecar', TOOL_SERVER_TOOLS, { timeoutMs: 200 });
    assert.equal(status.status, 'connected');
    assert.deepEqual(fake.client.mcpFiltered(sessionId)?.servers, []);
  });

  test('a snapshot that names the server among the filtered ones fails the wait at once', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await playScript(t, [
      snapshot([], { accessMode: 'registry', accessModeFilteredServers: ['sidecar', 7], unresolvedRegistryServers: [] }),
    ]);
    assert.deepEqual(fake.client.mcpFiltered(sessionId), { servers: ['sidecar'], accessMode: 'registry' });
    const began = performance.now();
    await assert.rejects(
      fake.client.waitForMcpServer(sessionId, 'sidecar', TOOL_SERVER_TOOLS, { timeoutMs: 5_000 }),
      (error: unknown) =>
        error instanceof AcpClientError &&
        error.code === 'mcp_filtered' &&
        error.message === 'organization MCP settings filtered out the sidecar server (access mode registry)',
    );
    assert.ok(performance.now() - began < 1_000, 'it does not wait for the timeout');
  });

  test('a later snapshot that no longer names it lifts the filter', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await playScript(t, [
      snapshot([], { accessMode: 'registry', accessModeFilteredServers: ['sidecar'] }),
      snapshot([server('sidecar')]),
    ]);
    assert.deepEqual(fake.client.mcpFiltered(sessionId), { servers: [], accessMode: null });
    assert.equal((await fake.client.waitForMcpServer(sessionId, 'sidecar', TOOL_SERVER_TOOLS, STEP)).status, 'connected');
  });
});
