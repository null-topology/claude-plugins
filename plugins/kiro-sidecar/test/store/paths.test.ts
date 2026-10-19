import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, realpath, stat, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isValidHomeName } from '../../src/home-name.ts';
import {
  DEFAULT_HOME,
  callPath,
  encodeHomeKey,
  homePaths,
  isHomeDirName,
  isLaunchId,
  isValidToolUseId,
  newLaunchId,
  resolveHomeName,
  resolveStateDir,
  runPaths,
  turnPaths,
} from '../../src/store/paths.ts';
import { tempDir } from '../helpers/processes.ts';

describe('state directory', () => {
  test('CLAUDE_PLUGIN_DATA wins over XDG_STATE_HOME and HOME', () => {
    assert.equal(
      resolveStateDir({
        CLAUDE_PLUGIN_DATA: '/data/plugin',
        XDG_STATE_HOME: '/xdg/state',
        HOME: '/home/user',
      }),
      '/data/plugin',
    );
  });

  test('XDG_STATE_HOME is used when CLAUDE_PLUGIN_DATA is unset or empty', () => {
    assert.equal(
      resolveStateDir({ XDG_STATE_HOME: '/xdg/state', HOME: '/home/user' }),
      '/xdg/state/kiro-sidecar',
    );
    assert.equal(
      resolveStateDir({ CLAUDE_PLUGIN_DATA: '', XDG_STATE_HOME: '/xdg/state', HOME: '/home/user' }),
      '/xdg/state/kiro-sidecar',
    );
  });

  test('HOME is the fallback, and a relative XDG_STATE_HOME is ignored', () => {
    assert.equal(resolveStateDir({ HOME: '/home/user' }), '/home/user/.local/state/kiro-sidecar');
    assert.equal(
      resolveStateDir({ XDG_STATE_HOME: 'relative/state', HOME: '/home/user' }),
      '/home/user/.local/state/kiro-sidecar',
    );
    assert.equal(resolveStateDir({}), join(homedir(), '.local', 'state', 'kiro-sidecar'));
  });
});

describe('homes', () => {
  test('the home key encodes the path readably and adds 8 hex digits of its sha256', () => {
    // sha256("/work/app") begins with 70467eff.
    assert.equal(encodeHomeKey('/work/app'), '-work-app-70467eff');
    assert.match(encodeHomeKey('/srv/my project/x.y_z'), /^-srv-my-project-x-y-z-[0-9a-f]{8}$/);
    assert.notEqual(encodeHomeKey('/a-b'), encodeHomeKey('/a/b'));
  });

  test('a path whose encoding fits keeps the key it always had', () => {
    // 246 encoded characters, the longest readable part: a 255-byte key.
    const path = `/srv/${'n'.repeat(241)}`;
    assert.equal(encodeHomeKey(path), `-srv-${'n'.repeat(241)}-e81f6e56`);
    assert.equal(encodeHomeKey(path).length, 255);
  });

  test('a long path gives a key that fits one path segment and can be created', async (t) => {
    const root = await tempDir(t);
    const paths = [
      `${'/home/dev/'.padEnd(389, 'x')}/my-project`,
      `${'/home/dev/caf\u{e9}-\u{1F600}'.repeat(30)}/my-project`,
    ];
    for (const path of paths) {
      assert.ok(path.length >= 400, `${path.length}`);
      const key = encodeHomeKey(path);
      const digest = createHash('sha256').update(path).digest('hex').slice(0, 8);
      assert.ok(Buffer.byteLength(key) <= 255, `${Buffer.byteLength(key)}`);
      assert.ok(isHomeDirName(key));
      // The key keeps the end of the encoded path and the digest of the full path.
      assert.equal(key, `${path.replace(/[^A-Za-z0-9]/g, '-').slice(-246)}-${digest}`);
      assert.ok(key.endsWith(`-my-project-${digest}`));
      // The uncapped encoding of the same path is too long for one segment.
      const uncapped = `${path.replace(/[^A-Za-z0-9]/g, '-')}-${digest}`;
      await assert.rejects(mkdir(join(root, 'homes', uncapped), { recursive: true }), { code: 'ENAMETOOLONG' });
      const { dir } = homePaths(root, key);
      await mkdir(dir, { recursive: true });
      assert.ok((await stat(dir)).isDirectory());
    }
  });

  test('long paths that differ only at the start get different keys', () => {
    const tail = `/${'shared-tail/'.repeat(30)}app`;
    const first = encodeHomeKey(`/a${tail}`);
    const second = encodeHomeKey(`/b${tail}`);
    assert.equal(first.slice(0, -8), second.slice(0, -8), 'the readable parts are the same tail');
    assert.notEqual(first, second);
  });

  test('a home key longer than one path segment is not a home directory name', () => {
    assert.ok(isHomeDirName(`-${'k'.repeat(245)}-0123abcd`));
    assert.equal(isHomeDirName(`-${'k'.repeat(246)}-0123abcd`), false);
    assert.throws(() => homePaths('/state', `-${'k'.repeat(246)}-0123abcd`), TypeError);
  });

  test('the startup directory is resolved with realpath before encoding', async (t) => {
    const root = await realpath(await tempDir(t));
    const real = join(root, 'project');
    const link = join(root, 'link');
    await mkdir(real);
    await symlink(real, link);
    const viaLink = await resolveHomeName({ projectDir: link });
    assert.equal(viaLink, await resolveHomeName({ projectDir: real }));
    assert.equal(viaLink, encodeHomeKey(real));
  });

  test('without a startup directory the home is default', async () => {
    assert.equal(DEFAULT_HOME, 'default');
    assert.equal(await resolveHomeName({}), 'default');
    assert.equal(await resolveHomeName({ projectDir: '' }), 'default');
    assert.equal(homePaths('/state', 'default').dir, '/state/homes/default');
  });

  test('a valid override wins over the startup directory', async (t) => {
    const root = await realpath(await tempDir(t));
    assert.equal(await resolveHomeName({ override: 'team.alpha_1-b', projectDir: root }), 'team.alpha_1-b');
    assert.equal(await resolveHomeName({ override: '...' }), '...');
    assert.equal(await resolveHomeName({ override: '', projectDir: root }), encodeHomeKey(root));
  });

  for (const name of ['.', '..', 'a/b', 'has space', '', 'x'.repeat(65), '../escape']) {
    test(`home name ${JSON.stringify(name)} is rejected by the store`, async () => {
      assert.equal(isValidHomeName(name), false);
      if (name !== '') {
        await assert.rejects(resolveHomeName({ override: name }), TypeError);
      }
      assert.throws(() => homePaths('/state', name), TypeError);
    });
  }

  test('home paths hold empty skills and steering mount targets', () => {
    assert.deepEqual(homePaths('/state', '-work-app-70467eff'), {
      dir: '/state/homes/-work-app-70467eff',
      skills: '/state/homes/-work-app-70467eff/skills',
      steering: '/state/homes/-work-app-70467eff/steering',
    });
  });
});

describe('ids', () => {
  test('a launch id is ks_ and 12 hex digits, and ids do not repeat', () => {
    const ids = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      const id = newLaunchId();
      assert.match(id, /^ks_[0-9a-f]{12}$/);
      assert.ok(isLaunchId(id));
      ids.add(id);
    }
    assert.equal(ids.size, 1000);
  });

  test('a malformed launch id names no path', () => {
    for (const id of ['ks_123', 'ks_0123456789ab/..', '../ks_0123456789ab', 'KS_0123456789ab', 'ks_0123456789AB']) {
      assert.equal(isLaunchId(id), false, id);
      assert.throws(() => runPaths('/state', id), TypeError);
    }
  });

  const validToolUseIds = ['toolu_01AbC-xyz', 'a', 'x'.repeat(128), 'A_b-9'];
  const invalidToolUseIds = ['', 'x'.repeat(129), '../x', 'a.b', 'a b', 'a/b', 'é'];

  for (const id of validToolUseIds) {
    test(`tool use id ${JSON.stringify(id.slice(0, 20))} (length ${id.length}) is valid`, () => {
      assert.ok(isValidToolUseId(id));
      assert.equal(callPath('/state', id), `/state/calls/${id}.json`);
    });
  }

  for (const id of invalidToolUseIds) {
    test(`tool use id ${JSON.stringify(id.slice(0, 20))} (length ${id.length}) is invalid`, () => {
      assert.equal(isValidToolUseId(id), false);
      assert.throws(() => callPath('/state', id), TypeError);
    });
  }
});

describe('run paths', () => {
  test('the files of a run sit in runs/<launchId>/', () => {
    assert.deepEqual(runPaths('/state', 'ks_0123456789ab'), {
      dir: '/state/runs/ks_0123456789ab',
      meta: '/state/runs/ks_0123456789ab/meta.json',
      lock: '/state/runs/ks_0123456789ab/lock',
      claudeSessions: '/state/runs/ks_0123456789ab/claude-sessions.jsonl',
      acpLog: '/state/runs/ks_0123456789ab/acp.jsonl',
      stderrLog: '/state/runs/ks_0123456789ab/stderr.log',
      turns: '/state/runs/ks_0123456789ab/turns',
      skills: '/state/runs/ks_0123456789ab/skills',
      steering: '/state/runs/ks_0123456789ab/steering',
      task: '/state/runs/ks_0123456789ab/task.md',
    });
  });

  test('the files of a turn are named after its number', () => {
    const turns = '/state/runs/ks_0123456789ab/turns';
    assert.deepEqual(turnPaths('/state', 'ks_0123456789ab', 3), {
      result: `${turns}/3.json`,
      text: `${turns}/3.md`,
      partial: `${turns}/3.md.part`,
      armed: `${turns}/3.armed`,
      claimed: `${turns}/3.claimed`,
      returned: `${turns}/3.returned`,
      pushed: `${turns}/3.pushed`,
    });
  });

  test('a turn number is a positive integer', () => {
    for (const turn of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => turnPaths('/state', 'ks_0123456789ab', turn), TypeError, String(turn));
    }
  });
});
