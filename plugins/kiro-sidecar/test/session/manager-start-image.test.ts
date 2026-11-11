/**
 * B in the start step `docker_image`: the image check with its refresh,
 * driven by the real `checkImage` over a fake docker (no docker needed),
 * and a `docker run` that runs the fake agent in place.
 */
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnProcess } from '../../src/acp/process.ts';
import { checkImage, readPullRecord } from '../../src/docker/image.ts';
import type { ImageDocker, LocalImage } from '../../src/docker/image.ts';
import { SidecarError } from '../../src/errors.ts';
import type { Settings } from '../../src/settings.ts';
import { PROCESS_TIMEOUT, TEST_TOKEN, managerFixture, metaOf, testEnvironment, waitFor } from './manager-helpers.ts';
import type { ManagerFixture } from './manager-helpers.ts';

const IMAGE = 'kiro-test:latest';
const OLD: LocalImage = { id: 'sha256:1111111111111111111111111111111111111111111111111111111111111111', created: '2026-11-03T10:00:00Z' };
const NEW: LocalImage = { id: 'sha256:2222222222222222222222222222222222222222222222222222222222222222', created: '2026-11-10T09:00:00Z' };

interface Pulls {
  count: number;
  signals: Array<AbortSignal | undefined>;
}

/**
 * A docker fixture whose image check is the real one over a fake docker:
 * `local` is the local image, `pull` what a pull does (it may change `state.local`).
 */
async function imageFixture(
  t: TestContext,
  options: {
    readonly local: LocalImage | null;
    readonly pull: (state: { local: LocalImage | null }, signal: AbortSignal | undefined) => Promise<void>;
    readonly settings?: Partial<Settings>;
    readonly deadlineMs?: number;
  },
): Promise<{ fixture: ManagerFixture; pulls: Pulls; spawned: () => number }> {
  const state = { local: options.local };
  const pulls: Pulls = { count: 0, signals: [] };
  const docker: ImageDocker = {
    inspect: async () => state.local,
    pull: async (_image, pullOptions) => {
      pulls.count += 1;
      pulls.signals.push(pullOptions.signal);
      await options.pull(state, pullOptions.signal);
    },
  };
  let command = '';
  let spawned = 0;
  const fixture = await managerFixture(t, 'default', {
    settings: { api_key: TEST_TOKEN, ...options.settings },
    ...(options.deadlineMs === undefined ? {} : { startLimits: { deadlineMs: options.deadlineMs } }),
    deps: {
      resolveDockerUser: async () => '0:0',
      checkImage: (image, env, context) => checkImage(image, env, { ...context, docker }),
      spawn: (spec, processOptions) => {
        spawned += 1;
        return spawnProcess(
          { argv: [command, 'acp', '--agent-engine', 'v3'], env: testEnvironment() as Record<string, string>, cwd: spec.cwd },
          processOptions,
        );
      },
      removeContainers: () => {},
    },
  });
  command = fixture.workspace.command;
  return { fixture, pulls, spawned: () => spawned };
}

function startDocker(fixture: ManagerFixture) {
  return fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir, image: IMAGE });
}

describe('SessionManager.start: the image refresh (B)', () => {
  test('a pull longer than the start deadline does not fail the start; the reply names the old and new id', PROCESS_TIMEOUT, async (t) => {
    const { fixture, pulls } = await imageFixture(t, {
      local: OLD,
      pull: async (state) => {
        await sleep(3_500);
        state.local = NEW;
      },
      deadlineMs: 3_000,
    });
    const result = await startDocker(fixture);
    assert.equal(pulls.count, 1);
    assert.equal(
      result.imageRefresh,
      `docker pull replaced image ${IMAGE}: ${OLD.id} is now ${NEW.id}; the Kiro CLI inside may have changed.`,
    );
    const meta = await metaOf(fixture.stateDir, result.launchId);
    assert.equal(meta.imageId, NEW.id);
    assert.equal(meta.state, 'idle');
  });

  test('a pull that changed nothing adds nothing to the reply; meta.json has the image id', PROCESS_TIMEOUT, async (t) => {
    const { fixture, pulls } = await imageFixture(t, { local: OLD, pull: async () => {} });
    const result = await startDocker(fixture);
    assert.equal(pulls.count, 1);
    assert.equal('imageRefresh' in result, false);
    assert.equal((await metaOf(fixture.stateDir, result.launchId)).imageId, OLD.id);
    // The second start of the day pulls nothing.
    const again = await startDocker(fixture);
    assert.equal(pulls.count, 1);
    assert.equal('imageRefresh' in again, false);
  });

  test('a failed pull of a present image: the start goes on, and the reply says why and which image', PROCESS_TIMEOUT, async (t) => {
    const { fixture } = await imageFixture(t, {
      local: OLD,
      pull: async () => {
        throw new SidecarError('E_DOCKER', 'docker pull did not finish within 600000 ms');
      },
    });
    const result = await startDocker(fixture);
    assert.equal(
      result.imageRefresh,
      `The refresh of image ${IMAGE} failed (docker pull did not finish within 600000 ms); ` +
        `this start uses the local image ${OLD.id}, created ${OLD.created}.`,
    );
    assert.equal((await metaOf(fixture.stateDir, result.launchId)).imageId, OLD.id);
  });

  test('an absent image that cannot be pulled: E_IMAGE_MISSING with the reason, nothing spawned', PROCESS_TIMEOUT, async (t) => {
    const { fixture, spawned } = await imageFixture(t, {
      local: null,
      pull: async () => {
        throw new Error('docker pull exited with code 1: manifest unknown');
      },
    });
    await assert.rejects(startDocker(fixture), (error: unknown) => {
      assert.ok(error instanceof SidecarError);
      assert.equal(error.code, 'E_IMAGE_MISSING');
      assert.ok(error.message.includes(`docker pull ${IMAGE}`), error.message);
      assert.ok(error.message.endsWith('(the pull failed: docker pull exited with code 1: manifest unknown)'), error.message);
      return true;
    });
    assert.equal(spawned(), 0);
  });

  test('refresh hours 0: nothing is pulled and the reply gains nothing', PROCESS_TIMEOUT, async (t) => {
    const { fixture, pulls } = await imageFixture(t, {
      local: OLD,
      pull: async () => assert.fail('must not pull'),
      settings: { docker_image_refresh_hours: 0 },
    });
    const result = await startDocker(fixture);
    assert.equal(pulls.count, 0);
    assert.equal('imageRefresh' in result, false);
    assert.equal((await metaOf(fixture.stateDir, result.launchId)).imageId, OLD.id);
  });

  test('the shutdown ends a running pull', PROCESS_TIMEOUT, async (t) => {
    const { fixture, pulls } = await imageFixture(t, {
      local: OLD,
      pull: (_state, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('docker pull was aborted')), { once: true });
        }),
    });
    const start = startDocker(fixture);
    start.catch(() => {});
    await waitFor(() => pulls.count === 1, 'the pull to start');
    await fixture.manager.shutdown();
    assert.equal(pulls.signals[0]?.aborted, true);
    await assert.rejects(start, { code: 'E_STEP_DOCKER_IMAGE' });
    // An ended pull is no failure: the next start is not held off for an hour.
    assert.equal(await readPullRecord(fixture.stateDir, IMAGE), null);
  });

  test('a local start records no image id', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const result = await fixture.manager.start({ dir: fixture.workspace.dir });
    assert.equal((await metaOf(fixture.stateDir, result.launchId)).imageId, null);
  });
});
