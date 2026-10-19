import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { SidecarError } from '../../src/errors.ts';
import { readCall } from '../../src/store/runs.ts';
import { InvalidInputError } from '../../src/text/errors.ts';
import { PROCESS_TIMEOUT, TEST_TOKEN, managerFixture } from './manager-helpers.ts';

function assertCode(error: unknown, code: string, fragment?: string): boolean {
  assert.ok(error instanceof SidecarError || error instanceof InvalidInputError, `unexpected ${String(error)}`);
  assert.equal(error.code, code, error.message);
  if (fragment !== undefined) {
    assert.ok(error.message.includes(fragment), error.message);
  }
  return true;
}

async function runIds(stateDir: string): Promise<string[]> {
  try {
    return await readdir(join(stateDir, 'runs'));
  } catch {
    return [];
  }
}

describe('SessionManager.start work directory', () => {
  test('a local work directory may hold characters the docker mount syntax refuses', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const dir = join(fixture.workspace.dir, 'with,comma "and quote"');
    await mkdir(dir);
    // The fake reads its scenario from its working directory.
    await copyFile(join(fixture.workspace.dir, 'fake-scenario.json'), join(dir, 'fake-scenario.json'));
    const result = await fixture.manager.start({ dir });
    assert.equal(result.dir, await realpath(dir));
    const started = JSON.parse(await readFile(join(dir, 'fake-start.json'), 'utf8')) as { cwd: string };
    assert.equal(started.cwd, await realpath(dir));
  });

  test('a local work directory is still absolute, existing and a directory', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const { manager, workspace, stateDir } = fixture;
    const cases: Array<[string, string]> = [
      ['relative,path', 'dir must be an absolute path'],
      [join(workspace.dir, 'missing,dir'), 'dir does not exist'],
      [join(workspace.dir, 'fake-scenario.json'), 'dir must be a directory'],
      ['/', 'dir must not be the root directory'],
    ];
    for (const [dir, fragment] of cases) {
      await assert.rejects(manager.start({ dir }), (error) => assertCode(error, 'E_INVALID', fragment), dir);
    }
    assert.deepEqual(await runIds(stateDir), []);
  });

  test('a docker work directory with a comma is refused before anything is created', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default', {
      settings: { api_key: TEST_TOKEN },
      deps: {
        resolveDockerUser: async () => '0:0',
        checkImage: async () => {},
      },
    });
    const dir = join(fixture.workspace.dir, 'with,comma');
    await mkdir(dir);
    for (const given of [dir, join(dir, '..', 'missing,dir')]) {
      await assert.rejects(fixture.manager.start({ dir: given, mode: 'docker' }, { toolUseId: 'toolu_comma' }), (error) =>
        assertCode(error, 'E_INVALID', 'dir must not contain a comma'),
      );
    }
    assert.deepEqual(await runIds(fixture.stateDir), []);
    assert.equal(await readCall(fixture.stateDir, 'toolu_comma'), undefined);
  });
});
