/**
 * A2: the credits a turn cost, from the `turn_completion` updates Kiro sends
 * before the turn ends, in the stored result and the results the manager
 * returns.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROCESS_TIMEOUT, endedTurn, managerFixture, turnResultOf } from './manager-helpers.ts';

/** The prompt of the recorded v3 turn (`kiro-v3-turn.jsonl`); its line 121 meters it. */
const RECORDED_PROMPT =
  "Create a file named hello.txt containing the line 'hello from the smoke test', then run the shell command " +
  "'ls -la' and show its output. End your reply with exactly one line: QUESTION: Should I keep hello.txt?";
const RECORDED_CREDITS = 0.06553350699834162;

const completion = (...usage: unknown[]) => ({
  kind: 'turn_completion',
  promptTurnSummaries: usage.map((value) => ({ unit: 'credit', unitPlural: 'credits', usage: value })),
});
const CONTEXT_USAGE = { kind: 'context_usage', contextUsage: { usagePercentage: 8.7 }, usagePercentage: 8.7 };
const command = (name: string, infos: readonly unknown[]) => `${name} ${JSON.stringify(infos)}`;

describe('SessionManager: credits per turn (A2)', () => {
  test('the recorded turn: credits as Kiro metered it, in full, in the file and the ended result', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'replay');
    const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: RECORDED_PROMPT });
    const ended = fixture.manager.turnEnded(launchId, 1);
    assert.ok(ended !== undefined);
    assert.equal((await ended).credits, RECORDED_CREDITS);
    const stored = await endedTurn(fixture, launchId, 1);
    assert.equal(stored.outcome, 'end_turn');
    assert.equal(stored.credits, RECORDED_CREDITS);
  });

  test('the sum of every turn_completion of the turn; other info updates and malformed summaries change nothing', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const infos = [
      CONTEXT_USAGE,
      completion(0.5, '0.25', null),
      { kind: 'turn_start', turnStart: true },
      { kind: 'turn_completion', promptTurnSummaries: [{ unit: 'credit' }, { unit: 'credit', usage: 0.25 }] },
      { kind: 'turn_completion', promptTurnSummaries: 'none' },
    ];
    const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: command('credits', infos) });
    const turn = await endedTurn(fixture, launchId, 1);
    assert.equal(turn.outcome, 'end_turn');
    assert.equal(turn.credits, 0.75);
    assert.deepEqual(fixture.errors, []);
  });

  test('a turn without a turn_completion has credits null', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: command('credits', [CONTEXT_USAGE]) });
    assert.equal((await endedTurn(fixture, launchId, 1)).credits, null);
  });

  test('each turn counts its own', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: command('credits', [completion(1)]) });
    assert.equal((await endedTurn(fixture, launchId, 1)).credits, 1);
    await fixture.manager.send({ launchId, text: command('credits', [completion(0.5)]) });
    assert.equal((await endedTurn(fixture, launchId, 2)).credits, 0.5);
  });

  test('after complete_task: a summary before the turn ends counts', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const { launchId } = await fixture.manager.start({
      dir: fixture.workspace.dir,
      prompt: command('credits-then-complete', [completion(0.125)]),
    });
    const turn = await endedTurn(fixture, launchId, 1);
    assert.equal(turn.completion?.result, 'The task is done.');
    assert.equal(turn.outcome, 'end_turn');
    assert.equal(turn.credits, 0.125);
  });

  test('after complete_task: the plugin does not wait for a summary, and a late one is not counted', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const { launchId } = await fixture.manager.start({
      dir: fixture.workspace.dir,
      prompt: command('complete-then-credits', [completion(2)]),
    });
    const turn = await endedTurn(fixture, launchId, 1);
    assert.equal(turn.completion?.result, 'The task is done.');
    assert.equal(turn.credits, null);
    // The fake meters 20 ms after the prompt's answer; the stored result stays as it was.
    await sleep(200);
    assert.equal((await turnResultOf(fixture.stateDir, launchId, 1)).credits, null);
  });

  test('cancel returns the cancelled turn with its credits', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: command('credits-then-hold', [completion(0.3)]) });
    // The prompt's metering reaches the client before the cancel goes out.
    await sleep(200);
    const cancelled = await fixture.manager.cancel({ launchId });
    assert.equal(cancelled.ended?.result.outcome, 'cancelled');
    assert.equal(cancelled.ended?.result.credits, 0.3);
  });
});
