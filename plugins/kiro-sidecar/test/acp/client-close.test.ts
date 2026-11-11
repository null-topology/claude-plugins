/**
 * How the client ends: `session/close` answers, and the stream closing.
 */
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { RequestError } from '@agentclientprotocol/sdk';
import { AcpClientError } from '../../src/acp/errors.ts';
import { closeAnswers, closesReceived, startFakeKiro } from '../helpers/fake-kiro.ts';

const PROCESS_TIMEOUT = { timeout: 30_000 };
const STEP = { timeoutMs: 10_000 } as const;

async function openSession(t: TestContext, scenario: string) {
  const fake = await startFakeKiro(t, scenario);
  await fake.client.initialize(STEP);
  const { sessionId } = await fake.client.newSession({ cwd: fake.dir }, STEP);
  return { fake, sessionId };
}

describe('KiroAcpClient: session/close answers', () => {
  test('-32002 (session not found) counts as closed: {} and the session forgotten', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'close');
    await closeAnswers(fake.dir, 'not-found');
    assert.notEqual(fake.client.configOptions(sessionId), undefined);
    assert.deepEqual(await fake.client.closeSession(sessionId, STEP), {});
    assert.equal(fake.client.configOptions(sessionId), undefined);
    assert.equal(await closesReceived(fake), 1);
    assert.ok(fake.lifecycle.some((entry) => entry.event === 'response' && entry.method === 'session/close' && entry.ok));
  });

  test('another error code still fails the close with the agent error', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'close');
    await closeAnswers(fake.dir, 'error');
    await assert.rejects(fake.client.closeSession(sessionId, STEP), (error: unknown) => {
      assert.ok(error instanceof RequestError, String(error));
      assert.equal(error.code, -32603);
      return true;
    });
    assert.notEqual(fake.client.configOptions(sessionId), undefined, 'a failed close keeps the session');
    assert.equal(fake.client.closeError, undefined);
  });
});

describe('KiroAcpClient: the stream closing', () => {
  // The client tells a stream that ended from one that failed by the SDK's
  // close text `ACP connection closed`; this fails if the SDK changes it.
  test('a stream Kiro closes while it keeps running is stream_closed, not a stream error', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'close-stdout');
    const error = await fake.client.prompt(sessionId, 'close', STEP).then(
      () => assert.fail('the prompt resolved'),
      (failure: unknown) => failure,
    );
    assert.ok(error instanceof AcpClientError, String(error));
    assert.equal(error.code, 'closed');
    assert.equal(error.closeReason, 'stream_closed', error.message);
    assert.equal(error.message, 'Kiro closed its ACP stream');
    // The client kills a child whose stream is gone.
    assert.equal((await fake.client.exited).signal, 'SIGTERM');
  });
});
