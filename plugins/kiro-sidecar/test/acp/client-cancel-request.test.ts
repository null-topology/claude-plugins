import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AnyMessage } from '@agentclientprotocol/sdk';
import type { KiroAcpClient } from '../../src/acp/client.ts';
import { startFakeKiro } from '../helpers/fake-kiro.ts';

const PROCESS_TIMEOUT = { timeout: 30_000 };
const STEP = { timeoutMs: 10_000 } as const;
const DEADLINE_MS = 200;

type Fake = Awaited<ReturnType<typeof startFakeKiro>>;

/** The ids of the requests the fake received for `method`. */
function requestIds(received: readonly AnyMessage[], method: string): unknown[] {
  return received.flatMap((message) => ('method' in message && message.method === method && 'id' in message ? [message.id] : []));
}

/** The request ids of the `$/cancel_request` notifications the fake received. */
function cancelledIds(received: readonly AnyMessage[]): unknown[] {
  return received.flatMap((message) =>
    'method' in message && message.method === '$/cancel_request' && !('id' in message)
      ? [(message.params as { requestId?: unknown } | undefined)?.requestId]
      : [],
  );
}

async function receivedWhen(fake: Fake, condition: (received: AnyMessage[]) => boolean): Promise<AnyMessage[]> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    const received = await fake.received();
    if (condition(received) || performance.now() > deadline) {
      return received;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Collects unhandled rejections while the test runs. */
function watchRejections(t: { after(fn: () => void): void }): unknown[] {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  return seen;
}

/** Any offered value of the session's `model` option. */
function offeredModel(response: { configOptions?: unknown }): string {
  const options = (response.configOptions ?? []) as { id: string; options?: { value: string }[] }[];
  const value = options.find((option) => option.id === 'model')?.options?.[0]?.value;
  assert.ok(value !== undefined, 'the fake offers a model');
  return value;
}

const START_STEPS: {
  readonly scenario: string;
  readonly method: string;
  readonly run: (client: KiroAcpClient, fake: Fake) => Promise<unknown>;
}[] = [
  {
    scenario: 'hang-initialize',
    method: 'initialize',
    run: (client) => client.initialize({ timeoutMs: DEADLINE_MS }),
  },
  {
    scenario: 'hang-session-new',
    method: 'session/new',
    run: async (client, fake) => {
      await client.initialize(STEP);
      return client.newSession({ cwd: fake.dir }, { timeoutMs: DEADLINE_MS });
    },
  },
  {
    scenario: 'hang-session-load',
    method: 'session/load',
    run: async (client, fake) => {
      await client.initialize(STEP);
      const { sessionId } = await client.newSession({ cwd: fake.dir }, STEP);
      return client.loadSession({ sessionId, cwd: fake.dir }, { timeoutMs: DEADLINE_MS });
    },
  },
  {
    scenario: 'hang-set-config',
    method: 'session/set_config_option',
    run: async (client, fake) => {
      await client.initialize(STEP);
      const { sessionId, response } = await client.newSession({ cwd: fake.dir }, STEP);
      return client.setConfig(sessionId, 'model', offeredModel(response), { timeoutMs: DEADLINE_MS });
    },
  },
];

describe('KiroAcpClient: a start step past its deadline withdraws its request', () => {
  for (const { scenario, method, run } of START_STEPS) {
    test(`${method}: sends $/cancel_request, fails with the same timeout error and leaves no unhandled rejection`, PROCESS_TIMEOUT, async (t) => {
      const rejections = watchRejections(t);
      const fake = await startFakeKiro(t, scenario);
      await assert.rejects(run(fake.client, fake), (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'timeout');
        assert.equal((error as Error).message, `${method} did not finish within ${DEADLINE_MS} ms`);
        return true;
      });
      const received = await receivedWhen(fake, (messages) => cancelledIds(messages).length > 0);
      const ids = requestIds(received, method);
      assert.equal(ids.length, 1, `one ${method} request`);
      assert.deepEqual(cancelledIds(received), ids, `$/cancel_request names the ${method} request`);
      assert.equal(fake.client.closeError, undefined, 'the connection stays open');
      // Let any late settlement surface before checking for stray rejections.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(rejections, []);
    });
  }

  test('a start step that answers in time sends no $/cancel_request', PROCESS_TIMEOUT, async (t) => {
    const fake = await startFakeKiro(t, 'cancel-tool');
    await fake.client.initialize({ timeoutMs: DEADLINE_MS * 50 });
    await fake.client.newSession({ cwd: fake.dir }, { timeoutMs: DEADLINE_MS * 50 });
    await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS * 2));
    assert.deepEqual(cancelledIds(await fake.received()), []);
  });

  test('session/prompt past its deadline is not withdrawn with $/cancel_request', PROCESS_TIMEOUT, async (t) => {
    const fake = await startFakeKiro(t, 'cancel-tool');
    await fake.client.initialize(STEP);
    const { sessionId } = await fake.client.newSession({ cwd: fake.dir }, STEP);
    await assert.rejects(fake.client.prompt(sessionId, 'long', { timeoutMs: DEADLINE_MS }), { code: 'timeout' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(cancelledIds(await fake.received()), []);
    await fake.client.cancel(sessionId);
  });
});
