import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { KiroAcpClient } from '../../src/acp/client.ts';
import { SidecarError } from '../../src/errors.ts';
import { RunLock } from '../../src/store/lock.ts';
import { turnPaths } from '../../src/store/paths.ts';
import { readCall } from '../../src/store/runs.ts';
import { PROCESS_TIMEOUT, isAlive, managerFixture, metaOf, promptsReceived, waitFor } from './manager-helpers.ts';

/** Rejects when `work` does not settle within `ms`, so a hang fails the test. */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Holds the first meta write that begins once `armed()` is true, until
 * released: a stand-in for a stalled disk at that write. Released when the
 * test ends at the latest.
 */
function holdMetaWrite(t: TestContext, armed: () => boolean): { held: Promise<void>; release: () => void } {
  let used = false;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const assertHeld = RunLock.prototype.assertHeld;
  t.mock.method(RunLock.prototype, 'assertHeld', async function (this: RunLock) {
    if (!used && armed()) {
      used = true;
      reached();
      await gate;
    }
    return assertHeld.call(this);
  });
  t.after(() => release());
  return { held, release };
}

/** True once `method` of the ACP client has been called. */
function calledOnce(t: TestContext, method: 'newSession' | 'configOptions'): () => boolean {
  let called = false;
  const original = KiroAcpClient.prototype[method] as (...args: unknown[]) => unknown;
  t.mock.method(KiroAcpClient.prototype, method, function (this: KiroAcpClient, ...args: unknown[]) {
    const result = original.apply(this, args);
    if (result instanceof Promise) {
      return result.finally(() => {
        called = true;
      });
    }
    called = true;
    return result;
  });
  return () => called;
}

function assertGivenUp(error: unknown, code: string, fragment: string): boolean {
  assert.ok(error instanceof SidecarError, `unexpected ${String(error)}`);
  assert.equal(error.code, code, error.message);
  assert.ok(error.message.includes(fragment), error.message);
  return true;
}

async function onlyRun(stateDir: string): Promise<string> {
  const [launchId, ...others] = await readdir(join(stateDir, 'runs'));
  assert.ok(launchId !== undefined && others.length === 0, 'one run was created');
  return launchId;
}

describe('SessionManager.start deadline and abort cover every awaited operation', () => {
  test('a client abort ends a start whose first meta write is stalled; the run ends failed once the write lands', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const hold = holdMetaWrite(t, () => true);
    const abort = new AbortController();
    const start = fixture.manager.start(
      { dir: fixture.workspace.dir, prompt: 'hello' },
      { toolUseId: 'toolu_stalled_meta', signal: abort.signal },
    );
    await hold.held;
    abort.abort();
    await within(
      assert.rejects(start, (error) => assertGivenUp(error, 'E_STEP_META', 'the start was aborted')),
      2_000,
      'the aborted start',
    );
    const launchId = await onlyRun(fixture.stateDir);
    hold.release();
    await fixture.manager.settled();
    assert.equal((await metaOf(fixture.stateDir, launchId)).state, 'failed');
    assert.equal(fixture.manager.get(launchId), undefined);
    assert.equal(await readCall(fixture.stateDir, 'toolu_stalled_meta'), undefined);
    await assert.rejects(fixture.workspace.started());
    assert.deepEqual(fixture.errors, []);
  });

  test('the start deadline ends a start whose first meta write is stalled', PROCESS_TIMEOUT, async (t) => {
    // The write is held until the start answers, so the deadline can only land in it once the
    // checks and the run creation are done; the deadline leaves them time for that on a loaded host.
    const deadlineMs = 5_000;
    const fixture = await managerFixture(t, 'default', { startLimits: { deadlineMs } });
    const hold = holdMetaWrite(t, () => true);
    const start = fixture.manager.start({ dir: fixture.workspace.dir });
    await within(
      assert.rejects(start, (error) => assertGivenUp(error, 'E_STEP_META', 'the start deadline was reached')),
      deadlineMs + 1_700,
      'the start past its deadline',
    );
    const launchId = await onlyRun(fixture.stateDir);
    hold.release();
    await fixture.manager.settled();
    assert.equal((await metaOf(fixture.stateDir, launchId)).state, 'failed');
    await assert.rejects(fixture.workspace.started());
  });

  test('an abort during the meta write after session/new kills Kiro; a stop waits for the cleanup', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const hold = holdMetaWrite(t, calledOnce(t, 'newSession'));
    const abort = new AbortController();
    const start = fixture.manager.start(
      { dir: fixture.workspace.dir, prompt: 'hello' },
      { toolUseId: 'toolu_stalled_session', signal: abort.signal },
    );
    await hold.held;
    const { pid } = await fixture.workspace.started();
    abort.abort();
    await within(
      assert.rejects(start, (error) => assertGivenUp(error, 'E_STEP_SESSION_NEW', 'the start was aborted')),
      4_000,
      'the aborted start',
    );
    assert.equal(isAlive(pid), false, 'the Kiro process is gone when the start answers');
    const launchId = await onlyRun(fixture.stateDir);

    const stopping = fixture.manager.stop({ launchId });
    hold.release();
    const reply = await within(stopping, 4_000, 'the stop');
    assert.equal(reply.state, 'failed');
    await fixture.manager.settled();
    assert.equal((await metaOf(fixture.stateDir, launchId)).state, 'failed');
    const record = (await readCall(fixture.stateDir, 'toolu_stalled_session')) as { failed?: boolean } | undefined;
    assert.equal(record?.failed, true, JSON.stringify(record));
    assert.equal(fixture.manager.get(launchId), undefined);
    assert.deepEqual(fixture.errors, []);
  });

  test('an abort during the write that opens turn 1 answers at once and sends no prompt', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const hold = holdMetaWrite(t, calledOnce(t, 'configOptions'));
    const abort = new AbortController();
    const start = fixture.manager.start(
      { dir: fixture.workspace.dir, prompt: 'hello' },
      { toolUseId: 'toolu_stalled_turn', signal: abort.signal },
    );
    await hold.held;
    abort.abort();
    await within(
      assert.rejects(start, (error) => assertGivenUp(error, 'E_STEP_PROMPT', 'the start was aborted')),
      4_000,
      'the aborted start',
    );
    const launchId = await onlyRun(fixture.stateDir);
    hold.release();
    await waitFor(() => fixture.manager.get(launchId) === undefined, 'the cleanup of the failed start');
    await fixture.manager.settled();
    const meta = await metaOf(fixture.stateDir, launchId);
    assert.equal(meta.state, 'failed');
    assert.equal(meta.currentTurn, 0);
    assert.equal(await promptsReceived(fixture.workspace), 0);
    assert.equal(existsSync(turnPaths(fixture.stateDir, launchId, 1).result), false);
    const record = (await readCall(fixture.stateDir, 'toolu_stalled_turn')) as { failed?: boolean } | undefined;
    assert.equal(record?.failed, true, JSON.stringify(record));
    assert.deepEqual(fixture.errors, []);
  });
});
