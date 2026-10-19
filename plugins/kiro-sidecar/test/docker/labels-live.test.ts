// Starts a container with the labels of the built `docker run` command, with
// `sleep` in place of the kiro-cli entrypoint, and checks that docker finds it
// by its launch label and reports every label with its value.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { buildDockerLaunch, resolveMountSet } from '../../src/docker/launch.ts';
import { resolveDockerUser } from '../../src/docker/user.ts';
import { SidecarError } from '../../src/errors.ts';
import { newLaunchId } from '../../src/store/paths.ts';
import { ensureHome, ensureRunCopyDirs } from '../../src/store/runs.ts';
import { tempDir } from '../helpers/processes.ts';
import { SKIP_WITHOUT_IMAGE, TEST_IMAGE, docker, liveLaunchIdentity, removeTestContainer, testContainerName } from './live.ts';

const PLACEHOLDER_TOKEN = 'placeholder-token-not-a-real-key';

/** `auto`, or on a rootful daemon the uid and gid of this process. */
async function containerUser(): Promise<string> {
  try {
    return await resolveDockerUser('auto');
  } catch (error) {
    if (error instanceof SidecarError && error.code === 'E_DOCKER' && process.getuid !== undefined) {
      return `${process.getuid()}:${process.getgid?.() ?? 0}`;
    }
    throw error;
  }
}

/** The names of the containers that carry `label`. */
async function namesWithLabel(label: string): Promise<string[]> {
  const result = await docker(['ps', '-a', '--filter', `label=${label}`, '--format', '{{.Names}}']);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.split('\n').filter((line) => line !== '');
}

describe('docker labels, live', () => {
  test('a container started with the built labels is found by its launch label', { skip: SKIP_WITHOUT_IMAGE, timeout: 120_000 }, async (t) => {
    // `after` hooks run in registration order and stop at the first failure:
    // the container goes first, while it runs its bind-mounted directories
    // cannot be removed.
    const name = testContainerName();
    t.after(() => removeTestContainer(name));
    const stateDir = await realpath(await tempDir(t));
    const work = await realpath(await tempDir(t));
    const launchId = newLaunchId();
    const home = await ensureHome(stateDir, 'default');
    const copies = await ensureRunCopyDirs(stateDir, launchId);
    const identity = await liveLaunchIdentity(PLACEHOLDER_TOKEN);
    const launch = await buildDockerLaunch({
      launchId,
      mountSet: await resolveMountSet({ dir: work, stateDir }),
      user: await containerUser(),
      image: TEST_IMAGE,
      token: PLACEHOLDER_TOKEN,
      env: process.env,
      kiroHome: { home: home.dir, skills: copies.skills, steering: copies.steering },
      ...identity,
    });
    const nameIndex = launch.args.indexOf('--name') + 1;
    const entrypointIndex = launch.args.indexOf('--entrypoint');
    assert.ok(nameIndex > 0 && entrypointIndex > 0);
    const head = launch.args.slice(1, entrypointIndex).map((arg, index) => (index + 1 === nameIndex ? name : arg));
    const started = await docker(['run', '-d', ...head, '--entrypoint', 'sleep', TEST_IMAGE, '120']);
    assert.equal(started.code, 0, started.stderr);

    assert.deepEqual(await namesWithLabel(`kiro-sidecar.launch=${launchId}`), [name]);
    assert.deepEqual(await namesWithLabel(`kiro-sidecar.launch=${newLaunchId()}`), []);

    const inspected = await docker(['inspect', '--format', '{{json .Config.Labels}}', name]);
    assert.equal(inspected.code, 0, inspected.stderr);
    const labels = JSON.parse(inspected.stdout) as Record<string, string>;
    const driver = identity.owner.driver;
    assert.deepEqual(
      Object.fromEntries(Object.entries(labels).filter(([key]) => key.startsWith('kiro-sidecar.'))),
      {
        'kiro-sidecar.launch': launchId,
        'kiro-sidecar.owner': identity.owner.ownerKey,
        'kiro-sidecar.driver-pid': String(driver.pid),
        'kiro-sidecar.driver-start': driver.startTime,
        'kiro-sidecar.host': driver.hostId,
      },
    );
  });
});
