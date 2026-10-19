import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProcessHandle } from '../../src/acp/process.ts';
import { processIdentity } from '../../src/store/identity.ts';
import type { ProcessIdentity } from '../../src/store/identity.ts';

export interface LiveProcess {
  readonly child: ChildProcess;
  readonly identity: ProcessIdentity;
  /** Kills the process and waits until it has been reaped. */
  stop(): Promise<void>;
}

/** Starts an idle node process that runs until it is stopped. */
export async function startIdleProcess(): Promise<LiveProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], {
    stdio: 'ignore',
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('Could not start an idle process');
  }
  const identity = await processIdentity(pid);
  if (identity === null) {
    throw new Error(`Idle process ${pid} is not running`);
  }
  const exited = once(child, 'exit');
  return {
    child,
    identity,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exited;
    },
  };
}

/** The identity of a process that has run on this host and is now gone. */
export async function deadIdentity(): Promise<ProcessIdentity> {
  const idle = await startIdleProcess();
  await idle.stop();
  return idle.identity;
}

/** A fresh temp directory, removed when the test ends. */
export async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kiro-sidecar-test-'));
  t.after(() => removeTree(dir));
  return dir;
}

/** How long a removal refused with EACCES is retried. */
const REMOVE_EACCES_RETRY_MS = 5_000;

/**
 * Removes a directory tree. A file created while the tree is being removed
 * (a write still in flight from a process that is ending) fails the removal
 * of its directory with ENOTEMPTY; `rm` then retries a few times. Docker
 * Desktop releases a bind-mount point a moment after its container is gone
 * and refuses its `rmdir` with EACCES until then, which `rm` does not retry;
 * that is retried here for a few seconds.
 */
export async function removeTree(dir: string): Promise<void> {
  const deadline = Date.now() + REMOVE_EACCES_RETRY_MS;
  for (;;) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EACCES' || Date.now() >= deadline) {
        throw error;
      }
      await delay(100);
    }
  }
}

/** Time between SIGTERM and SIGKILL when a teardown ends what is still running. */
const TEARDOWN_KILL_GRACE_MS = 250;

/**
 * Ends every process in `handles` that is still running and waits until each
 * has been reaped. A kill already under way is joined, not restarted.
 */
export async function endProcesses(handles: readonly ProcessHandle[]): Promise<void> {
  await Promise.all(handles.map((handle) => handle.kill(TEARDOWN_KILL_GRACE_MS)));
}
