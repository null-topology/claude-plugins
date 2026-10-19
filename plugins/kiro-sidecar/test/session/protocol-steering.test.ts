import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, watch } from 'node:fs';
import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnProcess } from '../../src/acp/process.ts';
import type { ProcessSpec } from '../../src/acp/process.ts';
import { SidecarError } from '../../src/errors.ts';
import { PROTOCOL_STEERING, PROTOCOL_STEERING_FILE, writeProtocolSteering } from '../../src/session/protocol-steering.ts';
import { readCall } from '../../src/store/runs.ts';
import { tempDir } from '../helpers/processes.ts';
import { PROCESS_TIMEOUT, managerFixture, metaOf } from './manager-helpers.ts';
import type { ManagerFixture } from './manager-helpers.ts';

/** A copy of the steering file as the design fixes it: front matter, then the section 10 text. */
const EXPECTED = [
  '---',
  'inclusion: always',
  '---',
  '',
  'You are driven by another agent, a Claude session, through the kiro-sidecar plugin. You talk to it',
  'with two tools, sidecar::send_message and sidecar::complete_task. They are deferred: load them with',
  'tool_load before the first call.',
  '- send_message {text}: tell the driver something, or ask it a question. It is delivered when your',
  '  turn ends. To ask, call send_message with the question and then end your turn; the answer comes',
  '  as your next prompt. Never end a turn waiting for an answer without calling send_message.',
  '- complete_task {result}: call it once, when the whole task you were given is finished, with a',
  '  short result; put a long report in a file and name the file in the result. Then end your turn:',
  '  the session ends after it. Do not call send_message after complete_task.',
  '',
].join('\n');

/** An old time, so a rewrite shows in the mtime whatever the clock's resolution. */
const LONG_AGO = new Date('2001-01-01T00:00:00Z');

async function identityOf(path: string): Promise<{ ino: number; mtimeMs: number }> {
  const { ino, mtimeMs } = await stat(path);
  return { ino, mtimeMs };
}

describe('the protocol steering file', () => {
  test('is the front matter that applies it always, then the design text, byte for byte', () => {
    assert.equal(PROTOCOL_STEERING_FILE, 'sidecar-protocol.md');
    assert.equal(PROTOCOL_STEERING, EXPECTED);
  });

  test('is written into an empty steering directory as a 0600 file, with no temp file left', async (t) => {
    const dir = await tempDir(t);
    await writeProtocolSteering(dir);
    const path = join(dir, PROTOCOL_STEERING_FILE);
    assert.equal(await readFile(path, 'utf8'), PROTOCOL_STEERING);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(dir), [PROTOCOL_STEERING_FILE]);
  });

  test('goes through a temp file whose name does not end in .md and is renamed over the file', async (t) => {
    const dir = await tempDir(t);
    const names: string[] = [];
    const watcher = watch(dir, (_event, name) => {
      if (name !== null) {
        names.push(name);
      }
    });
    t.after(() => watcher.close());
    await writeFile(join(dir, PROTOCOL_STEERING_FILE), 'an older text\n');
    await writeProtocolSteering(dir);
    // The watcher reports asynchronously: wait until the temp file has been seen.
    const temp = /^\.sidecar-protocol\.md\.[0-9a-f]{12}\.tmp$/;
    const deadline = Date.now() + 5_000;
    while (!names.some((name) => temp.test(name)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(names.some((name) => temp.test(name)), `no temp file seen: ${JSON.stringify(names)}`);
    assert.deepEqual(
      names.filter((name) => name.endsWith('.md') && name !== PROTOCOL_STEERING_FILE),
      [],
    );
    assert.equal(await readFile(join(dir, PROTOCOL_STEERING_FILE), 'utf8'), PROTOCOL_STEERING);
    assert.deepEqual(await readdir(dir), [PROTOCOL_STEERING_FILE]);
  });

  test('an identical file is not rewritten', async (t) => {
    const dir = await tempDir(t);
    const path = join(dir, PROTOCOL_STEERING_FILE);
    await writeProtocolSteering(dir);
    await utimes(path, LONG_AGO, LONG_AGO);
    const before = await identityOf(path);
    await writeProtocolSteering(dir);
    assert.deepEqual(await identityOf(path), before);
    assert.deepEqual(await readdir(dir), [PROTOCOL_STEERING_FILE]);
  });

  for (const [what, text] of [
    ['an older text', 'an older text\n'],
    ['no text', ''],
    ['the text without its front matter', PROTOCOL_STEERING.slice(PROTOCOL_STEERING.indexOf('You are'))],
  ] as const) {
    test(`a file holding ${what} is replaced`, async (t) => {
      const dir = await tempDir(t);
      const path = join(dir, PROTOCOL_STEERING_FILE);
      await writeFile(path, text);
      await utimes(path, LONG_AGO, LONG_AGO);
      const before = await identityOf(path);
      await writeProtocolSteering(dir);
      assert.equal(await readFile(path, 'utf8'), PROTOCOL_STEERING);
      assert.notEqual((await identityOf(path)).ino, before.ino);
      assert.deepEqual(await readdir(dir), [PROTOCOL_STEERING_FILE]);
    });
  }

  test('a directory in the file\'s place fails the write and is left as it is', async (t) => {
    const dir = await tempDir(t);
    await mkdir(join(dir, PROTOCOL_STEERING_FILE, 'child'), { recursive: true });
    await assert.rejects(writeProtocolSteering(dir), (error: NodeJS.ErrnoException) => error.code === 'EISDIR');
    assert.deepEqual(await readdir(dir), [PROTOCOL_STEERING_FILE]);
    assert.deepEqual(await readdir(join(dir, PROTOCOL_STEERING_FILE)), ['child']);
  });
});

/** A local-mode manager whose spawns are seen by `atSpawn` before the fake agent starts. */
async function localFixture(t: Parameters<typeof managerFixture>[0], atSpawn: (spec: ProcessSpec) => void): Promise<ManagerFixture> {
  return managerFixture(t, 'default', {
    deps: {
      spawn: (spec, options) => {
        atSpawn(spec);
        return spawnProcess(spec, options);
      },
    },
  });
}

describe('SessionManager.start writes the protocol steering in local mode', () => {
  test('into the home steering before the spawn; a differing file is replaced, an identical one kept', PROCESS_TIMEOUT, async (t) => {
    const seen: string[] = [];
    const fixture = await localFixture(t, (spec) => {
      const home = spec.env?.['KIRO_HOME'] ?? '';
      seen.push(readFileSync(join(home, 'steering', PROTOCOL_STEERING_FILE), 'utf8'));
    });
    const steering = join(fixture.stateDir, 'homes', 'default', 'steering');
    const path = join(steering, PROTOCOL_STEERING_FILE);
    await mkdir(steering, { recursive: true });
    await writeFile(path, 'an older text\n');
    const planted = await identityOf(path);

    await fixture.manager.start({ dir: fixture.workspace.dir });
    assert.deepEqual(seen, [PROTOCOL_STEERING]);
    assert.notEqual((await identityOf(path)).ino, planted.ino);
    assert.deepEqual(await readdir(steering), [PROTOCOL_STEERING_FILE]);

    await utimes(path, LONG_AGO, LONG_AGO);
    const written = await identityOf(path);
    await fixture.manager.start({ dir: fixture.workspace.dir });
    assert.deepEqual(seen, [PROTOCOL_STEERING, PROTOCOL_STEERING]);
    assert.deepEqual(await identityOf(path), written);
    assert.deepEqual(await readdir(steering), [PROTOCOL_STEERING_FILE]);
  });

  test('a protocol steering that cannot be written fails the start at the spawn step, before any process', PROCESS_TIMEOUT, async (t) => {
    const specs: ProcessSpec[] = [];
    const fixture = await localFixture(t, (spec) => specs.push(spec));
    const blocker = join(fixture.stateDir, 'homes', 'default', 'steering', PROTOCOL_STEERING_FILE);
    await mkdir(blocker, { recursive: true });
    const toolUseId = 'toolu_steering_unwritable_local';
    await assert.rejects(fixture.manager.start({ dir: fixture.workspace.dir }, { toolUseId }), (error: unknown) => {
      assert.ok(error instanceof SidecarError, String(error));
      assert.equal(error.code, 'E_STEP_SPAWN', error.message);
      assert.match(error.message, /^start step spawn failed/);
      return true;
    });
    assert.deepEqual(specs, []);
    assert.deepEqual(fixture.spawned, []);
    const ids = await readdir(join(fixture.stateDir, 'runs'));
    assert.equal(ids.length, 1);
    assert.equal((await metaOf(fixture.stateDir, ids[0] as string)).state, 'failed');
    const record = (await readCall(fixture.stateDir, toolUseId)) as { failed?: boolean } | undefined;
    assert.equal(record?.failed, true, JSON.stringify(record));
    assert.deepEqual(await readdir(blocker), []);
    assert.deepEqual(fixture.errors, []);
  });
});
