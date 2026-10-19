import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { toTurnEvent } from '../../src/acp/events.ts';
import { isOwnToolRequest, SidecarCalls } from '../../src/session/sidecar-calls.ts';
import { MESSAGE_KEPT_CHARS, MESSAGES_KEPT_TOTAL_CHARS, RESULT_KEPT_CHARS } from '../../src/text/limits.ts';
import { messagesBlock } from '../../src/text/messages.ts';
import { buildSecretSet } from '../../src/text/redact.ts';

const SECRET = 'ksk_fixture_secret_0123456789abcdef';
const SECRETS = buildSecretSet({ apiKey: SECRET, env: {} });
const AT = new Date('2026-10-19T08:30:15.250Z');

function calls(): SidecarCalls {
  return new SidecarCalls(SECRETS, () => AT);
}

function rawCall(tool: string, args: unknown, toolId = `sidecar::${tool}`) {
  return { sessionUpdate: 'tool_call', rawInput: { tool_id: toolId, arguments: args } };
}

/** Notes and completes one call; returns what the update recorded. */
function complete(recorder: SidecarCalls, id: string, tool: string, args: unknown, toolId?: string) {
  recorder.call(id, `@sidecar/${tool}`, rawCall(tool, args, toolId));
  return recorder.update(id, 'completed');
}

/** The characters the message lines of the block take in a reply, each with its line break; the header is not counted. */
function blockChars(messages: readonly string[]): number {
  return messagesBlock(messages)
    .slice(1)
    .reduce((total, line) => total + line.length + 1, 0);
}

describe('SidecarCalls', () => {
  test('messages are recorded in call order on their completed update only', () => {
    const recorder = calls();
    recorder.call('a', '@sidecar/send_message', rawCall('send_message', { text: 'first' }));
    recorder.call('b', '@sidecar/send_message', rawCall('send_message', { text: 'second' }));
    assert.equal(recorder.update('a', 'pending'), undefined);
    assert.equal(recorder.update('a', 'in_progress'), undefined);
    assert.deepEqual(recorder.summary().messages, []);
    assert.equal(recorder.update('a', 'completed'), 'message');
    assert.equal(recorder.update('b', 'completed'), 'message');
    assert.equal(recorder.update('b', 'completed'), undefined, 'a second completed update records nothing');
    assert.deepEqual(recorder.summary(), { messages: ['first', 'second'], messagesDropped: 0, completion: null });
  });

  test('a failed call, an open call, a non-string text and an unknown id record nothing', () => {
    const recorder = calls();
    recorder.call('failed', '@sidecar/send_message', rawCall('send_message', { text: 'failed' }));
    assert.equal(recorder.update('failed', 'failed'), undefined);
    assert.equal(recorder.update('failed', 'completed'), undefined, 'a failed call is forgotten');
    recorder.call('open', '@sidecar/send_message', rawCall('send_message', { text: 'still open' }));
    recorder.update('open', 'in_progress');
    assert.equal(complete(recorder, 'number', 'send_message', { text: 42 }), undefined);
    assert.equal(complete(recorder, 'missing', 'send_message', {}), undefined);
    assert.equal(complete(recorder, 'no-args', 'complete_task', null), undefined);
    assert.equal(complete(recorder, 'object', 'complete_task', { result: { text: 'x' } }), undefined);
    assert.equal(recorder.update('never-noted', 'completed'), undefined);
    assert.deepEqual(recorder.summary(), { messages: [], messagesDropped: 0, completion: null });
  });

  test('a call needs the exact title and the exact tool_id', () => {
    const recorder = calls();
    recorder.call('wrong-id', '@sidecar/send_message', rawCall('send_message', { text: 'a' }, 'sidecar::complete_task'));
    recorder.call('tool-ids', '@sidecar/send_message', {
      rawInput: { tool_ids: ['sidecar::send_message'], arguments: { text: 'b' } },
    });
    recorder.call('no-input', '@sidecar/send_message', { sessionUpdate: 'tool_call' });
    recorder.call('other-server', '@other/send_message', rawCall('send_message', { text: 'c' }));
    recorder.call('spaced', '@sidecar/send_message ', rawCall('send_message', { text: 'd' }));
    recorder.call('loose-id', '@sidecar/send_message', rawCall('send_message', { text: 'e' }, 'sidecar::send_message '));
    recorder.call('no-title', undefined, rawCall('send_message', { text: 'f' }));
    for (const id of ['wrong-id', 'tool-ids', 'no-input', 'other-server', 'spaced', 'loose-id', 'no-title']) {
      assert.equal(recorder.update(id, 'completed'), undefined, id);
    }
    assert.deepEqual(recorder.summary().messages, []);
  });

  test('a message is redacted before it is cut at 4 000 with a marker', () => {
    const recorder = calls();
    const head = 'x'.repeat(MESSAGE_KEPT_CHARS - 10);
    complete(recorder, 'long', 'send_message', { text: `${head}${SECRET}${'y'.repeat(100)}` });
    complete(recorder, 'exact', 'send_message', { text: 'z'.repeat(MESSAGE_KEPT_CHARS) });
    const [long, exact] = recorder.summary().messages;
    assert.equal(long, `${head}[REDACTED] [...]`);
    assert.equal(exact, 'z'.repeat(MESSAGE_KEPT_CHARS));
  });

  test('the latest messages within 12 000 are kept; messagesDropped counts the earlier ones', () => {
    const recorder = calls();
    const full = (letter: string) => letter.repeat(MESSAGE_KEPT_CHARS + 50);
    complete(recorder, '1', 'send_message', { text: 'small one' });
    complete(recorder, '2', 'send_message', { text: full('a') });
    complete(recorder, '3', 'send_message', { text: full('b') });
    complete(recorder, '4', 'send_message', { text: full('c') });
    // Three cut messages with their marker and their lines take 3 * 4 009 characters: only two fit.
    const kept = recorder.summary();
    assert.equal(kept.messagesDropped, 2);
    assert.deepEqual(
      kept.messages.map((message) => message.slice(0, 1)),
      ['b', 'c'],
    );
    assert.ok(kept.messages.every((message) => message.endsWith(' [...]')));
    complete(recorder, '5', 'send_message', { text: 'tail' });
    const after = recorder.summary();
    assert.equal(after.messagesDropped, 2);
    assert.deepEqual(after.messages.map((message) => message.slice(0, 4)), ['bbbb', 'cccc', 'tail']);
    assert.ok(blockChars(after.messages) <= MESSAGES_KEPT_TOTAL_CHARS, `kept ${blockChars(after.messages)}`);
  });

  test('messages completed out of call order are kept in call order, the latest calls first to stay', () => {
    const recorder = calls();
    const note = (id: string, text: string) => recorder.call(id, '@sidecar/send_message', rawCall('send_message', { text }));
    note('one', 'one');
    note('two', 'two');
    assert.equal(recorder.update('two', 'completed'), 'message');
    assert.equal(recorder.update('one', 'completed'), 'message');
    assert.deepEqual(recorder.summary(), { messages: ['one', 'two'], messagesDropped: 0, completion: null });

    const full = (letter: string) => letter.repeat(MESSAGE_KEPT_CHARS + 50);
    const late = calls();
    for (const letter of ['a', 'b', 'c', 'd']) {
      late.call(letter, '@sidecar/send_message', rawCall('send_message', { text: full(letter) }));
    }
    for (const letter of ['d', 'c', 'b', 'a']) {
      assert.equal(late.update(letter, 'completed'), 'message', letter);
    }
    // Only two cut messages fit: the calls of c and d, the latest, whatever order they completed in.
    const kept = late.summary();
    assert.deepEqual(kept.messages.map((message) => message.slice(0, 1)), ['c', 'd']);
    assert.equal(kept.messagesDropped, 2);
  });

  test('a message of a call earlier than a dropped one is dropped too, even when it would fit', () => {
    const recorder = calls();
    const full = (letter: string) => letter.repeat(MESSAGE_KEPT_CHARS + 50);
    recorder.call('early', '@sidecar/send_message', rawCall('send_message', { text: 'early' }));
    for (const letter of ['a', 'b', 'c']) {
      complete(recorder, letter, 'send_message', { text: full(letter) });
    }
    assert.equal(recorder.summary().messagesDropped, 1, 'the message of call a is dropped');
    assert.equal(recorder.update('early', 'completed'), 'message');
    const kept = recorder.summary();
    assert.deepEqual(kept.messages.map((message) => message.slice(0, 1)), ['b', 'c']);
    assert.equal(kept.messagesDropped, 2);
    complete(recorder, 'tail', 'send_message', { text: 'tail' });
    const after = recorder.summary();
    assert.deepEqual(after.messages.map((message) => message.slice(0, 4)), ['bbbb', 'cccc', 'tail']);
    assert.equal(after.messagesDropped, 2);
  });

  test('a message counts with its line in the block: the total holds exactly 12 000', () => {
    const recorder = calls();
    const line = MESSAGES_KEPT_TOTAL_CHARS / 3 - 3;
    for (const letter of ['a', 'b', 'c']) {
      complete(recorder, letter, 'send_message', { text: letter.repeat(line) });
    }
    const exact = recorder.summary();
    assert.equal(exact.messagesDropped, 0);
    assert.equal(blockChars(exact.messages), MESSAGES_KEPT_TOTAL_CHARS);
    complete(recorder, 'd', 'send_message', { text: 'd' });
    const after = recorder.summary();
    assert.equal(after.messagesDropped, 1);
    assert.deepEqual(after.messages.map((message) => message.slice(0, 1)), ['b', 'c', 'd']);
  });

  test('many tiny messages cannot grow the block past 12 000', () => {
    const recorder = calls();
    const sent = 5_000;
    for (let index = 0; index < sent; index += 1) {
      complete(recorder, `tiny-${index}`, 'send_message', { text: 'ok' });
    }
    const { messages, messagesDropped } = recorder.summary();
    // Each `- ok` line with its line break is 5 characters.
    assert.equal(messages.length, MESSAGES_KEPT_TOTAL_CHARS / 5);
    assert.equal(messagesDropped, sent - messages.length);
    assert.ok(blockChars(messages) <= MESSAGES_KEPT_TOTAL_CHARS, `block lines take ${blockChars(messages)}`);
  });

  test('the completion comes from the first completed complete_task, redacted then cut at 20 000', () => {
    const recorder = calls();
    const head = 'r'.repeat(RESULT_KEPT_CHARS - 5);
    assert.equal(complete(recorder, 'first', 'complete_task', { result: `${head}${SECRET} rest` }), 'completion');
    assert.equal(complete(recorder, 'second', 'complete_task', { result: 'a later result' }), 'ignored');
    assert.deepEqual(recorder.summary().completion, { result: `${head}[REDA [...]`, at: '2026-10-19T08:30:15Z' });
  });

  test('the completion time is when the completed update is seen', () => {
    let now = new Date('2026-10-19T09:00:00.000Z');
    const recorder = new SidecarCalls(SECRETS, () => now);
    recorder.call('done', '@sidecar/complete_task', rawCall('complete_task', { result: 'Done.' }));
    now = new Date('2026-10-19T09:00:42.900Z');
    recorder.update('done', 'completed');
    assert.deepEqual(recorder.summary().completion, { result: 'Done.', at: '2026-10-19T09:00:42Z' });
  });

  test('isOwnToolRequest matches the two titles exactly, each with its own identity', () => {
    const request = (title: string | undefined, identity: unknown = undefined) => ({
      toolCall: { title },
      _meta: { kiro: { mcpTool: { version: 1, identity } } },
    });
    for (const tool of ['send_message', 'complete_task']) {
      assert.equal(isOwnToolRequest(request(`@sidecar/${tool}`, { serverName: 'sidecar', toolName: tool })), true, tool);
    }
    for (const title of ['@sidecar/other', 'sidecar::send_message', '@Sidecar/send_message', ' @sidecar/complete_task', undefined]) {
      assert.equal(isOwnToolRequest(request(title, { serverName: 'sidecar', toolName: 'send_message' })), false, String(title));
    }
  });

  test('isOwnToolRequest refuses an own-tool title without the matching identity', () => {
    const title = '@sidecar/send_message';
    const forged: unknown[] = [
      undefined,
      null,
      {},
      { kiro: {} },
      { kiro: { mcpTool: {} } },
      { kiro: { mcpTool: { identity: { serverName: 'other', toolName: 'send_message' } } } },
      { kiro: { mcpTool: { identity: { serverName: 'sidecar', toolName: 'complete_task' } } } },
      { kiro: { mcpTool: { identity: { serverName: 'Sidecar', toolName: 'send_message' } } } },
      { kiro: { mcpTool: { identity: { toolName: 'send_message' } } } },
      // How Kiro frames a `run_command` request: no MCP identity, whatever the command text.
      { kiro: { toolId: 'run_command', command: title, consent: { capability: 'shell', resource: title } } },
    ];
    for (const meta of forged) {
      assert.equal(isOwnToolRequest({ toolCall: { title }, _meta: meta }), false, JSON.stringify(meta));
    }
  });

  test('the recorded permission requests: the 2.32.0 own tools match, a command titled as one does not', async () => {
    const frames = async (file: string) =>
      (await readFile(new URL(`../fixtures/${file}`, import.meta.url), 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { method?: string; params?: unknown; msg?: { method?: string; params?: unknown } })
        .map((frame) => frame.msg ?? frame)
        .filter((frame) => frame.method === 'session/request_permission')
        .map((frame) => frame.params as { toolCall: { title?: string }; _meta?: unknown });
    const own = await frames('kiro-2.32.0-sidecar-calls.jsonl');
    assert.deepEqual(own.map((request) => [request.toolCall.title, isOwnToolRequest(request)]), [
      ['@sidecar/send_message', true],
      ['@sidecar/complete_task', true],
    ]);
    const [command] = await frames('kiro-v3-turn.jsonl');
    assert.ok(command !== undefined);
    assert.equal(isOwnToolRequest(command), false);
    const titled = { ...command, toolCall: { ...command.toolCall, title: '@sidecar/send_message' } };
    assert.equal(isOwnToolRequest(titled), false);
  });

  test('the recorded kiro-cli 2.32.0 frames record one message and the completion', async () => {
    const lines = (await readFile(new URL('../fixtures/kiro-2.32.0-sidecar-calls.jsonl', import.meta.url), 'utf8'))
      .split('\n')
      .filter((line) => line !== '');
    const recorder = calls();
    const records: unknown[] = [];
    let toolCalls = 0;
    for (const line of lines) {
      const frame = JSON.parse(line) as { method: string; params: unknown };
      if (frame.method !== 'session/update') {
        assert.equal(frame.method, 'session/request_permission');
        continue;
      }
      const event = toTurnEvent(frame.params as SessionNotification, false);
      if (event.kind === 'tool_call') {
        toolCalls += 1;
        recorder.call(event.toolCallId, event.title, event.update);
      } else if (event.kind === 'tool_call_update') {
        records.push(recorder.update(event.toolCallId, event.status));
      }
    }
    assert.equal(toolCalls, 2);
    // Tool Load (an id never noted), then in_progress and completed for each call.
    assert.deepEqual(records, [undefined, undefined, 'message', undefined, 'completion']);
    assert.deepEqual(recorder.summary(), {
      messages: ['Before writing the one-line hello world program: should it be in Python or in Go?'],
      messagesDropped: 0,
      completion: {
        result:
          'Created /work/hello.py: a one-line Python hello world (print("Hello, World!")). Verified it runs and outputs "Hello, World!".',
        at: '2026-10-19T08:30:15Z',
      },
    });
  });
});
