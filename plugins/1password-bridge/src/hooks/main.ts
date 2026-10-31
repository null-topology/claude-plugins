/**
 * The hook entry point (`dist/hook.js`), for every event in hooks/hooks.json.
 * It exits 0 on every path; see run.ts.
 */

import { runHook } from './run.ts';

// A closed stdout must not turn into an uncaught error and a non-zero exit.
process.stdout.on('error', () => {});

// runHook never rejects; the catch keeps a top-level rejection from setting exit code 1 anyway.
await runHook({ stdin: process.stdin, env: process.env, write: (text) => process.stdout.write(text) }).catch(() => {});
process.exitCode = 0;
