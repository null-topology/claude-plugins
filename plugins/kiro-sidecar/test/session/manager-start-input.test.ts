import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SidecarError } from '../../src/errors.ts';
import { readCall } from '../../src/store/runs.ts';
import { InvalidInputError } from '../../src/text/errors.ts';
import { PROCESS_TIMEOUT, managerFixture } from './manager-helpers.ts';

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

describe('SessionManager.start input checks', () => {
  test('skills and steering that are not lists of strings are refused', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const { manager, workspace, stateDir } = fixture;
    for (const field of ['skills', 'steering'] as const) {
      for (const value of ['lint', [1], null]) {
        await assert.rejects(
          manager.start({ dir: workspace.dir, [field]: value } as never, { toolUseId: 'toolu_not_a_list' }),
          (error) => assertCode(error, 'E_INVALID', `${field} must be an array of strings`),
          `${field}: ${JSON.stringify(value)}`,
        );
      }
    }
    assert.deepEqual(await runIds(stateDir), []);
    assert.equal(await readCall(stateDir, 'toolu_not_a_list'), undefined);
    await assert.rejects(workspace.started());
  });

  test('mounts and a read-only dir are refused in local mode, an empty list too', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const { manager, workspace, stateDir } = fixture;
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ dir: workspace.dir, mounts: [] }, 'mounts', 'mounts is available in docker mode only'],
      [{ dir: workspace.dir, mounts: [workspace.dir] }, 'mounts', 'mounts is available in docker mode only'],
      [{ dir: workspace.dir, mode: 'local', mounts: [workspace.dir] }, 'mounts', 'mounts is available in docker mode only'],
      [{ dir: `${workspace.dir}:ro` }, 'dir', 'dir with ":ro" is available in docker mode only'],
    ];
    for (const [params, field, fragment] of cases) {
      await assert.rejects(
        manager.start(params as never, { toolUseId: 'toolu_local_mounts' }),
        (error) => {
          assertCode(error, 'E_INVALID', fragment);
          assert.equal((error as InvalidInputError).field, field);
          return true;
        },
        JSON.stringify(params),
      );
    }
    assert.deepEqual(await runIds(stateDir), []);
    assert.equal(await readCall(stateDir, 'toolu_local_mounts'), undefined);
    await assert.rejects(workspace.started());
  });

  for (const proxy of ['http://127.0.0.1:10817', 'http://localhost:3128', 'http://[::1]:3128']) {
    test(`a loopback proxy setting (${proxy}) refuses a docker start before anything runs`, PROCESS_TIMEOUT, async (t) => {
      const fixture = await managerFixture(t, 'default', { settings: { proxy } });
      const { manager, workspace, stateDir } = fixture;
      await assert.rejects(
        manager.start({ dir: workspace.dir, mode: 'docker' }, { toolUseId: 'toolu_loopback_proxy' }),
        (error) => {
          assertCode(error, 'E_INVALID', 'proxy names a loopback host');
          assert.equal((error as InvalidInputError).field, 'proxy');
          assert.ok(!(error as Error).message.includes(proxy), 'the proxy value is never echoed');
          return true;
        },
      );
      assert.deepEqual(await runIds(stateDir), []);
      assert.equal(await readCall(stateDir, 'toolu_loopback_proxy'), undefined);
    });
  }

  test('a loopback proxy setting reaches a local Kiro in place of the inherited one', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default', {
      settings: { proxy: 'http://127.0.0.1:10817', no_proxy: '.internal.example' },
    });
    await fixture.manager.start({ dir: fixture.workspace.dir, mode: 'local' });
    const started = await fixture.workspace.started();
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
      assert.equal(started.env[name], 'http://127.0.0.1:10817', name);
    }
    assert.equal(started.env['NO_PROXY'], '.internal.example');
    assert.equal(started.env['no_proxy'], '.internal.example');
  });
});
