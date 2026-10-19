// One contender in the lock race test.
// Usage: node lock-racer.ts <stateDir> <launchId>
// Prints "ready" once warmed up, tries the lock when it reads "go" on stdin,
// prints the outcome as JSON, then stays alive (holding a won lock) until
// stdin closes.
import { createInterface } from 'node:readline';
import { currentDriver } from '../../src/store/identity.ts';
import { acquireRunLock } from '../../src/store/lock.ts';

const [stateDir, launchId] = process.argv.slice(2);
if (stateDir === undefined || launchId === undefined) {
  throw new Error('usage: lock-racer.ts <stateDir> <launchId>');
}

// Read the identity and host id before the race so that the race itself is
// only file system work.
await currentDriver();

const lines = createInterface({ input: process.stdin });
lines.once('line', () => {
  void acquireRunLock(stateDir, launchId).then(
    (attempt) => {
      const outcome = attempt.acquired
        ? { pid: process.pid, acquired: true }
        : { pid: process.pid, acquired: false, reason: attempt.reason };
      process.stdout.write(`${JSON.stringify(outcome)}\n`);
    },
    (error: unknown) => {
      process.stdout.write(`${JSON.stringify({ pid: process.pid, error: String(error) })}\n`);
    },
  );
});
process.stdout.write('ready\n');
