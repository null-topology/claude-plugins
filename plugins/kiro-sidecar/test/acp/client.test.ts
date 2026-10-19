import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_MESSAGE_BYTES } from '@agentclientprotocol/sdk';
import type { AnyMessage } from '@agentclientprotocol/sdk';
import { KiroAcpClient } from '../../src/acp/client.ts';
import { AcpClientError } from '../../src/acp/errors.ts';
import type { TurnEvent } from '../../src/acp/events.ts';
import { spawnLocalKiro } from '../../src/acp/local.ts';
import { agentText, startFakeKiro } from '../helpers/fake-kiro.ts';
import { tempDir } from '../helpers/processes.ts';

const PROCESS_TIMEOUT = { timeout: 30_000 };
const STEP = { timeoutMs: 10_000 } as const;

/** The session id in the recording, after scrubbing. */
const RECORDED_SESSION = 'sess_00000000-0000-4000-8000-000000000001';
const RECORDED_PROMPT =
  "Create a file named hello.txt containing the line 'hello from the smoke test', then run the shell command " +
  "'ls -la' and show its output. End your reply with exactly one line: QUESTION: Should I keep hello.txt?";

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function ofKind<K extends TurnEvent['kind']>(events: readonly TurnEvent[], kind: K): Extract<TurnEvent, { kind: K }>[] {
  return events.filter((event): event is Extract<TurnEvent, { kind: K }> => event.kind === kind);
}

function updatesOf(events: readonly TurnEvent[], sessionUpdate: string): TurnEvent[] {
  return events.filter((event) => event.kind === 'update' && event.update.sessionUpdate === sessionUpdate);
}

/** Results the client sent in answer to the agent's requests. */
function answers(received: readonly AnyMessage[]): unknown[] {
  return received.flatMap((message) => (!('method' in message) && 'result' in message ? [message.result] : []));
}

/** Polls the fake's received log until `condition` holds. */
async function receivedWhen(
  fake: { received(): Promise<AnyMessage[]> },
  condition: (received: AnyMessage[]) => boolean,
  timeoutMs = 5_000,
): Promise<AnyMessage[]> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const received = await fake.received();
    if (condition(received) || performance.now() > deadline) {
      return received;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assertClosed(error: unknown, reason: string): AcpClientError {
  assert.ok(error instanceof AcpClientError, `expected AcpClientError, got ${String(error)}`);
  assert.equal(error.code, 'closed');
  assert.equal(error.closeReason, reason);
  return error;
}

async function openSession(t: Parameters<typeof startFakeKiro>[0], scenario: string, options = {}) {
  const fake = await startFakeKiro(t, scenario, options);
  await fake.client.initialize(STEP);
  const { sessionId } = await fake.client.newSession({ cwd: fake.dir }, STEP);
  return { fake, sessionId };
}

describe('KiroAcpClient: recorded v3 turn (replayed)', () => {
  test('replays initialize, session/new, a model change and a turn with three permission requests', PROCESS_TIMEOUT, async (t) => {
    const fake = await startFakeKiro(t, 'replay');
    const init = await fake.client.initialize({ timeoutMs: 45_000 });
    assert.equal(init.protocolVersion, 1);
    const { sessionId } = await fake.client.newSession({ cwd: fake.dir }, { timeoutMs: 30_000 });
    assert.equal(sessionId, RECORDED_SESSION);
    assert.equal(fake.client.configOptions(sessionId)?.find((o) => o.id === 'model')?.currentValue, 'auto');

    const options = await fake.client.setConfig(sessionId, 'model', 'claude-haiku-4.5', { timeoutMs: 15_000 });
    assert.equal(options.find((o) => o.id === 'model')?.currentValue, 'claude-haiku-4.5');

    const result = await fake.client.prompt(sessionId, RECORDED_PROMPT, STEP);
    assert.equal(result.stopReason, 'end_turn');

    const events = fake.events;
    const text = agentText(events);
    assert.ok(text.startsWith("I'll create the file, run the command, and show the output."), text.slice(0, 80));
    assert.ok(text.trimEnd().endsWith('QUESTION: Should I keep hello.txt?'), text.slice(-80));
    assert.equal(ofKind(events, 'agent_text').length, 51);
    const toolCalls = ofKind(events, 'tool_call');
    assert.equal(toolCalls.length, 3);
    assert.equal(toolCalls.at(-1)?.title, 'Run Command');
    assert.equal(ofKind(events, 'tool_call_update').length, 8);

    const answered = ofKind(events, 'permission_answered');
    assert.equal(answered.length, 3);
    assert.deepEqual(
      answered.map((answer) => answer.title),
      ofKind(events, 'permission_requested').map((request) => request.title),
    );
    for (const answer of answered) {
      assert.equal(answer.decision, 'allow');
      assert.equal(answer.optionId, 'accept');
      assert.equal(answer.optionKind, 'allow_once');
      assert.equal(answer.via, 'policy');
    }
    assert.deepEqual(answers(await fake.received()), [
      { outcome: { outcome: 'selected', optionId: 'accept' } },
      { outcome: { outcome: 'selected', optionId: 'accept' } },
      { outcome: { outcome: 'selected', optionId: 'accept' } },
    ]);
    // The recording ends with one session_info_update sent after the turn's result.
    await waitFor(() => updatesOf(events, 'session_info_update').length >= 28, 'the trailing session_info_update');
    assert.equal(updatesOf(events, 'session_info_update').length, 28);
    assert.equal(fake.client.openPermissionRequests, 0);
  });

  test('the lifecycle sink receives no message text or tool content when debug is off', PROCESS_TIMEOUT, async (t) => {
    const fake = await startFakeKiro(t, 'replay');
    await fake.client.initialize(STEP);
    const { sessionId } = await fake.client.newSession({ cwd: fake.dir }, STEP);
    await fake.client.setConfig(sessionId, 'model', 'claude-haiku-4.5', STEP);
    await fake.client.prompt(sessionId, RECORDED_PROMPT, STEP);

    const logged = JSON.stringify(fake.lifecycle);
    for (const fragment of ['hello', 'QUESTION', 'ls -la', 'Run Command', 'Write File', "I'll create", 'smoke test']) {
      assert.equal(logged.includes(fragment), false, `lifecycle log contains ${JSON.stringify(fragment)}`);
    }
    assert.equal(fake.lifecycle.some((entry) => entry.event === 'frame'), false);
    const updates = fake.lifecycle.filter((entry) => entry.event === 'update');
    assert.ok(updates.length >= 89, `logged ${updates.length} updates`);
    assert.ok(updates.every((entry) => entry.event === 'update' && entry.length > 0));
    assert.equal(fake.lifecycle.filter((entry) => entry.event === 'permission').length, 3);
    assert.ok(fake.lifecycle.some((entry) => entry.event === 'response' && entry.stopReason === 'end_turn'));
  });

  test('debug frames send every frame to the lifecycle sink', PROCESS_TIMEOUT, async (t) => {
    const fake = await startFakeKiro(t, 'replay', { debugFrames: true });
    await fake.client.initialize(STEP);
    const frames = fake.lifecycle.filter((entry) => entry.event === 'frame');
    assert.deepEqual(
      frames.map((entry) => entry.event === 'frame' && entry.dir),
      ['c2a', 'a2c'],
    );
  });

  test('deny answers each recorded request with its reject option', PROCESS_TIMEOUT, async (t) => {
    const fake = await startFakeKiro(t, 'replay', { decidePermission: () => 'deny' });
    await fake.client.initialize(STEP);
    const { sessionId } = await fake.client.newSession({ cwd: fake.dir }, STEP);
    await fake.client.setConfig(sessionId, 'model', 'claude-haiku-4.5', STEP);
    // The replay does not react to the answer, so the turn still ends end_turn.
    await fake.client.prompt(sessionId, RECORDED_PROMPT, STEP);
    const answered = ofKind(fake.events, 'permission_answered');
    assert.deepEqual(
      answered.map((answer) => [answer.decision, answer.optionId, answer.optionKind]),
      Array(3).fill(['deny', 'reject', 'reject_once']),
    );
    assert.deepEqual(answers(await fake.received()), Array(3).fill({ outcome: { outcome: 'selected', optionId: 'reject' } }));
  });
});

describe('KiroAcpClient: scenarios scripted from measured v3 behaviour', () => {
  test('cancel during a running tool ends the turn cancelled (scripted)', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'cancel-tool');
    const turn = fake.client.prompt(sessionId, 'run something long', STEP);
    await waitFor(() => ofKind(fake.events, 'tool_call').length === 1, 'the tool call');
    await fake.client.cancel(sessionId);
    assert.equal((await turn).stopReason, 'cancelled');
    const update = ofKind(fake.events, 'tool_call_update').at(-1);
    assert.equal(update?.status, 'failed');
  });

  test('cancel with an open permission request ends cancelled and settles the handler (scripted)', PROCESS_TIMEOUT, async (t) => {
    // A decision that never arrives keeps the request open on the client side.
    const { fake, sessionId } = await openSession(t, 'cancel-permission', {
      decidePermission: () => new Promise<never>(() => {}),
    });
    const turn = fake.client.prompt(sessionId, 'run ls', STEP);
    await waitFor(() => fake.client.openPermissionRequests === 1, 'the open permission request');
    await fake.client.cancel(sessionId);
    assert.equal((await turn).stopReason, 'cancelled');
    assert.equal(fake.client.openPermissionRequests, 0);
    const answered = ofKind(fake.events, 'permission_answered');
    assert.equal(answered.length, 1);
    assert.equal(answered[0]?.outcome, 'cancelled');
    assert.equal(answered[0]?.via, 'withdrawn');
    assert.ok(fake.lifecycle.some((entry) => entry.event === 'permission' && entry.via === 'withdrawn'));
    const received = await receivedWhen(fake, (messages) => answers(messages).length === 1);
    assert.deepEqual(answers(received), [{ outcome: { outcome: 'cancelled' } }]);
    assert.equal(ofKind(fake.events, 'tool_call_update').at(-1)?.status, 'failed');
  });

  test('a second prompt during a turn ends the first one cancelled (scripted)', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'second-prompt');
    const first = fake.client.prompt(sessionId, 'first', STEP);
    await waitFor(() => ofKind(fake.events, 'tool_call').length === 1, 'the first tool call');
    const second = fake.client.prompt(sessionId, 'second', STEP);
    assert.equal((await first).stopReason, 'cancelled');
    assert.equal((await second).stopReason, 'end_turn');
    assert.equal(agentText(fake.events), 'second');
  });

  test('an exit mid-turn rejects the pending prompt at once, and later steps too (scripted)', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'exit-mid-turn');
    let exitedAt = 0;
    void fake.client.exited.then(() => {
      exitedAt = performance.now();
    });
    const error = await fake.client.prompt(sessionId, 'work', STEP).then(
      () => assert.fail('the prompt resolved'),
      (failure: unknown) => failure,
    );
    const rejectedAt = performance.now();
    const closed = assertClosed(error, 'exited');
    assert.equal(closed.exit?.code, 3);
    assert.ok(exitedAt > 0 && rejectedAt - exitedAt < 1_000, `rejected ${rejectedAt - exitedAt} ms after the exit`);
    await assert.rejects(fake.client.newSession({ cwd: fake.dir }), (later: unknown) => later === closed);
    await assert.rejects(fake.client.cancel(sessionId), (later: unknown) => later === closed);
    assert.equal(await fake.client.closed, closed);
  });

  test('an oversized message closes the connection and kills the child (scripted)', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'oversized', {
      maxMessageBytes: 64 * 1024,
      oversizeBytes: 128 * 1024,
    });
    await assert.rejects(fake.client.prompt(sessionId, 'big', STEP), (error: unknown) => {
      assertClosed(error, 'message_too_large');
      return true;
    });
    const exit = await fake.client.exited;
    assert.equal(exit.signal, 'SIGTERM');
    assert.ok(fake.lifecycle.some((entry) => entry.event === 'kill' && entry.reason === 'message_too_large'));
  });

  test('the SDK default cap of 32 MiB applies when none is given (scripted)', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'oversized', { oversizeBytes: DEFAULT_MAX_MESSAGE_BYTES + 1 });
    await assert.rejects(fake.client.prompt(sessionId, 'big', STEP), (error: unknown) => {
      assertClosed(error, 'message_too_large');
      return true;
    });
    assert.equal((await fake.client.exited).signal, 'SIGTERM');
  });

  test('fs, terminal and extension requests get method-not-found and the turn completes (scripted)', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'fs-terminal');
    const result = await fake.client.prompt(sessionId, 'touch files', STEP);
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(agentText(fake.events), 'codes: -32601,-32601,-32601,-32601');
    const refused = fake.lifecycle.flatMap((entry) => (entry.event === 'agent_request' ? [entry.method] : []));
    assert.deepEqual(refused, ['fs/read_text_file', 'fs/write_text_file', 'terminal/create']);
    const initialize = (await fake.received()).find((message) => 'method' in message && message.method === 'initialize');
    assert.ok(initialize !== undefined && 'params' in initialize);
    assert.deepEqual((initialize.params as { clientCapabilities: unknown }).clientCapabilities, {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
  });

  for (const [decision, expected] of [
    [
      'allow',
      [
        { outcome: { outcome: 'selected', optionId: 'yes-always' } },
        { outcome: { outcome: 'selected', optionId: 'never' } },
        { outcome: { outcome: 'selected', optionId: 'ok' } },
        { outcome: { outcome: 'cancelled' } },
      ],
    ],
    [
      'deny',
      [
        { outcome: { outcome: 'selected', optionId: 'no' } },
        { outcome: { outcome: 'selected', optionId: 'never' } },
        { outcome: { outcome: 'cancelled' } },
        { outcome: { outcome: 'cancelled' } },
      ],
    ],
  ] as const) {
    test(`${decision}: missing option kinds fall back to a reject kind, else cancelled (scripted)`, PROCESS_TIMEOUT, async (t) => {
      const { fake, sessionId } = await openSession(t, 'kinds-missing', { decidePermission: () => decision });
      const result = await fake.client.prompt(sessionId, 'write', STEP);
      assert.equal(result.stopReason, 'end_turn');
      assert.deepEqual(JSON.parse(agentText(fake.events)), expected);
      const vias = ofKind(fake.events, 'permission_answered').map((answer) => answer.via);
      assert.deepEqual(vias, decision === 'allow' ? ['policy', 'fallback', 'policy', 'fallback'] : ['policy', 'policy', 'fallback', 'fallback']);
    });
  }

  test('setConfig checks offered values; effortLevel appears after model (scripted)', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'config');
    const client = fake.client;
    const ids = () => client.configOptions(sessionId)?.map((option) => option.id) ?? [];
    assert.equal(ids().includes('effortLevel'), false);

    await assert.rejects(client.setConfig(sessionId, 'effortLevel', 'high', STEP), {
      code: 'invalid_config',
      message: /No config option "effortLevel"; offered options: mode, model, /,
    });
    await assert.rejects(client.setConfig(sessionId, 'model', 'gpt-9', STEP), {
      code: 'invalid_config',
      message: /offered values: auto, claude-opus-5\.5, claude-haiku-4\.5$/,
    });
    const sent = async () =>
      (await fake.received()).filter((message) => 'method' in message && message.method === 'session/set_config_option');
    assert.equal((await sent()).length, 0, 'a rejected value is never sent');

    await client.setConfig(sessionId, 'model', 'claude-opus-5.5', STEP);
    const after = ids();
    assert.equal(after[after.indexOf('model') + 1], 'effortLevel');
    assert.ok(ofKind(fake.events, 'config_options').some((event) => event.configOptions.some((o) => o.id === 'effortLevel')));

    await assert.rejects(client.setConfig(sessionId, 'effortLevel', 'turbo', STEP), {
      code: 'invalid_config',
      message: /offered values: low, medium, high, xhigh, max$/,
    });
    const options = await client.setConfig(sessionId, 'effortLevel', 'xhigh', STEP);
    assert.equal(options.find((option) => option.id === 'effortLevel')?.currentValue, 'xhigh');
    assert.equal((await sent()).length, 2);
  });

  test('waitForConfigOption resolves on an offered option and rejects like a step (scripted)', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'config');
    const client = fake.client;
    const model = await client.waitForConfigOption(sessionId, 'model', { timeoutMs: 1 });
    assert.equal(model.currentValue, 'auto', 'an option already offered resolves at once');

    await assert.rejects(client.waitForConfigOption(sessionId, 'effortLevel', { timeoutMs: 100 }), {
      code: 'timeout',
      message: 'the effortLevel option was not offered within 100 ms',
    });
    await assert.rejects(client.waitForConfigOption(sessionId, 'effortLevel', { signal: AbortSignal.abort() }), {
      code: 'aborted',
      message: 'effortLevel option was aborted',
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(client.waitForConfigOption(sessionId, 'effortLevel', { signal: controller.signal }), {
      code: 'aborted',
    });

    // Offered by the model change: the wait sees the stored list and sends nothing itself.
    const offered = client.waitForConfigOption(sessionId, 'effortLevel', STEP);
    await client.setConfig(sessionId, 'model', 'claude-opus-5.5', STEP);
    assert.equal((await offered).currentValue, 'medium');
    const sent = (await fake.received()).filter((message) => 'method' in message && message.method === 'session/set_config_option');
    assert.equal(sent.length, 1);

    const pending = assert.rejects(client.waitForConfigOption(sessionId, 'absent', STEP), (error: unknown) => {
      assertClosed(error, 'terminated');
      return true;
    });
    await client.terminate(2_000);
    await pending;
  });

  test('session/load reports the replayed history as replay events (scripted)', PROCESS_TIMEOUT, async (t) => {
    const fake = await startFakeKiro(t, 'load');
    await fake.client.initialize(STEP);
    const sessionId = 'sess_00000000-0000-4000-8000-000000000042';
    await fake.client.loadSession({ sessionId, cwd: fake.dir }, { timeoutMs: 30_000 });
    const replayed = fake.events.filter((event) => 'replay' in event && event.replay);
    assert.deepEqual(
      replayed.map((event) => (event.kind === 'update' ? event.update.sessionUpdate : event.kind)),
      ['user_message_chunk', 'agent_text'],
    );
    assert.equal(agentText(fake.events, true), 'Earlier answer');
    await fake.client.prompt(sessionId, 'continue', STEP);
    assert.equal(agentText(fake.events), 'ok');
  });

  test('session/close answers and the process stays alive (scripted)', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'close');
    assert.deepEqual(await fake.client.closeSession(sessionId, STEP), {});
    const outcome = await Promise.race([
      fake.client.exited.then(() => 'exited'),
      new Promise((resolve) => setTimeout(() => resolve('alive'), 300)),
    ]);
    assert.equal(outcome, 'alive');
    assert.equal(fake.client.configOptions(sessionId), undefined);
    const next = await fake.client.newSession({ cwd: fake.dir }, STEP);
    assert.notEqual(next.sessionId, sessionId);
  });

  test('the session id falls back to _meta.id (scripted, not seen in recordings)', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'meta-id');
    assert.equal(sessionId, 'sess_00000000-0000-4000-8000-100000000001');
    assert.equal((await fake.client.prompt(sessionId, 'hi', STEP)).stopReason, 'end_turn');
  });
});

describe('KiroAcpClient: step limits and termination', () => {
  test('a step rejects on its timeout or abort signal, and the connection stays open', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'cancel-tool');
    await assert.rejects(fake.client.prompt(sessionId, 'long', { timeoutMs: 100 }), { code: 'timeout' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(fake.client.prompt(sessionId, 'long', { signal: controller.signal }), { code: 'aborted' });
    await assert.rejects(fake.client.initialize({ signal: AbortSignal.abort() }), { code: 'aborted' });
    assert.equal(fake.client.closeError, undefined);
    await fake.client.cancel(sessionId);
  });

  test('terminate() closes the connection, settles open handlers and ends the child', PROCESS_TIMEOUT, async (t) => {
    const { fake, sessionId } = await openSession(t, 'cancel-permission', {
      decidePermission: () => new Promise<never>(() => {}),
    });
    const turn = fake.client.prompt(sessionId, 'run ls', STEP);
    const settled = turn.then(
      () => assert.fail('the prompt resolved'),
      (error: unknown) => Promise.reject(error),
    );
    settled.catch(() => {});
    await waitFor(() => fake.client.openPermissionRequests === 1, 'the open permission request');
    const exit = await fake.client.terminate(2_000);
    assert.equal(exit.signal, 'SIGTERM');
    await assert.rejects(settled, (error: unknown) => {
      assertClosed(error, 'terminated');
      return true;
    });
    assert.equal(fake.client.openPermissionRequests, 0);
  });

  test('after terminate() every step fails with the same closed error', PROCESS_TIMEOUT, async (t) => {
    const fake = await startFakeKiro(t, 'idle');
    await fake.client.terminate(2_000);
    await assert.rejects(fake.client.initialize(STEP), (error: unknown) => error === fake.client.closeError);
    assertClosed(fake.client.closeError, 'terminated');
  });

  test('a command that cannot start fails the first step as exited', PROCESS_TIMEOUT, async (t) => {
    const dir = await tempDir(t);
    const handle = spawnLocalKiro({ kiroCommand: `${dir}/no-such-kiro-cli`, dir, serverEnv: {} });
    const client = new KiroAcpClient(handle, { decidePermission: () => 'deny' });
    await assert.rejects(client.initialize(STEP), (error: unknown) => {
      const closed = assertClosed(error, 'exited');
      assert.match(closed.message, /could not start: .*ENOENT/);
      return true;
    });
  });
});
