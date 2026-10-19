/**
 * The waiter hook, run after `start` and `send` as `waiter.js --deadline-s <n>`:
 * finds the turn the call opened (steps 1 to 3, `hooks/waiter-setup.ts`),
 * polls it (step 4, `hooks/waiter-loop.ts`) and exits 2 with the wake text
 * on stderr, or 0 when there is nothing to deliver.
 *
 * - Invalid arguments: one `hooks.log` line, exit 0.
 * - SIGTERM, SIGHUP, SIGINT: one `hooks.log` line, exit 0 with nothing on
 *   stderr. Once the push has begun it is finished instead.
 * - Exit code 2 is set only when the wake text has been written to stderr;
 *   the process is never exited early, so stderr is not cut.
 * - Anything unexpected: an `internal` line with the error code only, exit 0.
 */

import { appendHookLog } from './hooks/log.ts';
import type { HookLogIds, HookStep } from './hooks/log.ts';
import { SYSTEM_CLOCK } from './hooks/turn.ts';
import { parseDeadlineArg, pollTurn, turnLogIds } from './hooks/waiter-loop.ts';
import type { WaiterOutcome } from './hooks/waiter-loop.ts';
import { setUpWaiter } from './hooks/waiter-setup.ts';
import { resolveStateDir } from './store/paths.ts';

/** A signal exit waits at most this long for its log line. */
const SIGNAL_EXIT_MS = 500;

const clock = SYSTEM_CLOCK;
// The deadline counts from here, the waiter's own start.
const startedAt = clock.now();

let stateDir: string | null;
try {
  stateDir = resolveStateDir(process.env);
} catch {
  // Without a state directory there is nowhere to log; setup skips as well.
  stateDir = null;
}

let ids: HookLogIds = {};
let step: HookStep = 'input';
/** `pushing` once the push has begun, `stopping` once a signal has come first. */
const waiter: { phase: 'running' | 'pushing' | 'stopping' } = { phase: 'running' };

function log(logStep: HookStep, reason: string, error?: unknown): Promise<void> {
  if (stateDir === null) {
    return Promise.resolve();
  }
  return appendHookLog(
    stateDir,
    { hook: 'waiter', step: logStep, reason, ...ids, ...(error === undefined ? {} : { error }) },
    new Date(clock.now()),
  );
}

function stop(): void {
  if (waiter.phase !== 'running') {
    return;
  }
  waiter.phase = 'stopping';
  setTimeout(() => process.exit(0), SIGNAL_EXIT_MS).unref();
  void log(step, 'signal').finally(() => process.exit(0));
}

for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
  process.on(signal, stop);
}

async function waitForTurn(): Promise<WaiterOutcome | null> {
  const deadlineS = parseDeadlineArg(process.argv.slice(2));
  if (deadlineS === null) {
    await log('input', 'bad-arguments');
    return null;
  }
  const setup = await setUpWaiter(stateDir === null ? { clock } : { stateDir, clock });
  if (setup.kind === 'skip') {
    return null;
  }
  ids = turnLogIds(setup);
  step = 'turn';
  return pollTurn(setup, {
    clock,
    startedAt,
    deadlineMs: deadlineS * 1000,
    beginPush: () => {
      if (waiter.phase === 'stopping') {
        return false;
      }
      waiter.phase = 'pushing';
      return true;
    },
  });
}

let outcome: WaiterOutcome | null;
try {
  outcome = await waitForTurn();
} catch (error) {
  await log(step, 'internal', error);
  outcome = null;
}

// A stopping waiter writes nothing; `stop` exits it.
if (outcome !== null && outcome.wake !== null && waiter.phase !== 'stopping') {
  // A reader that went away fails the write; the exit code stays 0 then.
  process.stderr.on('error', () => {});
  process.stderr.write(outcome.wake, (error) => {
    if (error === null || error === undefined) {
      process.exitCode = outcome.exitCode;
    }
  });
}
