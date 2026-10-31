/** The op-bridge command line (`dist/cli.js`), started by `bin/op-bridge`. */

import { fstatSync, statSync } from 'node:fs';
import { runCli } from './redeem.ts';

/**
 * Node reopens a closed fd 1 on /dev/null at startup, so `>&-` and `>/dev/null`
 * look the same here: a character device with the null device's rdev. A pipe,
 * a file or a terminal is never discarded. An fd 1 that cannot be inspected
 * counts as discarded; a /dev/null that cannot be inspected matches nothing.
 */
function stdoutDiscarded(): boolean {
  let out;
  try {
    out = fstatSync(1);
  } catch {
    return true;
  }
  if (!out.isCharacterDevice()) return false;
  try {
    return out.rdev === statSync('/dev/null').rdev;
  } catch {
    return false;
  }
}

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: process.stdout,
  stdoutDiscarded,
  writeError: (line) => process.stderr.write(`${line}\n`),
});
