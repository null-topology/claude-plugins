// The startup sweep when the tool context cannot be resolved at first: it is
// skipped, and runs once after the next resolution that succeeds.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isLiveState } from '../../src/session/resolve.ts';
import { Runtime } from '../../src/tools/runtime.ts';
import { deadIdentity, tempDir } from '../helpers/processes.ts';
import { writeRun } from '../session/helpers-runs.ts';
import { TEST_TOKEN, metaOf, testEnvironment, waitFor } from '../session/manager-helpers.ts';

describe('runtime startup sweep', () => {
  test('a sweep skipped for a failed resolution runs once after the next one succeeds', async (t) => {
    const stateDir = await tempDir(t);
    const projectDir = join(await tempDir(t), 'project');
    const logs: string[] = [];
    let removals = 0;
    const runtime = new Runtime({
      env: testEnvironment({
        KIRO_SIDECAR_API_KEY: TEST_TOKEN,
        KIRO_SIDECAR_DEFAULT_MODE: 'local',
        // Missing until the test creates it: the first resolution fails on it.
        CLAUDE_PROJECT_DIR: projectDir,
      }),
      stateDir,
      log: (line) => logs.push(line),
      deps: {
        removeContainersByLabel: async () => {
          removals += 1;
          return [];
        },
        listHostContainers: async () => [],
      },
    });
    t.after(async () => {
      const context = await runtime.context().catch(() => undefined);
      await runtime.shutdown();
      await context?.manager.settled();
    });
    const run = await writeRun(stateDir, { driver: await deadIdentity(), state: 'idle' });

    await runtime.sweep();
    assert.equal(logs.filter((line) => line.includes('startup sweep skipped')).length, 1, logs.join('\n'));
    assert.equal((await metaOf(stateDir, run.launchId)).state, 'idle', 'the skipped sweep touched the run');

    await mkdir(projectDir);
    await runtime.context();
    await waitFor(
      async () => !isLiveState((await metaOf(stateDir, run.launchId)).state),
      'the deferred sweep to settle the dead run',
    );
    await runtime.sweep();
    assert.equal(removals, 1, 'the sweep ran more than once');
    assert.ok(
      logs.some((line) => line.includes(`startup sweep: ${run.launchId}`)),
      `no report of the deferred sweep:\n${logs.join('\n')}`,
    );

    // A later resolution does not run it again.
    await runtime.context();
    await runtime.sweep();
    assert.equal(removals, 1);
  });
});
