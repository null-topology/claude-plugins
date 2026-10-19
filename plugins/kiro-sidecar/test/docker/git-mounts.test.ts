// The git mount of a docker launch, against the layouts git writes itself and
// against `.git` files that point somewhere else.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { buildDockerLaunch, resolveMountSet } from '../../src/docker/launch.ts';
import type { KiroHomeSources } from '../../src/docker/launch.ts';
import type { Environment } from '../../src/settings.ts';
import { buildSecretSet } from '../../src/text/redact.ts';
import { git, repoWithWorktree } from '../helpers/git.ts';
import { tempDir } from '../helpers/processes.ts';

const LAUNCH_ID = 'ks_0123456789ab';
const TOKEN = 'test-token-0123456789abcdef';
const ENV: Environment = { PATH: '/usr/bin:/bin', HOME: '/home/tester' };

let kiroBase = '';
let kiroHome: KiroHomeSources = { home: '', skills: '', steering: '' };

before(async () => {
  kiroBase = await realpath(await mkdtemp(join(tmpdir(), 'kiro-sidecar-test-')));
  kiroHome = {
    home: join(kiroBase, 'homes', 'default'),
    skills: join(kiroBase, 'runs', LAUNCH_ID, 'skills'),
    steering: join(kiroBase, 'runs', LAUNCH_ID, 'steering'),
  };
  for (const dir of Object.values(kiroHome)) {
    await mkdir(dir, { recursive: true });
  }
});

after(async () => {
  await rm(kiroBase, { recursive: true, force: true });
});

/** A `--mount` value: a bind mount at the source path. */
function bind(path: string, readOnly = false): string {
  return `type=bind,src=${path},dst=${path}${readOnly ? ',readonly' : ''}`;
}

/** The `--mount` values of a launch for `dir` that follow the three Kiro home mounts. */
async function setMounts(dir: string): Promise<string[]> {
  const launch = await buildDockerLaunch({
    launchId: LAUNCH_ID,
    mountSet: await resolveMountSet({ dir, stateDir: kiroBase }),
    user: '0:0',
    image: 'example/kiro:1.0',
    token: TOKEN,
    env: ENV,
    kiroHome,
    owner: {
      ownerKey: 'pid-4100-987654@test-host:boot-1:4026531836',
      driver: { pid: 4200, startTime: '987700', hostId: 'test-host:boot-1:4026531836' },
    },
    secrets: buildSecretSet({ apiKey: TOKEN, env: ENV }),
  });
  const values = launch.args.flatMap((arg, index) => (index > 0 && launch.args[index - 1] === '--mount' ? [arg] : []));
  return values.slice(3);
}

async function base(t: TestContext): Promise<string> {
  return realpath(await tempDir(t));
}

/** A repository at `path` with one commit. */
async function initRepo(path: string, home: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, home, 'init', '--quiet', '--initial-branch', 'main');
  await writeFile(join(path, 'README.md'), 'test repository\n');
  await git(path, home, 'add', 'README.md');
  await git(path, home, 'commit', '--quiet', '-m', 'initial commit');
}

describe('git mount: a .git file that points elsewhere', () => {
  test('mounts nothing beyond the work directory, whatever directory it names', async (t) => {
    const root = await base(t);
    const secret = join(root, 'secret-home', '.ssh');
    await mkdir(secret, { recursive: true });
    await writeFile(join(secret, 'id_test'), 'not a key\n');
    const notGit = join(root, 'notgit');
    await mkdir(notGit);
    const { main } = await repoWithWorktree(root);
    const feature = join(main, '.git', 'worktrees', 'feature');

    const cases: Array<[string, string, Record<string, string>]> = [
      ['absolute', `gitdir: ${secret}\n`, {}],
      ['relative', 'gitdir: ../secret-home/.ssh\n', {}],
      ['not-a-git-dir', `gitdir: ${notGit}\n`, {}],
      ['missing', `gitdir: ${join(root, 'missing')}\n`, {}],
      // A real worktree's git dir: its back-link names the real worktree, not this directory.
      ['foreign-worktree', `gitdir: ${feature}\n`, {}],
      // A worktree record made inside the directory itself, naming the secret as its common dir.
      [
        'self-made-worktree',
        'gitdir: meta/worktrees/w\n',
        { 'meta/worktrees/w/commondir': `${secret}\n`, 'meta/worktrees/w/gitdir': 'GITFILE\n' },
      ],
      // A submodule git dir made inside the directory: core.worktree names the directory back.
      ['self-made-submodule', 'gitdir: fake\n', { 'fake/config': '[core]\n\tworktree = ..\n' }],
    ];
    for (const [name, gitFile, files] of cases) {
      const dir = join(root, `hostile-${name}`);
      await mkdir(dir);
      await writeFile(join(dir, '.git'), gitFile);
      for (const [relative, content] of Object.entries(files)) {
        const path = join(dir, relative);
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, content.replace('GITFILE', join(dir, '.git')));
      }
      const mounts = await setMounts(dir);
      assert.deepEqual(mounts, [bind(dir)], name);
      assert.ok(mounts.every((value) => !value.includes('secret-home')), name);
    }
  });

  test('a .git that links to the git file of another checkout mounts nothing beyond the work directory', async (t) => {
    const root = await base(t);
    const { main, worktree, commonDir } = await repoWithWorktree(root);
    const library = join(root, 'library');
    await initRepo(library, root);
    await git(main, root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', library, 'sub');
    const worktreeGitFile = join(worktree, '.git');
    const submoduleGitFile = join(main, 'sub', '.git');
    // The checkouts themselves mount their git dirs: the links below point at working layouts.
    assert.deepEqual(await setMounts(worktree), [bind(worktree), bind(commonDir, true)]);

    const cases: Array<[string, string, (dotGit: string) => Promise<void>]> = [
      ['symlink-absolute', worktreeGitFile, (dotGit) => symlink(worktreeGitFile, dotGit)],
      ['symlink-relative', worktreeGitFile, (dotGit) => symlink('../feature/.git', dotGit)],
      ['hard-link', '', (dotGit) => link(worktreeGitFile, dotGit)],
      ['symlink-to-submodule', submoduleGitFile, (dotGit) => symlink(submoduleGitFile, dotGit)],
    ];
    for (const [name, target, makeLink] of cases) {
      const dir = join(root, `linked-${name}`);
      await mkdir(dir);
      const dotGit = join(dir, '.git');
      await makeLink(dotGit);
      // A hard link is the file itself; a symlink resolves to the git file it names.
      assert.equal(await realpath(dotGit), target === '' ? dotGit : target, name);
      assert.deepEqual(await setMounts(dir), [bind(dir)], name);
    }
  });
});

describe('git mount: layouts git writes', () => {
  test('a submodule mounts its git dir read-only', async (t) => {
    const root = await base(t);
    const library = join(root, 'library');
    const main = join(root, 'main');
    await initRepo(library, root);
    await initRepo(main, root);
    await git(main, root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', library, 'sub');
    const sub = join(main, 'sub');
    const gitDir = await realpath(await git(sub, root, 'rev-parse', '--path-format=absolute', '--git-dir'));
    assert.equal(gitDir, join(main, '.git', 'modules', 'sub'));
    assert.deepEqual(await setMounts(sub), [bind(sub), bind(gitDir, true)]);
  });

  test('a bare repository inside the work directory adds no mount, and its worktree mounts it', async (t) => {
    const root = await base(t);
    const source = join(root, 'source');
    await initRepo(source, root);
    const project = join(root, 'project');
    await mkdir(project);
    await git(root, root, 'clone', '--quiet', '--bare', source, join(project, '.bare'));
    // The "bare repository plus worktrees" convention: the top-level gitfile is written by hand.
    await writeFile(join(project, '.git'), 'gitdir: ./.bare\n');
    await git(project, root, 'worktree', 'add', '--quiet', 'feature');
    const feature = join(project, 'feature');
    const commonDir = await realpath(await git(feature, root, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    assert.equal(commonDir, join(project, '.bare'));

    assert.deepEqual(await setMounts(project), [bind(project)]);
    assert.deepEqual(await setMounts(feature), [bind(feature), bind(commonDir, true)]);
  });
});
