/**
 * The SessionStart hook, run as `context.js` when a conversation starts in a
 * Claude process that may already own Kiro sessions (`hooks/context.ts`).
 *
 * - It writes at most one JSON object to stdout and always exits 0: a
 *   session start is never blocked.
 * - The process is never exited early, so stdout is not cut.
 * - Anything unexpected: an `internal` line with the error code only.
 */

import { runContextHook } from './hooks/context.ts';
import { resolveStateDir } from './store/paths.ts';

let stateDir: string | null;
try {
  stateDir = resolveStateDir(process.env);
} catch {
  // Without a state directory there are no runs and nowhere to log.
  stateDir = null;
}

const output = await runContextHook({ stdin: process.stdin, stateDir, env: process.env });
if (output !== null) {
  // A reader that went away fails the write; the exit code stays 0.
  process.stdout.on('error', () => {});
  process.stdout.write(`${output}\n`);
}
