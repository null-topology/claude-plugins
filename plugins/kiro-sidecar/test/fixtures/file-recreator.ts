// Recreates a file right after something deletes it, as a waiter's
// heartbeat can while a run directory is being removed. It runs as a worker
// so that the loop is truly concurrent with the removal.
// workerData: { file, recreations, deadlineMs }. Posts "ready" before the
// loop, then how many times it recreated the file. It stops after
// `recreations`, once the file's directory is gone, or at the deadline.
import { existsSync, writeFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

const { file, recreations, deadlineMs } = workerData as { file: string; recreations: number; deadlineMs: number };
const deadline = Date.now() + deadlineMs;
let made = 0;
parentPort?.postMessage('ready');
while (made < recreations && Date.now() < deadline) {
  if (existsSync(file)) {
    continue;
  }
  try {
    // Exclusive, so only a deleted file counts as recreated.
    writeFileSync(file, '', { flag: 'wx' });
    made += 1;
  } catch (error) {
    // ENOENT: the directory is gone, nothing can be recreated any more.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      break;
    }
  }
}
parentPort?.postMessage(made);
