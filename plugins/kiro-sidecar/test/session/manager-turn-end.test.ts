import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PROCESS_TIMEOUT, managerFixture, metaOf, waitFor } from './manager-helpers.ts';

/** Rejects when `work` does not settle within `ms`, so a hang fails the test. */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

describe('SessionManager turn end when the state directory fails', () => {
  test('a turn whose text cannot be saved ends as an error and the session goes idle', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const { manager, stateDir } = fixture;
    const { launchId } = await manager.start({ dir: fixture.workspace.dir, prompt: 'hold 300' });
    // A directory where the text file goes stands in for a failing disk.
    await mkdir(join(stateDir, 'runs', launchId, 'turns', '1.md'));
    const ended = manager.turnEnded(launchId, 1);
    assert.ok(ended !== undefined);
    const result = await within(ended, 5_000, 'the turn result');
    assert.equal(result.outcome, 'error');
    assert.ok(result.error?.includes('The turn text could not be saved'), String(result.error));
    await manager.settled();
    assert.equal((await metaOf(stateDir, launchId)).state, 'idle');
    assert.equal(manager.get(launchId)?.state, 'idle');
    assert.ok(fixture.errors.some((line) => line.includes('text')), fixture.errors.join('\n'));
  });

  test('a turn whose result file cannot be written still ends, and cancel returns', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'cancel-tool');
    const { manager, stateDir } = fixture;
    const { launchId } = await manager.start({ dir: fixture.workspace.dir, prompt: 'run a tool' });
    await waitFor(() => manager.get(launchId)?.state === 'running', 'the turn to run');
    await mkdir(join(stateDir, 'runs', launchId, 'turns', '1.json'));
    const reply = await within(manager.cancel({ launchId }), 8_000, 'cancel');
    assert.equal(reply.state, 'idle');
    assert.equal(reply.ended?.result.outcome, 'cancelled');
    assert.equal(reply.ended?.result.endedBy, 'cancel');
    await manager.settled();
    assert.equal((await metaOf(stateDir, launchId)).state, 'idle');
    assert.ok(fixture.errors.some((line) => line.includes('result')), fixture.errors.join('\n'));
    const next = await within(manager.send({ launchId, text: 'again' }), 5_000, 'send');
    assert.equal(next.turn, 2);
  });
});
