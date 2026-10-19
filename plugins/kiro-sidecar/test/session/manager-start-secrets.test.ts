import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROCESS_TIMEOUT, TEST_TOKEN, endedTurn, managerFixture, metaOf, testEnvironment } from './manager-helpers.ts';

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

describe('SessionManager.start secrets of the Kiro process', () => {
  for (const key of ['short_key_12', 'kiro_server_key_0123456789abcdef']) {
    test(`the server's own KIRO_API_KEY (${key.length} characters) never reaches Kiro and is redacted`, PROCESS_TIMEOUT, async (t) => {
      const fixture = await managerFixture(t, 'secret-echo', {
        settings: { api_key: TEST_TOKEN },
        env: testEnvironment({ KIRO_API_KEY: key }),
      });
      const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: `echo ${key}` });
      assert.equal((await fixture.workspace.started()).env['KIRO_API_KEY'], TEST_TOKEN);
      const result = await endedTurn(fixture, launchId, 1);
      assert.equal(result.outcome, 'end_turn');
      assert.deepEqual(result.messages, ['Is the token [REDACTED] right?']);
      const prompt = (await fixture.workspace.received()).find((message) => 'method' in message && message.method === 'session/prompt');
      assert.ok(JSON.stringify(prompt).includes(key), 'the prompt reached Kiro unchanged');
      assert.equal((await metaOf(fixture.stateDir, launchId)).firstPromptPreview, 'echo [REDACTED]');
      const runDir = join(fixture.stateDir, 'runs', launchId);
      const files = await filesUnder(runDir);
      for (const [path, text] of files) {
        assert.equal(text.includes(key), false, `${path} holds the server key`);
        assert.equal(text.includes(TEST_TOKEN), false, `${path} holds the token`);
      }
      const turnText = files.get(join(runDir, 'turns', '1.md'));
      assert.ok(turnText?.includes('The token is [REDACTED].'), turnText);
      const stderr = files.get(join(runDir, 'stderr.log'));
      assert.ok(stderr?.includes('fixture: token [REDACTED]'), stderr);
    });
  }
});
