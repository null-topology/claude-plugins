import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  HOOK_INPUT_MAX_BYTES,
  parsePostToolUseInput,
  readHookInput,
  responseText,
} from '../../src/hooks/input.ts';
import { SESSION_ID, TOOL_USE_ID, START_TOOL, postToolUse } from './helpers.ts';

function chunked(text: string, size: number): Readable {
  const bytes = Buffer.from(text, 'utf8');
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size));
  }
  return Readable.from(chunks);
}

describe('readHookInput', () => {
  test('parses JSON that arrives in many chunks', async () => {
    const value = postToolUse('kiro-turn: ks_0123456789ab#1');
    const read = await readHookInput(chunked(JSON.stringify(value), 7));
    assert.deepEqual(read, { kind: 'json', value });
  });

  test('accepts string chunks', async () => {
    const read = await readHookInput(Readable.from(['{"session_id":', '"a"}']));
    assert.deepEqual(read, { kind: 'json', value: { session_id: 'a' } });
  });

  test('input of exactly the cap is read; one byte more is refused', async () => {
    const body = '"' + 'a'.repeat(98) + '"';
    assert.equal(Buffer.byteLength(body), 100);
    assert.equal((await readHookInput(chunked(body, 16), 100)).kind, 'json');
    assert.deepEqual(await readHookInput(chunked(` ${body}`, 16), 100), {
      kind: 'skip',
      reason: 'input-too-large',
    });
  });

  test('the default cap is 8 MiB', async () => {
    assert.equal(HOOK_INPUT_MAX_BYTES, 8 * 1024 * 1024);
    const object = Buffer.from('{}');
    const atCap = [Buffer.alloc(HOOK_INPUT_MAX_BYTES - object.length, 0x20), object];
    assert.deepEqual(await readHookInput(Readable.from(atCap)), { kind: 'json', value: {} });
    const overCap = [Buffer.alloc(HOOK_INPUT_MAX_BYTES - object.length + 1, 0x20), object];
    assert.deepEqual(await readHookInput(Readable.from(overCap)), { kind: 'skip', reason: 'input-too-large' });
  });

  test('an endless stream stops at the cap and is destroyed', async () => {
    let produced = 0;
    const endless = new Readable({
      read() {
        produced += 1024;
        this.push(Buffer.alloc(1024, 0x20));
      },
    });
    const read = await readHookInput(endless, 10 * 1024);
    assert.deepEqual(read, { kind: 'skip', reason: 'input-too-large' });
    assert.ok(produced < 64 * 1024, `read ${produced} bytes`);
    assert.equal(endless.destroyed, true);
  });

  test('malformed JSON and empty input are skipped, never thrown', async () => {
    for (const text of ['{"session_id": ', 'not json', '']) {
      assert.deepEqual(await readHookInput(chunked(text, 4)), { kind: 'skip', reason: 'input-not-json' }, text);
    }
  });

  test('a stream error is skipped with the error', async () => {
    const failing = new Readable({
      read() {
        this.destroy(Object.assign(new Error('read failed'), { code: 'EIO' }));
      },
    });
    const read = await readHookInput(failing);
    assert.equal(read.kind, 'skip');
    assert.equal(read.kind === 'skip' ? read.reason : null, 'input-unreadable');
  });
});

describe('responseText', () => {
  test('the text of the last text block is the reply', () => {
    assert.equal(
      responseText([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'text', text: 42 },
        null,
      ]),
      'second',
    );
  });

  test('a string is the reply as it is', () => {
    assert.equal(responseText('kiro-turn: ks_0123456789ab#1'), 'kiro-turn: ks_0123456789ab#1');
  });

  test('anything else holds no reply', () => {
    for (const value of [[], [{ type: 'image', data: 'AAAA' }], { content: [] }, 42, null, undefined]) {
      assert.equal(responseText(value), null, JSON.stringify(value));
    }
  });
});

describe('parsePostToolUseInput', () => {
  test('reads the fields of a main-conversation MCP call', () => {
    assert.deepEqual(parsePostToolUseInput(postToolUse('reply line')), {
      kind: 'input',
      input: {
        sessionId: SESSION_ID,
        toolName: START_TOOL,
        toolUseId: TOOL_USE_ID,
        agentId: null,
        agentType: null,
        agentTypeDropped: false,
        responseText: 'reply line',
      },
    });
  });

  test('reads the agent of a subagent call', () => {
    const parsed = parsePostToolUseInput(
      postToolUse('reply', { agent_id: 'a1b2c3d4e5', agent_type: 'code-reviewer' }),
    );
    assert.equal(parsed.kind, 'input');
    if (parsed.kind === 'input') {
      assert.equal(parsed.input.agentId, 'a1b2c3d4e5');
      assert.equal(parsed.input.agentType, 'code-reviewer');
      assert.equal(parsed.input.agentTypeDropped, false);
    }
  });

  test('accepts a namespaced agent type', () => {
    const parsed = parsePostToolUseInput(postToolUse('reply', { agent_type: 'review-kit:deep.reviewer_2' }));
    assert.equal(parsed.kind === 'input' ? parsed.input.agentType : undefined, 'review-kit:deep.reviewer_2');
  });

  test('a string tool_response is the reply', () => {
    const parsed = parsePostToolUseInput(postToolUse(null, { tool_response: 'plain reply' }));
    assert.equal(parsed.kind === 'input' ? parsed.input.responseText : undefined, 'plain reply');
  });

  test('an agent id or agent type outside its pattern is dropped', () => {
    for (const agentType of ['two words', 'line\nbreak', 'x'.repeat(129), '', 7]) {
      const parsed = parsePostToolUseInput(postToolUse('reply', { agent_type: agentType, agent_id: '../a' }));
      assert.equal(parsed.kind, 'input');
      if (parsed.kind === 'input') {
        assert.equal(parsed.input.agentType, null);
        assert.equal(parsed.input.agentTypeDropped, true, JSON.stringify(agentType));
        assert.equal(parsed.input.agentId, null);
      }
    }
    const nullType = parsePostToolUseInput(postToolUse('reply', { agent_type: null }));
    assert.equal(nullType.kind === 'input' ? nullType.input.agentTypeDropped : undefined, false);
  });

  test('a tool_use_id or tool_name that is not a string is null', () => {
    const parsed = parsePostToolUseInput(postToolUse('reply', { tool_use_id: 12, tool_name: ['start'] }));
    assert.equal(parsed.kind, 'input');
    if (parsed.kind === 'input') {
      assert.equal(parsed.input.toolUseId, null);
      assert.equal(parsed.input.toolName, null);
    }
  });

  test('a path-like tool_use_id is passed on unchecked for the lookup to refuse', () => {
    const parsed = parsePostToolUseInput(postToolUse('reply', { tool_use_id: '../runs/x' }));
    assert.equal(parsed.kind === 'input' ? parsed.input.toolUseId : undefined, '../runs/x');
  });

  test('skips anything but an object with a valid session_id', () => {
    const bad: unknown[] = [
      null,
      [],
      'text',
      42,
      {},
      postToolUse('reply', { session_id: undefined }),
      postToolUse('reply', { session_id: '' }),
      postToolUse('reply', { session_id: '../sessions' }),
      postToolUse('reply', { session_id: 'x'.repeat(129) }),
      postToolUse('reply', { session_id: 17 }),
    ];
    for (const value of bad) {
      assert.deepEqual(parsePostToolUseInput(value), { kind: 'skip', reason: 'input-invalid' }, JSON.stringify(value));
    }
  });
});
