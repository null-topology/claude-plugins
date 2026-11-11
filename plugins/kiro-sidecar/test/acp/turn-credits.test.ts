/**
 * A2: the credits of a `turn_completion` `session_info_update`, as Kiro
 * meters a turn (`_meta.kiro.promptTurnSummaries`), and the turn result's
 * `credits` field as it is stored and read back.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { creditsOf, toTurnEvent, turnCompletionCredits } from '../../src/acp/events.ts';
import { endedWithoutResult, parseTurnResult } from '../../src/session/turn-result.ts';
import type { RunMeta } from '../../src/store/runs.ts';
import { TURN_RECORDING } from '../helpers/fake-kiro.ts';
import { sampleResult } from '../session/helpers-runs.ts';

function info(kiro: Record<string, unknown>): SessionUpdate {
  return { sessionUpdate: 'session_info_update', _meta: { kiro } } as SessionUpdate;
}

describe('turnCompletionCredits', () => {
  test('the recorded turn_completion of kiro-v3-turn.jsonl line 121', () => {
    const line = readFileSync(TURN_RECORDING, 'utf8').split('\n')[120] as string;
    const update = (JSON.parse(line) as { msg: { params: { update: SessionUpdate } } }).msg.params.update;
    assert.equal(turnCompletionCredits(update), 0.06553350699834162);
  });

  test('sums the usage of every credit entry, unit as Kiro normalises it', () => {
    const update = info({
      kind: 'turn_completion',
      promptTurnSummaries: [
        { unit: 'credit', unitPlural: 'credits', usage: 0.25 },
        { unit: ' Credits ', usage: 1.5 },
        { unit: 'CREDIT', usage: 0 },
        { unit: 'token', usage: 900 },
      ],
    });
    assert.equal(turnCompletionCredits(update), 1.75);
  });

  test('a malformed summary is skipped without an error', () => {
    const update = info({
      kind: 'turn_completion',
      promptTurnSummaries: [
        { unit: 'credit' },
        { unit: 'credit', usage: '0.5' },
        { unit: 'credit', usage: Number.NaN },
        { unit: 'credit', usage: Number.POSITIVE_INFINITY },
        { unit: 'credit', usage: -1 },
        { usage: 3 },
        null,
        'credit',
        { unit: 'credit', usage: 0.125 },
      ],
    });
    assert.equal(turnCompletionCredits(update), 0.125);
    assert.equal(creditsOf([{ unit: 'credit' }]), null, 'no valid credit entry: null, not 0');
    assert.equal(creditsOf('not a list'), null);
    assert.equal(creditsOf(undefined), null);
    assert.equal(creditsOf([]), null);
  });

  test('other session_info_update kinds and other updates say nothing of credits', () => {
    for (const kiro of [
      { kind: 'context_usage', usagePercentage: 8.7 },
      { kind: 'turn_start', turnStart: true },
      { kind: 'session_usage', credits: [{ unit: 'credit', usage: 5 }] },
      { promptTurnSummaries: [{ unit: 'credit', usage: 5 }] },
    ]) {
      assert.equal(turnCompletionCredits(info(kiro)), undefined, JSON.stringify(kiro));
    }
    assert.equal(turnCompletionCredits({ sessionUpdate: 'session_info_update', title: 't' } as SessionUpdate), undefined);
    assert.equal(
      turnCompletionCredits({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }),
      undefined,
    );
  });

  test('the event stays an `update`, as every other session_info_update', () => {
    const event = toTurnEvent({ sessionId: 's', update: info({ kind: 'turn_completion', promptTurnSummaries: [] }) }, false);
    assert.equal(event.kind, 'update');
  });
});

describe('turn result credits', () => {
  const meta = { launchId: 'ks_0123456789ab', kiroSessionId: 'sess_5f2a9c1e', label: null } as RunMeta;

  test('a stored number is read back in full; null stays null', () => {
    const credits = 0.06553350699834162;
    assert.equal(parseTurnResult(JSON.parse(JSON.stringify(sampleResult(meta, 1, { credits }))), meta.launchId, 1).credits, credits);
    assert.equal(parseTurnResult(sampleResult(meta, 1, { credits: null }), meta.launchId, 1).credits, null);
  });

  test('a result written before the field existed reads as null', () => {
    const { credits: _credits, ...legacy } = sampleResult(meta, 1);
    assert.equal(parseTurnResult(legacy, meta.launchId, 1).credits, null);
  });

  test('a credits value that is not a finite number of at least 0 is a bad field', () => {
    for (const credits of ['0.5', -1, Number.NaN, {}]) {
      assert.throws(() => parseTurnResult({ ...sampleResult(meta, 1), credits }, meta.launchId, 1), /bad field credits/);
    }
  });

  test('a turn that ended without a result from Kiro has none', () => {
    const now = new Date();
    const result = endedWithoutResult(meta, 1, { outcome: 'lost', error: 'gone', startedAt: now, endedAt: now, stderrTail: null });
    assert.equal(result.credits, null);
  });
});
