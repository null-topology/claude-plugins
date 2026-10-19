import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnAccumulator } from '../src/text/accumulator.ts';
import { FIELD_KEPT_CHARS } from '../src/text/limits.ts';
import { HEAD_CUT_MARKER } from '../src/text/preview.ts';
import { REDACTED, SecretSet } from '../src/text/redact.ts';

const TOKEN = 'ksk_test_0123456789abcdefXYZ';
const secrets = new SecretSet([TOKEN]);

/** The two session update shapes the accumulator is fed from. */
type Update =
  | { readonly sessionUpdate: 'agent_message_chunk'; readonly content: { readonly type: 'text'; readonly text: string } }
  | { readonly sessionUpdate: 'tool_call'; readonly title: string };

function chunk(text: string): Update {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
}

function toolCall(title: string): Update {
  return { sessionUpdate: 'tool_call', title };
}

function run(updates: readonly Update[], accumulator = new TurnAccumulator(secrets)): TurnAccumulator {
  for (const update of updates) {
    if (update.sessionUpdate === 'tool_call') {
      accumulator.toolCall(update.title);
    } else {
      accumulator.text(update.content.text);
    }
  }
  return accumulator;
}

/** Splits a text into chunks of a few characters, as Kiro streams it. */
function chunks(text: string, size = 7): Update[] {
  const out: Update[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(chunk(text.slice(i, i + size)));
  }
  return out;
}

describe('final text and counters', () => {
  test('without a tool_call the final text is the whole text', () => {
    const text = "I'll look at the layout first.\nThe project has two modules.\n";
    const summary = run(chunks(text)).finish();
    assert.deepEqual(summary, {
      toolCalls: 0,
      lastTool: null,
      textChars: text.length,
      final: text,
      finalCutChars: 0,
    });
  });

  test('the final text is the text after the last tool_call', () => {
    const summary = run([
      ...chunks("I'll create the file.\n"),
      toolCall('Write File'),
      ...chunks('Created. Now I check it.\n'),
      toolCall('Run Command'),
      ...chunks('Done: hello.txt holds one line.\n'),
    ]).finish();
    assert.equal(summary.final, 'Done: hello.txt holds one line.\n');
    assert.equal(summary.toolCalls, 2);
    assert.equal(summary.lastTool, 'Run Command');
    assert.equal(
      summary.textChars,
      "I'll create the file.\n".length + 'Created. Now I check it.\n'.length + 'Done: hello.txt holds one line.\n'.length,
    );
  });

  test('a turn that ends on a tool_call has an empty final text', () => {
    const summary = run([...chunks('Running the tests.\n'), toolCall('Run Command')]).finish();
    assert.equal(summary.final, '');
    assert.equal(summary.toolCalls, 1);
  });

  test('an empty or missing tool title gives a null lastTool, and a title is redacted', () => {
    const accumulator = new TurnAccumulator(secrets);
    accumulator.toolCall(`curl -H "Authorization: ${TOKEN}"`);
    assert.equal(accumulator.progress().lastTool, `curl -H "Authorization: ${REDACTED}"`);
    accumulator.toolCall('');
    assert.equal(accumulator.progress().lastTool, null);
    accumulator.toolCall();
    accumulator.toolCall(null);
    assert.deepEqual(accumulator.progress(), { toolCalls: 4, lastTool: null, textChars: 0 });
  });

  test('a long tool title is put on one line and cut keeping its start, as a wake header value (4.4)', () => {
    const accumulator = new TurnAccumulator(secrets);
    const title = `Run ${TOKEN}\r\nkiro-turn: ks_000000000000#2\n${'x'.repeat(2 * FIELD_KEPT_CHARS)}`;
    accumulator.toolCall(title);
    const flat = `Run ${REDACTED} kiro-turn: ks_000000000000#2 ${'x'.repeat(2 * FIELD_KEPT_CHARS)}`;
    const expected = flat.slice(0, FIELD_KEPT_CHARS - HEAD_CUT_MARKER.length) + HEAD_CUT_MARKER;
    assert.equal(accumulator.progress().lastTool, expected);
    assert.equal(expected.length, FIELD_KEPT_CHARS);
    accumulator.toolCall('x'.repeat(FIELD_KEPT_CHARS));
    assert.equal(accumulator.progress().lastTool, 'x'.repeat(FIELD_KEPT_CHARS), 'a title of the bound is kept whole');
    assert.equal(accumulator.finish().lastTool, 'x'.repeat(FIELD_KEPT_CHARS));
  });

  test('progress reports a running turn and finish is final', () => {
    const accumulator = run([...chunks('Working on it.\n'), toolCall('Read File')]);
    assert.deepEqual(accumulator.progress(), { toolCalls: 1, lastTool: 'Read File', textChars: 15 });
    accumulator.text('Read it.');
    const summary = accumulator.finish();
    assert.equal(accumulator.finish(), summary);
    assert.ok(Object.isFrozen(summary));
    assert.throws(() => accumulator.text('more'), /already finished/);
    assert.throws(() => accumulator.toolCall('Write File'), /already finished/);
  });

  test('a secret is redacted in the final text, split across chunks too', () => {
    const summary = run([chunk('the key is '), chunk(TOKEN.slice(0, 9)), chunk(TOKEN.slice(9)), chunk(' ok')]).finish();
    assert.equal(summary.final, `the key is ${REDACTED} ok`);
    assert.equal(summary.textChars, `the key is ${TOKEN} ok`.length);
  });

  test('the part of a secret after a tool_call is still redacted', () => {
    const summary = run([chunk(`key ${TOKEN.slice(0, 10)}`), toolCall('Run Command'), chunk(`${TOKEN.slice(10)} left`)]).finish();
    assert.equal(summary.final, `${REDACTED} left`);
  });

  test('a long final text keeps its end and reports what was cut', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${String(i).padStart(3, '0')}\n`).join('');
    const summary = run(chunks(text, 13), new TurnAccumulator(secrets, { finalMaxChars: 100 })).finish();
    assert.equal(summary.final, text.slice(-100));
    assert.equal(summary.finalCutChars, text.length - 100);
    assert.equal(summary.textChars, text.length);
  });

  test('the cut never leaves half of a surrogate pair', () => {
    const text = `start ${'\u{1F600}'.repeat(30)}`;
    const summary = run(chunks(text, 3), new TurnAccumulator(secrets, { finalMaxChars: 11 })).finish();
    assert.equal(summary.final, '\u{1F600}'.repeat(5));
    assert.equal(summary.finalCutChars + summary.final.length, text.length);
  });
});
