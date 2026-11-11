/**
 * Incoming notifications the client does not take as turn content: Kiro's
 * `_kiro/mcp/status`, other notifications (logged by method and length only),
 * and notifications the SDK cannot deliver. Kiro's frames can hold prompt
 * text and secrets, and the server's stderr goes to a log, so nothing of such
 * a frame may reach stderr, stdout or the lifecycle log.
 */
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_SERVER_TOOLS } from '../../src/session/tool-server.ts';
import { agentText, startFakeKiro } from '../helpers/fake-kiro.ts';
import type { FakeKiro, FakeKiroOptions } from '../helpers/fake-kiro.ts';

const PROCESS_TIMEOUT = { timeout: 30_000 };
const STEP = { timeoutMs: 10_000 } as const;

/** A text no fixture holds, so any trace of it comes from the frames that carry it. */
const MARKER = 'marker-3c9e1f0a-kiro-frame';

/** The server named in `mcpServers`; the fake reports a server called `sidecar` only. */
const SIDECAR_SERVER = { name: 'sidecar', command: '/usr/bin/false', args: [], env: [] };

async function openSession(t: TestContext, scenario: string, options: FakeKiroOptions = {}, mcp = false) {
  const fake = await startFakeKiro(t, scenario, options);
  await fake.client.initialize(STEP);
  const { sessionId } = await fake.client.newSession({ cwd: fake.dir, ...(mcp ? { mcpServers: [SIDECAR_SERVER] } : {}) }, STEP);
  return { fake, sessionId };
}

/**
 * Records what this process writes to stderr and stdout until `stop()`,
 * writes included that the SDK makes through `console`.
 */
function captureOutput(t: TestContext): { readonly text: () => string; readonly stop: () => void } {
  const chunks: string[] = [];
  const restore: Array<() => void> = [];
  for (const stream of [process.stderr, process.stdout]) {
    const write = stream.write;
    stream.write = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]): boolean {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return (write as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
    } as typeof stream.write;
    restore.push(() => {
      stream.write = write;
    });
  }
  const stop = () => {
    for (const undo of restore.splice(0)) {
      undo();
    }
  };
  t.after(stop);
  return { text: () => chunks.join(''), stop };
}

describe('KiroAcpClient: notifications', () => {
  test('_kiro/mcp/status reaches the client; an unknown notification is logged by method and length', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'notifications', {}, true);
    const status = await fake.client.waitForMcpServer(sessionId, 'sidecar', TOOL_SERVER_TOOLS, STEP);
    assert.equal(status.status, 'connected');
    assert.deepEqual([...status.tools], [...TOOL_SERVER_TOOLS]);
    const statuses = fake.lifecycle.flatMap((entry) => (entry.event === 'mcp_status' ? [entry.status] : []));
    assert.deepEqual(statuses, ['connecting', 'connecting', 'connected']);

    const output = captureOutput(t);
    const result = await fake.client.prompt(sessionId, MARKER, STEP);
    output.stop();
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(agentText(fake.events), 'ok');
    assert.equal(output.text().includes(MARKER), false, output.text());
    const notifications = fake.lifecycle.flatMap((entry) => (entry.event === 'notification' ? [entry] : []));
    assert.deepEqual(
      notifications.map((entry) => entry.method),
      ['_kiro/mcp/status', '_kiro/mcp/status', '_kiro/mcp/status', '_kiro/memory/syncStatus', 'agent/unknown_event'],
    );
    assert.ok(notifications.every((entry) => entry.length > 0));
    assert.equal(JSON.stringify(fake.lifecycle).includes(MARKER), false, 'the lifecycle log holds no notification content');
  });

  /** Runs the `marker` turn of `kind` and checks that the marker went nowhere but the wire. */
  async function assertNoTrace(t: TestContext, kind: 'invalid' | 'valid', beforeTurn: (fake: FakeKiro, sessionId: string) => void) {
    const { fake, sessionId } = await openSession(t, 'marker');
    beforeTurn(fake, sessionId);
    const output = captureOutput(t);
    const result = await fake.client.prompt(sessionId, `${kind} ${MARKER}`, STEP);
    // Anything the SDK logs about the frame is written by now: the answer came after it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    output.stop();

    assert.equal(result.stopReason, 'end_turn');
    assert.equal(agentText(fake.events), 'ok', 'the turn went on after the frame');
    assert.equal(fake.client.closeError, undefined, 'the connection stays open');
    assert.equal(output.text().includes(MARKER), false, `the marker reached this process's output:\n${output.text()}`);
    assert.equal(JSON.stringify(fake.lifecycle).includes(MARKER), false, 'the lifecycle log holds the marker');
    assert.equal(JSON.stringify(fake.events).includes(MARKER), false, 'a turn event holds the marker');
  }

  test('a session/update its schema rejects leaves no trace on stderr, stdout or the log', PROCESS_TIMEOUT, async (t) => {
    await assertNoTrace(t, 'invalid', () => {});
  });

  test('a session/update whose handler throws leaves no trace on stderr, stdout or the log', PROCESS_TIMEOUT, async (t) => {
    // A config wait whose check throws from its second call on: the marker's
    // `config_option_update` is stored and the watchers run inside the handler.
    let checks = 0;
    await assertNoTrace(t, 'valid', (fake, sessionId) => {
      fake.client
        .waitForConfig(
          sessionId,
          'marker option',
          () => {
            checks += 1;
            if (checks > 1) {
              throw new Error('the check failed');
            }
            return undefined;
          },
          { timeoutMs: 5_000 },
        )
        .catch(() => {});
    });
    assert.equal(checks, 2, 'the update reached the handler, which threw');
  });
});

