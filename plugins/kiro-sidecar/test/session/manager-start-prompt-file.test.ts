import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, readdir, readFile, stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SidecarError } from '../../src/errors.ts';
import { readCall } from '../../src/store/runs.ts';
import { InvalidInputError } from '../../src/text/errors.ts';
import { PROMPT_FILE_MAX_BYTES } from '../../src/text/limits.ts';
import { tempDir } from '../helpers/processes.ts';
import { PROCESS_TIMEOUT, TEST_TOKEN, endedTurn, managerFixture, metaOf } from './manager-helpers.ts';
import type { ManagerFixture } from './manager-helpers.ts';

const run = promisify(execFile);

function assertInvalid(error: unknown, fragment: string): boolean {
  assert.ok(error instanceof SidecarError || error instanceof InvalidInputError, `unexpected ${String(error)}`);
  assert.equal(error.code, 'E_INVALID', error.message);
  assert.ok(error.message.startsWith('prompt_file '), error.message);
  assert.ok(error.message.includes(fragment), error.message);
  return true;
}

async function runIds(stateDir: string): Promise<string[]> {
  try {
    return await readdir(join(stateDir, 'runs'));
  } catch {
    return [];
  }
}

/** The text of the first `session/prompt` the fake received, once turn 1 has ended. */
async function promptText(fixture: ManagerFixture, launchId: string): Promise<string> {
  await endedTurn(fixture, launchId, 1);
  const message = (await fixture.workspace.received()).find((entry) => 'method' in entry && entry.method === 'session/prompt');
  assert.ok(message !== undefined, 'no session/prompt was sent');
  const blocks = (message as { params: { prompt: Array<{ type: string; text: string }> } }).params.prompt;
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.type, 'text');
  return blocks[0]?.text ?? '';
}

describe('SessionManager.start with prompt_file', () => {
  test('a prompt_file that breaks a rule is refused before anything is created', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const { manager, workspace, stateDir } = fixture;
    const base = await tempDir(t);
    const valid = join(base, 'task.md');
    await writeFile(valid, 'Fix the parser.\n');
    const empty = join(base, 'empty.md');
    await writeFile(empty, '');
    const large = join(base, 'large.md');
    await writeFile(large, '');
    await truncate(large, PROMPT_FILE_MAX_BYTES + 1);
    const fifo = join(base, 'task.fifo');
    await run('mkfifo', [fifo]);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ prompt: 'Fix it.', prompt_file: valid }, 'cannot be given together with prompt'],
      [{ prompt_file: '' }, 'must not be empty'],
      [{ prompt_file: 'task.md' }, 'must be an absolute path'],
      [{ prompt_file: join(base, 'missing.md') }, 'does not exist'],
      [{ prompt_file: join(valid, 'below-a-file.md') }, 'does not exist'],
      [{ prompt_file: base }, 'must be a regular file'],
      [{ prompt_file: fifo }, 'must be a regular file'],
      [{ prompt_file: empty }, 'must not be an empty file'],
      [{ prompt_file: large }, `must be at most ${PROMPT_FILE_MAX_BYTES} bytes`],
    ];
    for (const [params, fragment] of cases) {
      await assert.rejects(
        manager.start({ dir: workspace.dir, ...params } as never, { toolUseId: 'toolu_prompt_file' }),
        (error) => assertInvalid(error, fragment),
        JSON.stringify(params),
      );
    }
    assert.deepEqual(await runIds(stateDir), []);
    assert.equal(await readCall(stateDir, 'toolu_prompt_file'), undefined);
    await assert.rejects(workspace.started());
  });

  test(
    'a prompt_file that cannot be read is refused',
    { ...PROCESS_TIMEOUT, skip: process.getuid?.() === 0 ? 'root reads every file' : false },
    async (t) => {
      const fixture = await managerFixture(t, 'default');
      const path = join(await tempDir(t), 'locked.md');
      await writeFile(path, 'Fix the parser.\n');
      await chmod(path, 0o000);
      await assert.rejects(fixture.manager.start({ dir: fixture.workspace.dir, prompt_file: path }), (error) =>
        assertInvalid(error, 'cannot be read (EACCES)'),
      );
      assert.deepEqual(await runIds(fixture.stateDir), []);
    },
  );

  test('local mode sends the content as the prompt and copies it to task.md', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const path = join(await tempDir(t), 'task.md');
    const content = `Fix the parser.\n\n${'Keep the public API. '.repeat(20)}\n`;
    await writeFile(path, content);
    const result = await fixture.manager.start({ dir: fixture.workspace.dir, prompt_file: path });
    assert.equal(result.turn, 1);
    assert.equal(await promptText(fixture, result.launchId), content);
    const copy = join(fixture.stateDir, 'runs', result.launchId, 'task.md');
    assert.equal(await readFile(copy, 'utf8'), content);
    assert.equal((await stat(copy)).mode & 0o777, 0o600);
    const meta = await metaOf(fixture.stateDir, result.launchId);
    assert.equal(meta.firstPromptPreview, content.slice(0, 200));
  });

  test('the copy is the content read at start: a later change of the file does not reach it', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const path = join(await tempDir(t), 'task.md');
    await writeFile(path, 'Fix the parser.\n');
    const result = await fixture.manager.start({ dir: fixture.workspace.dir, prompt_file: path });
    await writeFile(path, 'Something else.\n');
    assert.equal(await readFile(join(fixture.stateDir, 'runs', result.launchId, 'task.md'), 'utf8'), 'Fix the parser.\n');
  });

  test('a token in the file is redacted in the preview, while Kiro and task.md get the content unchanged', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default', { settings: { api_key: TEST_TOKEN } });
    const path = join(await tempDir(t), 'task.md');
    const content = `Use the token ${TEST_TOKEN} for the call.\n`;
    await writeFile(path, content);
    const result = await fixture.manager.start({ dir: fixture.workspace.dir, prompt_file: path });
    assert.equal(await promptText(fixture, result.launchId), content);
    const meta = await metaOf(fixture.stateDir, result.launchId);
    assert.equal(meta.firstPromptPreview, 'Use the token [REDACTED] for the call.\n');
    assert.equal(await readFile(join(fixture.stateDir, 'runs', result.launchId, 'task.md'), 'utf8'), content);
  });

  test('without prompt_file a run has no task.md', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const result = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: 'Fix the parser.' });
    await assert.rejects(stat(join(fixture.stateDir, 'runs', result.launchId, 'task.md')), { code: 'ENOENT' });
  });
});
