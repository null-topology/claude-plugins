import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TurnRecorder } from '../../src/session/turn.ts';
import { parseTurnResult } from '../../src/session/turn-result.ts';
import { createRun } from '../../src/store/runs.ts';
import { buildSecretSet } from '../../src/text/redact.ts';
import { tempDir } from '../helpers/processes.ts';

const SECRET = 'ksk_fixture_secret_0123456789abcdef';

/** A `tool_call` update for one of the plugin's own tools, shaped like kiro-cli 2.32.0 sends it. */
function ownToolCall(tool: string, args: Record<string, unknown>) {
  return { sessionUpdate: 'tool_call', status: 'pending', rawInput: { tool_id: `sidecar::${tool}`, arguments: args } };
}

async function openTurn(t: Parameters<typeof tempDir>[0], turn = 1) {
  const stateDir = await tempDir(t);
  const { launchId, paths } = await createRun(stateDir);
  const recorder = TurnRecorder.open({
    stateDir,
    turnsDir: paths.turns,
    launchId,
    sessionId: 'sess_fixture',
    label: null,
    turn,
    secrets: buildSecretSet({ apiKey: SECRET, env: {} }),
  });
  return { stateDir, launchId, paths, recorder };
}

describe('TurnRecorder', () => {
  test('turns/<n>.md is finalized before turns/<n>.json is created', async (t) => {
    const { paths, recorder } = await openTurn(t);
    const seen: string[] = [];
    const watcher = watch(paths.turns, (_event, name) => {
      if (name !== null) {
        seen.push(String(name));
      }
    });
    t.after(() => watcher.close());
    recorder.text('Some text.');
    await recorder.finish({ outcome: 'end_turn', endedBy: null, error: null }, paths.stderrLog);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const md = seen.indexOf('1.md');
    const json = seen.lastIndexOf('1.json');
    assert.ok(md !== -1 && json !== -1, `events: ${seen.join(', ')}`);
    assert.ok(md < json, `events: ${seen.join(', ')}`);
  });

  test('a secret split across chunks is redacted in the turn text and the result', async (t) => {
    const { paths, recorder } = await openTurn(t);
    recorder.text(`token ${SECRET.slice(0, 10)}`);
    recorder.text(`${SECRET.slice(10)} end\nQUESTION: keep ${SECRET}?`);
    const result = await recorder.finish({ outcome: 'end_turn', endedBy: null, error: null }, paths.stderrLog);
    const text = await readFile(join(paths.turns, '1.md'), 'utf8');
    assert.equal(text, 'token [REDACTED] end\nQUESTION: keep [REDACTED]?');
    // A `QUESTION:` line is plain text now: it stays in the final text and nothing is parsed out of it.
    assert.equal(result.final, text);
    assert.deepEqual(result.messages, []);
    assert.equal('questions' in result, false);
    assert.equal(JSON.stringify(result).includes(SECRET.slice(0, 10)), false);
  });

  test('a failed turn carries error and stderrTail; every field is present', async (t) => {
    const { paths, recorder, launchId } = await openTurn(t, 2);
    recorder.text('before the tool');
    recorder.toolCall('Run Command');
    recorder.text('after the tool');
    const result = await recorder.finish(
      { outcome: 'exited', endedBy: null, error: `died with ${SECRET}` },
      join(paths.dir, 'no-such-stderr.log'),
    );
    assert.deepEqual(result, {
      launchId,
      sessionId: 'sess_fixture',
      label: null,
      turn: 2,
      outcome: 'exited',
      endedBy: null,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      durationS: 0,
      toolCalls: 1,
      lastTool: 'Run Command',
      messages: [],
      messagesDropped: 0,
      completion: null,
      final: 'after the tool',
      textChars: 'before the tool\nafter the tool'.length,
      truncated: false,
      error: 'died with [REDACTED]',
      stderrTail: null,
    });
    assert.deepEqual(JSON.parse(await readFile(join(paths.turns, '2.json'), 'utf8')), result);
    assert.equal(await recorder.ended, result);
  });

  test('own-tool calls land in the result as messages and a completion, and still count as tool calls', async (t) => {
    const { paths, recorder } = await openTurn(t);
    recorder.text('Asking first.');
    recorder.toolCall('@sidecar/send_message', 'call_1', ownToolCall('send_message', { text: `Is ${SECRET} right?` }));
    assert.equal(recorder.toolCallUpdate('call_1', 'completed'), 'message');
    recorder.toolCall('@sidecar/complete_task', 'call_2', ownToolCall('complete_task', { result: 'All done.' }));
    assert.equal(recorder.toolCallUpdate('call_2', 'completed'), 'completion');
    recorder.toolCall('@sidecar/complete_task', 'call_3', ownToolCall('complete_task', { result: 'Done again.' }));
    assert.equal(recorder.toolCallUpdate('call_3', 'completed'), 'ignored');
    recorder.toolCall('@sidecar/send_message', 'call_4', ownToolCall('send_message', { text: 'Never completed.' }));
    const result = await recorder.finish({ outcome: 'end_turn', endedBy: null, error: null }, paths.stderrLog);
    assert.equal(recorder.toolCallUpdate('call_4', 'completed'), undefined);
    assert.deepEqual(result.messages, ['Is [REDACTED] right?']);
    assert.equal(result.messagesDropped, 0);
    assert.equal(result.completion?.result, 'All done.');
    assert.match(result.completion?.at ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(result.toolCalls, 4);
    assert.equal(result.lastTool, '@sidecar/send_message');
    assert.deepEqual(JSON.parse(await readFile(join(paths.turns, '1.json'), 'utf8')), result);
  });

  test('text on both sides of a tool call is split by one line break', async (t) => {
    const { paths, recorder } = await openTurn(t);
    recorder.text('Listing files in the current directory.');
    recorder.toolCall('ls');
    recorder.text('DONE');
    const result = await recorder.finish({ outcome: 'end_turn', endedBy: null, error: null }, paths.stderrLog);
    const text = await readFile(join(paths.turns, '1.md'), 'utf8');
    assert.equal(text, 'Listing files in the current directory.\nDONE');
    assert.equal(result.textChars, text.length);
    assert.equal(result.final, 'DONE');
  });

  test('no line break is added where one already is, or where one side has no text', async (t) => {
    const cases: Array<[Array<string | { tool: string }>, string, string]> = [
      [['first\n', { tool: 'a' }, 'second'], 'first\nsecond', 'second'],
      [['first', { tool: 'a' }, '\nsecond'], 'first\nsecond', '\nsecond'],
      [['first\r\n', { tool: 'a' }, 'second'], 'first\r\nsecond', 'second'],
      [[{ tool: 'a' }, 'only after'], 'only after', 'only after'],
      [['only before', { tool: 'a' }], 'only before', ''],
      [['first', { tool: 'a' }, { tool: 'b' }, '', 'second'], 'first\nsecond', 'second'],
      [['one', { tool: 'a' }, 'two', { tool: 'b' }, 'three'], 'one\ntwo\nthree', 'three'],
    ];
    for (const [index, [steps, text, final]] of cases.entries()) {
      const { paths, recorder } = await openTurn(t, index + 1);
      for (const step of steps) {
        if (typeof step === 'string') {
          recorder.text(step);
        } else {
          recorder.toolCall(step.tool);
        }
      }
      const result = await recorder.finish({ outcome: 'end_turn', endedBy: null, error: null }, paths.stderrLog);
      assert.equal(await readFile(join(paths.turns, `${index + 1}.md`), 'utf8'), text, JSON.stringify(steps));
      assert.equal(result.final, final, JSON.stringify(steps));
    }
  });

  test('a secret split by a tool call is redacted whole, with no line break inside it', async (t) => {
    for (let split = 1; split < SECRET.length; split += 1) {
      const { paths, recorder } = await openTurn(t, split);
      recorder.text(`key ${SECRET.slice(0, split)}`);
      recorder.toolCall('Read File');
      recorder.text(`${SECRET.slice(split)} done`);
      const result = await recorder.finish({ outcome: 'end_turn', endedBy: null, error: null }, paths.stderrLog);
      const text = await readFile(join(paths.turns, `${split}.md`), 'utf8');
      assert.equal(text, 'key [REDACTED] done', `split at ${split}`);
      assert.equal(result.final, '[REDACTED] done', `split at ${split}`);
      assert.equal(result.textChars, `key ${SECRET} done`.length, `split at ${split}`);
    }
  });

  test('two secrets that touch across a tool call form one redacted run without a line break', async (t) => {
    const { paths, recorder } = await openTurn(t);
    recorder.text(`key ${SECRET}`);
    recorder.toolCall('Read File');
    recorder.text(`${SECRET} done`);
    const result = await recorder.finish({ outcome: 'end_turn', endedBy: null, error: null }, paths.stderrLog);
    assert.equal(await readFile(join(paths.turns, '1.md'), 'utf8'), 'key [REDACTED] done');
    assert.equal(result.textChars, `key ${SECRET}${SECRET} done`.length);
  });

  test('a tool call next to a secret, not inside it, still adds the line break', async (t) => {
    const cases: Array<[string, string, string, string]> = [
      [`key ${SECRET}`, 'done', 'key [REDACTED]\ndone', 'done'],
      ['key ', `${SECRET} done`, 'key \n[REDACTED] done', '[REDACTED] done'],
      [`${SECRET} before`, `after ${SECRET}`, '[REDACTED] before\nafter [REDACTED]', 'after [REDACTED]'],
    ];
    for (const [index, [before, after, text, final]] of cases.entries()) {
      const { paths, recorder } = await openTurn(t, index + 1);
      recorder.text(before);
      recorder.toolCall('Read File');
      recorder.text(after);
      const result = await recorder.finish({ outcome: 'end_turn', endedBy: null, error: null }, paths.stderrLog);
      const written = await readFile(join(paths.turns, `${index + 1}.md`), 'utf8');
      assert.equal(written, text, `case ${index}`);
      assert.equal(result.final, final, `case ${index}`);
      assert.equal(result.textChars, before.length + after.length + 1, `case ${index}`);
    }
  });
});

describe('parseTurnResult', () => {
  const LAUNCH_ID = 'ks_0123456789ab';
  /** A turn result as written before the own-tool fields existed. */
  const legacy = {
    launchId: LAUNCH_ID,
    sessionId: 'sess_fixture',
    label: null,
    turn: 1,
    outcome: 'end_turn',
    endedBy: null,
    startedAt: '2026-10-01T10:00:00Z',
    endedAt: '2026-10-01T10:01:00Z',
    durationS: 60,
    toolCalls: 1,
    lastTool: 'Read File',
    questions: ['Keep the old flag?'],
    final: 'Done.',
    textChars: 5,
    truncated: false,
    error: null,
    stderrTail: null,
  };

  test('a result written before the own-tool fields reads with no messages and no completion', () => {
    const result = parseTurnResult(legacy, LAUNCH_ID, 1);
    assert.deepEqual(result.messages, []);
    assert.equal(result.messagesDropped, 0);
    assert.equal(result.completion, null);
    assert.equal(result.final, 'Done.');
    assert.equal('questions' in result, false, 'its questions are ignored');
    // Ignored whatever it holds: a malformed questions field does not make the file unreadable.
    assert.equal('questions' in parseTurnResult({ ...legacy, questions: 'not a list' }, LAUNCH_ID, 1), false);
  });

  test('present own-tool fields are checked, not defaulted', () => {
    const current = { ...legacy, messages: ['Hello.'], messagesDropped: 2, completion: { result: 'Done.', at: '2026-10-01T10:00:30Z' } };
    const result = parseTurnResult(current, LAUNCH_ID, 1);
    assert.deepEqual(result.messages, ['Hello.']);
    assert.equal(result.messagesDropped, 2);
    assert.deepEqual(result.completion, { result: 'Done.', at: '2026-10-01T10:00:30Z' });
    assert.throws(() => parseTurnResult({ ...current, messages: null }, LAUNCH_ID, 1), /messages/);
    assert.throws(() => parseTurnResult({ ...current, messages: [1] }, LAUNCH_ID, 1), /messages/);
    assert.throws(() => parseTurnResult({ ...current, messagesDropped: -1 }, LAUNCH_ID, 1), /messagesDropped/);
    assert.throws(() => parseTurnResult({ ...current, completion: { result: 'Done.' } }, LAUNCH_ID, 1), /completion/);
  });
});
