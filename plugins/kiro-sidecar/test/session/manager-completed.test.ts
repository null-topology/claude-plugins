import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnProcess } from '../../src/acp/process.ts';
import { SidecarError } from '../../src/errors.ts';
import { pollTurn } from '../../src/hooks/waiter-loop.ts';
import { WAKE_COMPLETED_NOTE, WAKE_FOOTER } from '../../src/hooks/wake.ts';
import type { ManagerDeps } from '../../src/session/manager.ts';
import { TurnRecorder } from '../../src/session/turn.ts';
import { SHUTDOWN_ERROR } from '../../src/session/turn-result.ts';
import { turnPaths } from '../../src/store/paths.ts';
import { readCall, readMeta } from '../../src/store/runs.ts';
import { InvalidInputError } from '../../src/text/errors.ts';
import { RESULT_HEADER } from '../../src/text/result-block.ts';
import {
  PROCESS_TIMEOUT,
  TEST_TOKEN,
  endedTurn,
  isAlive,
  managerFixture,
  metaOf,
  testEnvironment,
  turnResultOf,
  waitFor,
} from './manager-helpers.ts';
import type { ManagerFixture } from './manager-helpers.ts';

const COMPLETE_STEPS = JSON.stringify([{ tool: 'complete_task', args: { result: 'The task is done.' }, end: 'completed' }]);
const COMPLETED_TEXT = 'the session completed by itself; start a new session';

function assertInvalid(error: unknown, fragment: string): boolean {
  assert.ok(error instanceof SidecarError || error instanceof InvalidInputError, `unexpected ${String(error)}`);
  assert.equal(error.code, 'E_INVALID', error.message);
  assert.ok(error.message.includes(fragment), error.message);
  return true;
}

/** A gate the test opens; `entered` resolves when the gated work reached it. */
function gate(): { readonly entered: Promise<void>; enter(): Promise<void>; open(): void } {
  let open = () => {};
  let entered = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    entered: reached,
    enter: () => {
      entered();
      return opened;
    },
    open: () => open(),
  };
}

/** A docker-mode fixture: the fake runs locally, the container removal is injected. */
async function dockerFixture(t: TestContext, removeContainer: ManagerDeps['removeContainer']): Promise<ManagerFixture> {
  let command = '';
  const fixture = await managerFixture(t, 'harness', {
    settings: { api_key: TEST_TOKEN },
    deps: {
      resolveDockerUser: async () => '0:0',
      checkImage: async () => {},
      spawn: (spec, options) =>
        spawnProcess(
          { argv: [command, 'acp', '--agent-engine', 'v3'], env: testEnvironment() as Record<string, string>, cwd: spec.cwd },
          options,
        ),
      removeContainers: () => {},
      removeContainer,
    },
  });
  command = fixture.workspace.command;
  return fixture;
}

/** A docker session whose close is held at the container removal until the gate opens. */
async function heldClose(t: TestContext, prompt: string) {
  const held = gate();
  const removed: string[] = [];
  const fixture = await dockerFixture(t, async (name) => {
    removed.push(name);
    await held.enter();
    return true;
  });
  t.after(() => held.open());
  const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir, prompt, mode: 'docker' });
  return { fixture, launchId, held, removed };
}

/** The value of `promise`, or a failure after `ms`; `onTimeout` runs first so the cleanup cannot hang. */
async function beforeTimeout<T>(promise: Promise<T>, ms: number, what: string, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`${what} did not return within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waits until the running turn has recorded the `complete_task` call. */
async function completionRecorded(fixture: ManagerFixture, launchId: string): Promise<void> {
  await waitFor(() => fixture.manager.get(launchId)?.runningTurn?.toolCalls === 1, 'the complete_task call');
}

describe('SessionManager completion (against the fake)', () => {
  test('a completion closes the session in order: memory, result, meta, then the close', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const { manager, stateDir } = fixture;
    let launchId = '';
    const seen: Record<string, unknown> = {};
    const finish = TurnRecorder.prototype.finish;
    t.mock.method(TurnRecorder.prototype, 'finish', async function (this: TurnRecorder, ...args: Parameters<TurnRecorder['finish']>) {
      const result = turnPaths(stateDir, launchId, this.turn).result;
      seen['stateBefore'] = manager.get(launchId)?.state;
      seen['resultBefore'] = existsSync(result);
      seen['metaBefore'] = (await readMeta(stateDir, launchId))?.state;
      const finished = await finish.apply(this, args);
      seen['resultAfter'] = existsSync(result);
      seen['metaAfter'] = (await readMeta(stateDir, launchId))?.state;
      seen['liveAfter'] = manager.get(launchId) !== undefined;
      return finished;
    });
    ({ launchId } = await manager.start({ dir: fixture.workspace.dir, prompt: `own-tools ${COMPLETE_STEPS}` }));
    const result = await endedTurn(fixture, launchId, 1);

    assert.deepEqual(seen, {
      stateBefore: 'completed',
      resultBefore: false,
      metaBefore: 'running',
      resultAfter: true,
      metaAfter: 'running',
      liveAfter: true,
    });
    assert.equal(result.outcome, 'end_turn');
    assert.equal(result.endedBy, null);
    assert.equal(result.completion?.result, 'The task is done.');
    assert.equal((await metaOf(stateDir, launchId)).state, 'completed');
    assert.equal(manager.get(launchId), undefined);
    assert.equal(isAlive(fixture.spawned[0] ?? 0), false);
    assert.equal(existsSync(join(stateDir, 'runs', launchId, 'lock')), false);
    const log = await readFile(join(stateDir, 'runs', launchId, 'acp.jsonl'), 'utf8');
    assert.ok(log.includes('"event":"completed"'), log);
    assert.deepEqual(fixture.errors, []);
  });

  test('in docker mode the close removes the container after the result and the meta', PROCESS_TIMEOUT, async (t) => {
    const { fixture, launchId, held, removed } = await heldClose(t, `own-tools ${COMPLETE_STEPS}`);
    const { manager, stateDir } = fixture;
    await held.entered;
    assert.equal(existsSync(turnPaths(stateDir, launchId, 1).result), true);
    assert.equal((await metaOf(stateDir, launchId)).state, 'completed');
    assert.equal(isAlive(fixture.spawned[0] ?? 0), false, 'the process ended before the container removal');
    assert.equal(manager.get(launchId)?.state, 'completed', 'the lock is still held while the container goes');
    assert.equal(existsSync(join(stateDir, 'runs', launchId, 'lock')), true);
    held.open();
    await manager.settled();
    assert.deepEqual(removed, [(await metaOf(stateDir, launchId)).containerName]);
    assert.equal(manager.get(launchId), undefined);
    assert.equal(existsSync(join(stateDir, 'runs', launchId, 'lock')), false);
    assert.equal((await metaOf(stateDir, launchId)).state, 'completed');
    assert.deepEqual(fixture.errors, []);
  });

  test('send answers E_INVALID while the session closes and after it is gone', PROCESS_TIMEOUT, async (t) => {
    const { fixture, launchId, held } = await heldClose(t, `own-tools ${COMPLETE_STEPS}`);
    const { manager } = fixture;
    await held.entered;
    await assert.rejects(manager.send({ launchId, text: 'more' }), (error) => assertInvalid(error, `session ${launchId}: ${COMPLETED_TEXT}`));
    held.open();
    await manager.settled();
    await assert.rejects(manager.send({ launchId, text: 'more' }), (error) => assertInvalid(error, `session ${launchId}: ${COMPLETED_TEXT}`));
    await assert.rejects(manager.send({ launchId, text: 'more', interrupt: true }), (error) =>
      assertInvalid(error, `session ${launchId}: ${COMPLETED_TEXT}`),
    );
  });

  test('cancel on a completed session answers its state', PROCESS_TIMEOUT, async (t) => {
    const { fixture, launchId, held } = await heldClose(t, `own-tools ${COMPLETE_STEPS}`);
    const { manager } = fixture;
    await held.entered;
    const closing = await manager.cancel({ launchId });
    assert.equal(closing.state, 'completed');
    assert.equal(closing.ended, null);
    held.open();
    await manager.settled();
    const gone = await manager.cancel({ launchId });
    assert.equal(gone.state, 'completed');
    assert.equal(gone.ended, null);
  });

  test('stop waits for the close, then is idempotent; the state stays completed; purge deletes the run', PROCESS_TIMEOUT, async (t) => {
    const { fixture, launchId, held, removed } = await heldClose(t, `own-tools ${COMPLETE_STEPS}`);
    const { manager, stateDir } = fixture;
    await held.entered;
    let stopped = false;
    const stopping = manager.stop({ launchId }).finally(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(stopped, false, 'stop returned before the close');
    held.open();
    const first = await stopping;
    assert.equal(first.state, 'completed');
    assert.equal(first.ended, null);
    assert.deepEqual(first.failures, []);
    assert.equal(manager.get(launchId), undefined);
    assert.equal(removed.length, 1, 'the stop leaves the close to remove the container');

    const again = await manager.stop({ launchId });
    assert.equal(again.state, 'completed');
    assert.deepEqual(again.failures, []);
    assert.equal((await metaOf(stateDir, launchId)).state, 'completed');

    const purged = await manager.stop({ launchId, purge: true });
    assert.equal(purged.state, 'completed');
    assert.equal(purged.purged, true);
    assert.equal(existsSync(join(stateDir, 'runs', launchId)), false);
    assert.deepEqual(fixture.errors, []);
  });

  test('cancel racing a completion waits for the result, not the close', PROCESS_TIMEOUT, async (t) => {
    const { fixture, launchId, held } = await heldClose(t, 'complete-then-hold 5000');
    const { manager, stateDir } = fixture;
    await completionRecorded(fixture, launchId);
    const reply = await beforeTimeout(manager.cancel({ launchId }), 3000, 'cancel', () => held.open());
    assert.equal(manager.get(launchId)?.state, 'completed', 'the close is still held when cancel returns');
    assert.equal(reply.state, 'completed');
    assert.equal(reply.turn, 1);
    assert.equal(reply.ended?.result.outcome, 'cancelled');
    assert.equal(reply.ended?.result.endedBy, 'cancel');
    assert.equal(reply.ended?.result.completion?.result, 'The task is done.');
    assert.equal((await metaOf(stateDir, launchId)).state, 'completed');
    held.open();
    await manager.settled();
    assert.equal(manager.get(launchId), undefined);
    assert.equal((await metaOf(stateDir, launchId)).state, 'completed');
  });

  test('send {interrupt} that finds the turn completed is E_INVALID; the call fails and the turn is pushed', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const { manager, stateDir } = fixture;
    const { launchId } = await manager.start({ dir: fixture.workspace.dir, prompt: 'complete-then-wait 300' });
    await completionRecorded(fixture, launchId);
    await assert.rejects(manager.send({ launchId, text: 'next', interrupt: true }, { toolUseId: 'toolu_interrupt' }), (error) =>
      assertInvalid(error, `session ${launchId}: ${COMPLETED_TEXT}`),
    );
    const result = await endedTurn(fixture, launchId, 1);
    assert.equal(result.outcome, 'end_turn');
    assert.equal(result.endedBy, null, 'Kiro ended the turn by itself');
    assert.equal(result.completion?.result, 'The task is done.');
    // Neither claimed nor returned: the waiter pushes the turn (4.6).
    assert.equal(existsSync(turnPaths(stateDir, launchId, 1).claimed), false);
    assert.equal(existsSync(turnPaths(stateDir, launchId, 1).returned), false);
    const call = (await readCall(stateDir, 'toolu_interrupt')) as { failed?: boolean; error?: string };
    assert.equal(call.failed, true);
    assert.ok(call.error?.includes(COMPLETED_TEXT), call.error);
    assert.equal((await metaOf(stateDir, launchId)).state, 'completed');
    assert.equal(manager.get(launchId), undefined);
  });

  test('send {interrupt} whose cancel ends a turn holding a completion leaves it without endedBy, and the waiter wakes it completed', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const { manager, stateDir } = fixture;
    const { launchId } = await manager.start({ dir: fixture.workspace.dir, prompt: 'complete-then-hold 5000' });
    await completionRecorded(fixture, launchId);
    // Kiro still holds the turn: the interrupt's cancel is what ends it.
    await assert.rejects(manager.send({ launchId, text: 'next', interrupt: true }, { toolUseId: 'toolu_interrupt' }), (error) =>
      assertInvalid(error, `session ${launchId}: ${COMPLETED_TEXT}`),
    );
    const result = await endedTurn(fixture, launchId, 1);
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.endedBy, null, 'the push is the only delivery of this turn (4.11)');
    assert.equal(result.completion?.result, 'The task is done.');
    assert.equal(existsSync(turnPaths(stateDir, launchId, 1).claimed), false);
    assert.equal(existsSync(turnPaths(stateDir, launchId, 1).returned), false);
    const call = (await readCall(stateDir, 'toolu_interrupt')) as { failed?: boolean; error?: string };
    assert.equal(call.failed, true);
    assert.ok(call.error?.includes(COMPLETED_TEXT), call.error);
    await manager.settled();
    const run = await metaOf(stateDir, launchId);
    assert.equal(run.state, 'completed');

    // The waiter armed for the call that opened the turn pushes it with the completed wake.
    const outcome = await pollTurn(
      {
        kind: 'turn',
        stateDir,
        launchId,
        turn: 1,
        source: 'trailer',
        run,
        sessionId: 'session-under-test',
        agentType: null,
        agentId: null,
        toolUseId: null,
      },
      { deadlineMs: 60_000, env: {} },
    );
    assert.equal(outcome.exitCode, 2);
    assert.equal(outcome.reason, 'pushed');
    const lines = (outcome.wake ?? '').split('\n');
    assert.match(lines[0] ?? '', /turn 1: completed by Kiro, cancelled, 1 tool call, /);
    assert.ok(lines.includes(RESULT_HEADER));
    assert.ok(lines.includes('The task is done.'));
    assert.deepEqual(lines.slice(-3), [
      WAKE_COMPLETED_NOTE,
      `Full text and result: wait {session: "${launchId}", turn: 1, offset: 0}.`,
      WAKE_FOOTER,
    ]);
    assert.equal(existsSync(turnPaths(stateDir, launchId, 1).pushed), true);
  });

  test('stop racing a completion ends the turn and the state stays completed', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const { manager, stateDir } = fixture;
    const { launchId } = await manager.start({ dir: fixture.workspace.dir, prompt: 'complete-then-hold 5000' });
    await completionRecorded(fixture, launchId);
    const reply = await manager.stop({ launchId });
    assert.equal(reply.state, 'completed');
    assert.equal(reply.ended?.turn, 1);
    assert.equal(reply.ended?.result.completion?.result, 'The task is done.');
    assert.equal(reply.ended?.result.endedBy, 'stop');
    assert.equal(manager.get(launchId), undefined);
    assert.equal(isAlive(fixture.spawned[0] ?? 0), false);
    assert.equal((await metaOf(stateDir, launchId)).state, 'completed');
    assert.equal(existsSync(join(stateDir, 'runs', launchId, 'lock')), false);
    assert.deepEqual(fixture.errors, []);
  });

  test('a Kiro exit after the call ends the run completed', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const { manager, stateDir } = fixture;
    const { launchId } = await manager.start({ dir: fixture.workspace.dir, prompt: 'complete-then-exit' });
    const result = await endedTurn(fixture, launchId, 1);
    assert.equal(result.outcome, 'exited');
    assert.equal(result.endedBy, null);
    assert.equal(result.completion?.result, 'The task is done.');
    assert.equal((await metaOf(stateDir, launchId)).state, 'completed');
    assert.equal(manager.get(launchId), undefined);
    assert.equal(existsSync(join(stateDir, 'runs', launchId, 'lock')), false);
  });

  test('the shutdown ends a turn holding a completion completed and the others exited', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const { manager, stateDir } = fixture;
    const completed = (await manager.start({ dir: fixture.workspace.dir, prompt: 'complete-then-hold 5000' })).launchId;
    const plain = (await manager.start({ dir: fixture.workspace.dir, prompt: 'hold 5000' })).launchId;
    await completionRecorded(fixture, completed);
    await waitFor(() => manager.get(plain)?.runningTurn?.toolCalls === 1, 'the running tool');
    await manager.shutdown();
    await manager.settled();
    const result = await turnResultOf(stateDir, completed, 1);
    assert.equal(result.outcome, 'exited');
    assert.equal(result.error, SHUTDOWN_ERROR);
    assert.equal(result.completion?.result, 'The task is done.');
    assert.equal((await metaOf(stateDir, completed)).state, 'completed');
    assert.equal((await metaOf(stateDir, plain)).state, 'exited');
  });
});
