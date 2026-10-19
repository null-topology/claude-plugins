import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SidecarError } from '../../src/errors.ts';
import { readCall } from '../../src/store/runs.ts';
import { PROCESS_TIMEOUT, managerFixture } from './manager-helpers.ts';
import { tempDir } from '../helpers/processes.ts';

/** Rejects when `work` does not settle within `ms`, so a hang fails the test. */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Occupies every thread of the libuv pool with a FIFO open that waits for a
 * writer, so each file system call queues behind them: a stand-in for a
 * stalled disk. Returns the function that lets the queue run again.
 */
async function stallFileSystem(t: TestContext): Promise<() => Promise<void>> {
  const dir = await tempDir(t);
  const size = Number(process.env['UV_THREADPOOL_SIZE'] ?? 4);
  const paths: string[] = [];
  const readers: Array<Promise<{ close(): Promise<void> }>> = [];
  for (let index = 0; index < size; index += 1) {
    const path = join(dir, `stall-${index}`);
    execFileSync('mkfifo', [path]);
    paths.push(path);
    readers.push(open(path, 'r'));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    for (const path of paths) {
      closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
    }
    for (const reader of readers) {
      await (await reader).close();
    }
  };
}

async function runIds(stateDir: string): Promise<string[]> {
  try {
    return await readdir(join(stateDir, 'runs'));
  } catch {
    return [];
  }
}

function assertGivenUp(error: unknown, fragment: string): boolean {
  assert.ok(error instanceof SidecarError, `unexpected ${String(error)}`);
  assert.match(error.code, /^E_STEP_/);
  assert.ok(error.message.includes(fragment), error.message);
  return true;
}

describe('SessionManager.start deadline and abort before the first step', () => {
  test('a client abort ends a start whose checks are stalled, and nothing is left behind', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const release = await stallFileSystem(t);
    try {
      const abort = new AbortController();
      const start = fixture.manager.start(
        { dir: fixture.workspace.dir, prompt: 'hello' },
        { toolUseId: 'toolu_stalled', signal: abort.signal },
      );
      setTimeout(() => abort.abort(), 100);
      await within(
        assert.rejects(start, (error) => assertGivenUp(error, 'the start was aborted')),
        3_000,
        'the aborted start',
      );
    } finally {
      await release();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fixture.manager.settled();
    assert.deepEqual(await runIds(fixture.stateDir), []);
    assert.equal(await readCall(fixture.stateDir, 'toolu_stalled'), undefined);
    await assert.rejects(fixture.workspace.started());
  });

  test('the start deadline ends a start whose checks are stalled', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default', { startLimits: { deadlineMs: 300 } });
    const release = await stallFileSystem(t);
    try {
      const start = fixture.manager.start({ dir: fixture.workspace.dir });
      await within(
        assert.rejects(start, (error) => {
          assertGivenUp(error, 'the start deadline was reached');
          // Every file system call is held from before the start until it answers, so only the checks can be running.
          assert.equal((error as SidecarError).code, 'E_STEP_VALIDATE', (error as Error).message);
          return true;
        }),
        3_000,
        'the start past its deadline',
      );
    } finally {
      await release();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fixture.manager.settled();
    assert.deepEqual(await runIds(fixture.stateDir), []);
  });
});
