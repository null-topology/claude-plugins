import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SidecarError } from '../../src/errors.ts';
import type { StartParams } from '../../src/session/manager.ts';
import { readCall } from '../../src/store/runs.ts';
import { PROCESS_TIMEOUT, TEST_TOKEN, isAlive, managerFixture, metaOf } from './manager-helpers.ts';

/** The text of every file under `dir`, recursively. */
async function filesUnder(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files.set(path, await readFile(path, 'utf8'));
    }
  }
  return files;
}

interface HostileCase {
  readonly scenario: string;
  readonly what: string;
  readonly params: Omit<StartParams, 'dir'>;
  readonly code: string;
  readonly fragment: string;
}

const CASES: readonly HostileCase[] = [
  {
    scenario: 'secret-session-id',
    what: 'a session id holding the key',
    params: { prompt: 'hello' },
    code: 'E_STEP_SESSION_NEW',
    fragment: 'Kiro returned a session id holding a secret',
  },
  {
    scenario: 'secret-model-value',
    what: 'the key as the current model',
    params: {},
    code: 'E_STEP_MODEL',
    fragment: 'Kiro returned a model value holding a secret',
  },
  {
    scenario: 'secret-model-offered',
    what: 'the key among the offered models',
    params: { model: 'not-offered-model' },
    code: 'E_INVALID',
    fragment: 'is not offered by Kiro',
  },
  {
    scenario: 'secret-config-error',
    what: 'an error text holding the key',
    params: { model: 'auto', prompt: 'hello' },
    code: 'E_STEP_MODEL',
    fragment: 'start step model failed',
  },
];

describe('SessionManager.start with protocol values that hold the key', () => {
  for (const hostile of CASES) {
    test(`Kiro returning ${hostile.what} fails the start and leaves no key in the state directory`, PROCESS_TIMEOUT, async (t) => {
      const fixture = await managerFixture(t, hostile.scenario, { settings: { api_key: TEST_TOKEN } });
      const toolUseId = `toolu_${hostile.scenario.replaceAll('-', '_')}`;
      const start = fixture.manager.start({ dir: fixture.workspace.dir, ...hostile.params }, { toolUseId });
      await assert.rejects(start, (error) => {
        assert.ok(error instanceof SidecarError, `unexpected ${String(error)}`);
        assert.equal(error.code, hostile.code, error.message);
        assert.ok(error.message.includes(hostile.fragment), error.message);
        assert.equal(error.message.includes(TEST_TOKEN), false, error.message);
        return true;
      });
      await fixture.manager.settled();
      const { env, pid } = await fixture.workspace.started();
      assert.equal(env['KIRO_API_KEY'], TEST_TOKEN, 'Kiro got the key');
      assert.equal(isAlive(pid), false, 'the Kiro process is gone');

      const [launchId] = await readdir(join(fixture.stateDir, 'runs'));
      assert.ok(launchId !== undefined);
      assert.equal((await metaOf(fixture.stateDir, launchId)).state, 'failed');
      const record = (await readCall(fixture.stateDir, toolUseId)) as { failed?: boolean } | undefined;
      assert.equal(record?.failed, true, JSON.stringify(record));
      const files = await filesUnder(fixture.stateDir);
      assert.ok(files.size > 0);
      for (const [path, text] of files) {
        assert.equal(text.includes(TEST_TOKEN), false, `${path} holds the key: ${text}`);
      }
    });
  }
});
