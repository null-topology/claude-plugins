import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABEL_LAUNCH } from '../../src/docker/launch.ts';
import {
  isRemovableContainerName,
  removeContainersById,
  removeContainersByLabel,
  removeContainersDetached,
} from '../../src/docker/remove.ts';
import { SidecarError } from '../../src/errors.ts';
import { DEFAULT_SHUTDOWN_LIMITS } from '../../src/session/manager.ts';
import { newLaunchId } from '../../src/store/paths.ts';
import { tempDir } from '../helpers/processes.ts';
import {
  SKIP_WITHOUT_IMAGE,
  TEST_IMAGE,
  containerExists,
  docker,
  pollUntil,
  removeTestContainer,
  startIdleTestContainer,
  testContainerName,
} from './live.ts';

const RUNNER = fileURLToPath(new URL('../fixtures/docker-remove-runner.ts', import.meta.url));

/**
 * The longest the removal call may take. At shutdown it runs before the kill
 * of the local children, which need the grace period inside the budget to
 * reach SIGKILL, so the call may use at most the rest of the budget: 200 ms
 * with the defaults, well inside the 500 ms the server has to exit. A spawn
 * that returns at once takes a few ms and stays far below this on a loaded
 * machine; a call that waited for the 2 s stub below would not.
 */
const CALL_BOUND_MS = DEFAULT_SHUTDOWN_LIMITS.budgetMs - DEFAULT_SHUTDOWN_LIMITS.graceMs;

/** A docker stand-in: waits, then records its arguments and one CLAUDE_* variable. */
const SLOW_DOCKER_STUB = `#!/bin/sh
sleep 2
printf '%s|%s\\n' "$*" "\${CLAUDE_SIDECAR_PROBE:-unset}" > "$KIRO_SIDECAR_STUB_MARKER"
`;

interface RunnerResult {
  readonly code: number | null;
  readonly elapsedMs: number;
}

/** Runs the removal runner to its natural end. */
async function runRunner(names: readonly string[], env: NodeJS.ProcessEnv): Promise<RunnerResult> {
  const child = spawn(process.execPath, [RUNNER, ...names], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  const [code] = (await once(child, 'close')) as [number | null];
  const parsed = JSON.parse(stdout) as { elapsedMs: number };
  return { code, elapsedMs: parsed.elapsedMs };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('detached container removal', () => {
  test('refuses a name outside the plugin prefix', () => {
    for (const name of ['rv-kb-pg', 'kiro-sidecar-', 'kiro-sidecar--rm', '-f', 'kiro-sidecar-a b']) {
      assert.equal(isRemovableContainerName(name), false, name);
      assert.throws(() => removeContainersDetached([name]), TypeError);
    }
    assert.throws(() => removeContainersDetached(['kiro-sidecar-0123456789ab', 'rv-kb-pg']), TypeError);
    assert.equal(isRemovableContainerName('kiro-sidecar-0123456789ab'), true);
  });

  test('an empty list starts nothing', () => {
    assert.equal(removeContainersDetached([], { PATH: '/nonexistent-kiro-sidecar-path' }), undefined);
  });

  test('a missing docker CLI does not throw', async () => {
    removeContainersDetached(['kiro-sidecar-0123456789ab'], { PATH: '/nonexistent-kiro-sidecar-path' });
    // The spawn error arrives asynchronously; an unhandled one would fail the test run.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  test('the removal outlives its caller, which ends without waiting for it', async (t) => {
    const dir = await tempDir(t);
    const stub = join(dir, 'docker');
    await writeFile(stub, SLOW_DOCKER_STUB, { mode: 0o755 });
    const marker = join(dir, 'marker');
    const result = await runRunner(['kiro-sidecar-0123456789ab', 'kiro-sidecar-ba9876543210'], {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      KIRO_SIDECAR_STUB_MARKER: marker,
      CLAUDE_SIDECAR_PROBE: 'present',
    });
    assert.equal(result.code, 0);
    assert.ok(result.elapsedMs < CALL_BOUND_MS, `the call took ${result.elapsedMs} ms`);
    assert.equal(await exists(marker), false, 'the caller ended only after the removal finished');
    assert.ok(await pollUntil(() => exists(marker), 10_000), 'the removal never finished');
    assert.equal(
      (await readFile(marker, 'utf8')).trim(),
      'rm -f kiro-sidecar-0123456789ab kiro-sidecar-ba9876543210|unset',
    );
  });

  test('live: a container is gone after the call returns at once', { skip: SKIP_WITHOUT_IMAGE, timeout: 60_000 }, async (t) => {
    const name = await startIdleTestContainer();
    t.after(() => removeTestContainer(name));
    assert.equal(await containerExists(name), true);
    const result = await runRunner([name], process.env);
    assert.equal(result.code, 0);
    assert.ok(result.elapsedMs < CALL_BOUND_MS, `the call took ${result.elapsedMs} ms`);
    const gone = await pollUntil(async () => !(await containerExists(name)), 15_000);
    assert.ok(gone, `${name} still exists 15 s after the removal started`);
  });
});

/**
 * A docker stand-in: `ps` lists two containers, `rm` records its arguments
 * and, like docker for a container that went away in between, prints only
 * the first as removed and exits 0.
 */
const GONE_IN_BETWEEN_STUB = `#!/bin/sh
case "$1" in
  ps) printf '%s\\n%s\\n' "$KIRO_SIDECAR_STUB_FIRST" "$KIRO_SIDECAR_STUB_SECOND" ;;
  rm) printf '%s\\n' "$*" > "$KIRO_SIDECAR_STUB_MARKER"; printf '%s\\n' "$KIRO_SIDECAR_STUB_FIRST" ;;
  *) exit 64 ;;
esac
`;

describe('container removal by launch label', () => {
  test('reports only the containers docker removed, not every one it listed', async (t) => {
    const dir = await tempDir(t);
    await writeFile(join(dir, 'docker'), GONE_IN_BETWEEN_STUB, { mode: 0o755 });
    const marker = join(dir, 'marker');
    const first = randomBytes(32).toString('hex');
    const second = randomBytes(32).toString('hex');
    const removed = await removeContainersByLabel(newLaunchId(), {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      KIRO_SIDECAR_STUB_FIRST: first,
      KIRO_SIDECAR_STUB_SECOND: second,
      KIRO_SIDECAR_STUB_MARKER: marker,
    });
    assert.deepEqual(removed, [first]);
    assert.equal((await readFile(marker, 'utf8')).trim(), `rm -f ${first} ${second}`);
  });

  test('live: a labelled container is reported once, a second call finds none', { skip: SKIP_WITHOUT_IMAGE, timeout: 60_000 }, async (t) => {
    const launchId = newLaunchId();
    const name = testContainerName();
    t.after(() => removeTestContainer(name));
    const started = await docker([
      'run', '-d', '--rm', '--name', name, '--label', `${LABEL_LAUNCH}=${launchId}`, '--entrypoint', 'sleep', TEST_IMAGE, '120',
    ]);
    assert.equal(started.code, 0, started.stderr);
    const id = started.stdout.trim();
    assert.match(id, /^[0-9a-f]{64}$/);

    assert.deepEqual(await removeContainersByLabel(launchId), [id]);
    assert.equal(await containerExists(name), false);
    assert.deepEqual(await removeContainersByLabel(launchId), []);
  });
});

/**
 * A docker stand-in for `rm`: prints the first container as removed, prints
 * the given error output, and exits 1, as docker does when it fails on a
 * container of the call.
 */
const FAILING_RM_STUB = `#!/bin/sh
printf '%s\\n' "$KIRO_SIDECAR_STUB_FIRST"
printf '%s\\n' "$KIRO_SIDECAR_STUB_STDERR" >&2
exit 1
`;

describe('container removal by id', () => {
  test('a failed removal is ignored only when every error line names a container already gone', async (t) => {
    const dir = await tempDir(t);
    await writeFile(join(dir, 'docker'), FAILING_RM_STUB, { mode: 0o755 });
    const [first, second, third] = [1, 2, 3].map(() => randomBytes(32).toString('hex')) as [string, string, string];
    const env = (stderr: string) => ({
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      KIRO_SIDECAR_STUB_FIRST: first,
      KIRO_SIDECAR_STUB_STDERR: stderr,
    });
    const gone = (id: string): string => `Error response from daemon: No such container: ${id}`;
    const failsWith = (pattern: RegExp) => (error: unknown) => {
      assert.ok(error instanceof SidecarError, String(error));
      assert.equal(error.code, 'E_DOCKER', error.message);
      assert.match(error.message, pattern);
      return true;
    };

    assert.deepEqual(await removeContainersById([first, second, third], env(`${gone(second)}\n\n${gone(third)}`)), [first]);
    const denied = `Error response from daemon: cannot remove container "/${third}": could not kill container: permission denied`;
    await assert.rejects(
      removeContainersById([first, second, third], env(`${gone(second)}\n${denied}`)),
      failsWith(/exited with code 1: [^]*permission denied/),
    );
    await assert.rejects(removeContainersById([first], env('')), failsWith(/exited with code 1: no error output$/));
  });
});
