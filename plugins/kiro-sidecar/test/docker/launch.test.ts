import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import {
  buildDockerLaunch as buildFromSet,
  containerName,
  coreWorktree,
  gitCommonDir,
  resolveMountSet,
} from '../../src/docker/launch.ts';
import { parseMountSpec } from '../../src/docker/mounts.ts';
import type {
  ContainerOwner,
  DockerLaunch,
  DockerLaunchOptions,
  KiroHomeSources,
  MountRequest,
} from '../../src/docker/launch.ts';
import { PROXY_VARIABLES } from '../../src/settings.ts';
import type { Environment } from '../../src/settings.ts';
import { buildSecretSet } from '../../src/text/redact.ts';
import { git, repoWithWorktree } from '../helpers/git.ts';
import { tempDir } from '../helpers/processes.ts';

const LAUNCH_ID = 'ks_0123456789ab';
const TOKEN = 'test-token-0123456789abcdef';
const IMAGE = 'example/kiro:1.0';
const USER = '0:0';
const BASE_ENV: Environment = { PATH: '/usr/bin:/bin', HOME: '/home/tester' };
const OWNER: ContainerOwner = {
  ownerKey: 'pid-4100-987654@test-host:boot-1:4026531836',
  driver: { pid: 4200, startTime: '987700', hostId: 'test-host:boot-1:4026531836' },
};
/** The `--label` values of every launch here, in order. */
const EXPECTED_LABELS: readonly string[] = [
  'kiro-sidecar.launch=ks_0123456789ab',
  'kiro-sidecar.owner=pid-4100-987654@test-host:boot-1:4026531836',
  'kiro-sidecar.driver-pid=4200',
  'kiro-sidecar.driver-start=987700',
  'kiro-sidecar.host=test-host:boot-1:4026531836',
];

/** The Kiro home sources every launch here gets: resolved, existing directories. */
let kiroBase = '';
let KIRO_HOME: KiroHomeSources = { home: '', skills: '', steering: '' };

before(async () => {
  kiroBase = await realpath(await mkdtemp(join(tmpdir(), 'kiro-sidecar-test-')));
  KIRO_HOME = {
    home: join(kiroBase, 'homes', 'default'),
    skills: join(kiroBase, 'runs', LAUNCH_ID, 'skills'),
    steering: join(kiroBase, 'runs', LAUNCH_ID, 'steering'),
  };
  for (const dir of Object.values(KIRO_HOME)) {
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

/** The `--mount` values of the Kiro home mounts, in order. */
function kiroBinds(sources: KiroHomeSources = KIRO_HOME): string[] {
  return [
    `type=bind,src=${sources.home},dst=/home/agent/.kiro`,
    `type=bind,src=${sources.skills},dst=/home/agent/.kiro/skills,readonly`,
    `type=bind,src=${sources.steering},dst=/home/agent/.kiro/steering,readonly`,
  ];
}

/**
 * The exact `docker run` arguments for a work directory, the proxy names
 * passed and the `--mount` values after the Kiro home mounts.
 */
function expectedArgs(dir: string, proxyNames: readonly string[] = [], mounts: readonly string[] = [bind(dir)]): string[] {
  return [
    'run',
    '--rm',
    '-i',
    '--pull',
    'never',
    '--name',
    'kiro-sidecar-0123456789ab',
    ...EXPECTED_LABELS.flatMap((label) => ['--label', label]),
    '--user',
    USER,
    '-e',
    'HOME=/home/agent',
    '-e',
    'KIRO_API_KEY',
    '-e',
    'GIT_CONFIG_COUNT=1',
    '-e',
    'GIT_CONFIG_KEY_0=safe.directory',
    '-e',
    'GIT_CONFIG_VALUE_0=*',
    '-e',
    'GIT_OPTIONAL_LOCKS=0',
    ...proxyNames.flatMap((name) => ['-e', name]),
    ...[...kiroBinds(), ...mounts].flatMap((value) => ['--mount', value]),
    '-w',
    dir,
    '--entrypoint',
    'kiro-cli',
    IMAGE,
    'acp',
    '--agent-engine',
    'v3',
  ];
}

/** Launch options as a test gives them: the mount request in place of the resolved set. */
type TestLaunchOptions = Omit<DockerLaunchOptions, 'mountSet'> & MountRequest;

/** Resolves the mount set of `options`, then builds the launch from that set, as a start does. */
async function buildDockerLaunch(options: TestLaunchOptions): Promise<DockerLaunch> {
  const { dir, dirReadOnly, mounts, stateDir, ...rest } = options;
  return buildFromSet({ ...rest, mountSet: await resolveMountSet({ dir, dirReadOnly, mounts, stateDir }) });
}

/** The default options of a launch for `dir`; the state directory is the one that holds the Kiro home sources. */
function options(dir: string, overrides: Partial<TestLaunchOptions> = {}): TestLaunchOptions {
  return {
    launchId: LAUNCH_ID,
    stateDir: kiroBase,
    dir,
    user: USER,
    image: IMAGE,
    token: TOKEN,
    env: BASE_ENV,
    kiroHome: KIRO_HOME,
    owner: OWNER,
    secrets: buildSecretSet({ apiKey: TOKEN, env: BASE_ENV }),
    ...overrides,
  };
}

/** A resolved temp directory with a `work` directory inside. */
async function workDir(t: TestContext): Promise<{ base: string; work: string }> {
  const base = await realpath(await tempDir(t));
  const work = join(base, 'work');
  await mkdir(work);
  return { base, work };
}

async function assertInvalidDir(dir: string, message: RegExp): Promise<void> {
  await assert.rejects(buildDockerLaunch(options(dir)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: unknown }).code, 'E_INVALID');
    assert.equal((error as { field?: unknown }).field, 'dir');
    assert.match(error.message, message);
    return true;
  });
}

describe('container name', () => {
  test('is the prefix and the 12 hex digits of the launch id', () => {
    assert.equal(containerName('ks_0123456789ab'), 'kiro-sidecar-0123456789ab');
  });

  test('refuses a value that is not a launch id', () => {
    assert.throws(() => containerName('ks_0123'), TypeError);
    assert.throws(() => containerName('0123456789ab'), TypeError);
  });
});

describe('docker run arguments', () => {
  test('minimal launch: the exact argument array, command and container name', async (t) => {
    const { work } = await workDir(t);
    const launch = await buildDockerLaunch(options(work));
    assert.equal(launch.command, 'docker');
    assert.deepEqual(launch.args, expectedArgs(work));
    assert.equal(launch.containerName, 'kiro-sidecar-0123456789ab');
    assert.equal(launch.dir, work);
  });

  for (const name of PROXY_VARIABLES) {
    test(`${name} given alone is passed by name only`, async (t) => {
      const { work } = await workDir(t);
      const value = `http://proxy-user:proxy-secret-${name}@proxy.example:3128`;
      const launch = await buildDockerLaunch(options(work, { proxy: { [name]: value } }));
      assert.deepEqual(launch.args, expectedArgs(work, [name]));
      assert.ok(launch.args.every((arg) => !arg.includes('proxy-secret')));
      assert.equal(launch.env[name], value);
    });
  }

  test('no proxy given: none is passed', async (t) => {
    const { work } = await workDir(t);
    const launch = await buildDockerLaunch(options(work));
    for (const name of PROXY_VARIABLES) {
      assert.ok(!launch.args.includes(name), `${name} must not be passed`);
    }
  });

  test("the server's own proxy variables never reach the container", async (t) => {
    const { work } = await workDir(t);
    const env: Record<string, string> = { ...BASE_ENV } as Record<string, string>;
    for (const name of PROXY_VARIABLES) {
      env[name] = 'http://127.0.0.1:10817';
    }
    const launch = await buildDockerLaunch(options(work, { env }));
    assert.deepEqual(launch.args, expectedArgs(work));
  });

  test('all proxy variables given: all are passed in a fixed order', async (t) => {
    const { work } = await workDir(t);
    const proxy: Record<string, string> = {};
    for (const name of [...PROXY_VARIABLES].reverse()) {
      proxy[name] = `http://proxy.example:3128/${name}`;
    }
    const launch = await buildDockerLaunch(options(work, { proxy }));
    assert.deepEqual(launch.args, expectedArgs(work, PROXY_VARIABLES));
  });

  test('a given proxy value replaces the server value in the CLI environment', async (t) => {
    const { work } = await workDir(t);
    const launch = await buildDockerLaunch(
      options(work, {
        env: { ...BASE_ENV, https_proxy: 'http://127.0.0.1:10817' },
        proxy: { https_proxy: 'http://host.docker.internal:10817' },
      }),
    );
    assert.deepEqual(launch.args, expectedArgs(work, ['https_proxy']));
    assert.equal(launch.env.https_proxy, 'http://host.docker.internal:10817');
  });

  test('the token is never in the arguments, only in the CLI environment', async (t) => {
    const { work } = await workDir(t);
    const launch = await buildDockerLaunch(
      options(work, { env: { ...BASE_ENV, KIRO_API_KEY: 'another-token-from-the-server-env' } }),
    );
    assert.ok(launch.args.every((arg) => !arg.includes(TOKEN)));
    assert.ok(launch.args.includes('KIRO_API_KEY'));
    assert.ok(launch.args.every((arg) => !arg.startsWith('KIRO_API_KEY=')));
    assert.equal(launch.env.KIRO_API_KEY, TOKEN);
  });

  test('the CLI environment is the server environment without CLAUDE_* variables', async (t) => {
    const { work } = await workDir(t);
    const env: Environment = {
      PATH: '/usr/bin:/bin',
      DOCKER_HOST: 'unix:///run/user/1000/docker.sock',
      CLAUDECODE: '1',
      CLAUDE_CODE_SSE_PORT: '41234',
      CLAUDE_PLUGIN_DATA: '/data/plugin',
      CLAUDE_CODE_MESSAGING_TOKEN: 'messaging-token-value',
      UNSET_VARIABLE: undefined,
    };
    const launch = await buildDockerLaunch(options(work, { env }));
    assert.deepEqual(launch.env, {
      PATH: '/usr/bin:/bin',
      DOCKER_HOST: 'unix:///run/user/1000/docker.sock',
      CLAUDECODE: '1',
      KIRO_API_KEY: TOKEN,
    });
    assert.ok(launch.args.every((arg) => !arg.includes('CLAUDE_')));
  });
});

describe('work directory', () => {
  test('a comma in the path is E_INVALID naming dir', async (t) => {
    const { base } = await workDir(t);
    const dir = join(base, 'a,b');
    await mkdir(dir);
    await assertInvalidDir(dir, /comma/);
  });

  test('a comma in the resolved path behind a symlink is E_INVALID', async (t) => {
    const { base } = await workDir(t);
    const target = join(base, 'x,y');
    await mkdir(target);
    const link = join(base, 'plain-link');
    await symlink(target, link);
    await assertInvalidDir(link, /comma/);
  });

  test('a double quote or a line break in the path is E_INVALID', async (t) => {
    const { base } = await workDir(t);
    for (const name of ['a"b', 'a\nb', 'a\rb']) {
      const dir = join(base, name);
      await mkdir(dir);
      await assertInvalidDir(dir, /double quote or a control character/);
    }
  });

  test('a relative path is E_INVALID', async () => {
    await assertInvalidDir('relative/dir', /absolute path/);
    await assertInvalidDir('', /absolute path/);
  });

  test('a missing path is E_INVALID', async (t) => {
    const { base } = await workDir(t);
    await assertInvalidDir(join(base, 'missing'), /does not exist/);
    await assertInvalidDir(join(base, 'missing', 'deeper'), /does not exist/);
  });

  test('a file is E_INVALID', async (t) => {
    const { base } = await workDir(t);
    const file = join(base, 'file.txt');
    await writeFile(file, 'not a directory\n');
    await assertInvalidDir(file, /must be a directory/);
    await assertInvalidDir(join(file, 'below'), /does not exist/);
  });

  test('the root directory is E_INVALID, also behind a symlink', async (t) => {
    const { base } = await workDir(t);
    await assertInvalidDir('/', /root directory/);
    const link = join(base, 'root-link');
    await symlink('/', link);
    await assertInvalidDir(link, /root directory/);
  });

  test('a symlinked directory is mounted and used at its real path', async (t) => {
    const { base, work } = await workDir(t);
    const link = join(base, 'link-to-work');
    await symlink(work, link);
    const launch = await buildDockerLaunch(options(link));
    assert.deepEqual(launch.args, expectedArgs(work));
    assert.ok(launch.args.every((arg) => !arg.includes('link-to-work')));
    assert.equal(launch.dir, work);
  });
});

describe('other inputs', () => {
  test('an unresolved or malformed user is E_INVALID naming docker_user', async (t) => {
    const { work } = await workDir(t);
    for (const user of ['auto', '', '--privileged', '1000:']) {
      await assert.rejects(buildDockerLaunch(options(work, { user })), {
        code: 'E_INVALID',
        field: 'docker_user',
      });
    }
  });

  test('an image that could be read as an option is E_INVALID naming image', async (t) => {
    const { work } = await workDir(t);
    for (const image of ['--privileged', '', 'name with space']) {
      await assert.rejects(buildDockerLaunch(options(work, { image })), {
        code: 'E_INVALID',
        field: 'image',
      });
    }
  });

  test('a token shorter than 16 characters is E_INVALID and not echoed', async (t) => {
    const { work } = await workDir(t);
    await assert.rejects(buildDockerLaunch(options(work, { token: 'short-token' })), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'E_INVALID');
      assert.equal((error as { field?: unknown }).field, 'token');
      assert.ok(!(error as Error).message.includes('short-token'));
      return true;
    });
  });
});

/** Expects `E_INVALID` naming `field`, with a message matching `message`. */
async function assertInvalid(launch: Promise<unknown>, field: string, message: RegExp): Promise<void> {
  await assert.rejects(launch, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: unknown }).code, 'E_INVALID');
    assert.equal((error as { field?: unknown }).field, field);
    assert.match(error.message, message);
    return true;
  });
}

/** Options with custom mounts given as `path` or `path:ro`. */
function withMounts(dir: string, values: readonly string[], overrides: Partial<TestLaunchOptions> = {}): TestLaunchOptions {
  return options(dir, { mounts: values.map(parseMountSpec), ...overrides });
}

describe('mounts', () => {
  test('a read-only work directory is mounted readonly and is still the working directory', async (t) => {
    const { work } = await workDir(t);
    const launch = await buildDockerLaunch(options(work, { dirReadOnly: true }));
    assert.deepEqual(launch.args, expectedArgs(work, [], [bind(work, true)]));
    assert.equal(launch.dir, work);
  });

  test('custom mounts follow the work directory in the given order, readonly where asked', async (t) => {
    const { base, work } = await workDir(t);
    const data = join(base, 'data');
    const docs = join(base, 'docs');
    const notes = join(base, 'notes.txt');
    await mkdir(data);
    await mkdir(docs);
    await writeFile(notes, 'notes\n');
    const launch = await buildDockerLaunch(withMounts(work, [data, `${docs}:ro`, `${notes}:ro`]));
    assert.deepEqual(launch.args, expectedArgs(work, [], [bind(work), bind(data), bind(docs, true), bind(notes, true)]));
  });

  test('a symlinked mount source is mounted at its real path', async (t) => {
    const { base, work } = await workDir(t);
    const data = join(base, 'data');
    await mkdir(data);
    const link = join(base, 'link-to-data');
    await symlink(data, link);
    const launch = await buildDockerLaunch(withMounts(work, [`${link}:ro`]));
    assert.deepEqual(launch.args, expectedArgs(work, [], [bind(work), bind(data, true)]));
    assert.ok(launch.args.every((arg) => !arg.includes('link-to-data')));
  });

  test('each mount source is absolute, existing, not the root and mount-safe', async (t) => {
    const { base, work } = await workDir(t);
    const comma = join(base, 'a,b');
    const quote = join(base, 'a"b');
    const behindComma = join(base, 'x,y');
    await mkdir(comma);
    await mkdir(quote);
    await mkdir(behindComma);
    await symlink(behindComma, join(base, 'plain-link'));
    await symlink('/', join(base, 'root-link'));
    const cases: Array<[string, RegExp]> = [
      ['relative/data', /^mounts entry "relative\/data" must be an absolute path$/],
      ['relative/data:ro', /^mounts entry "relative\/data:ro" must be an absolute path$/],
      ['', /^mounts entry "" must be an absolute path$/],
      [join(base, 'missing'), /^mounts entry ".*\/missing" does not exist$/],
      [`${join(base, 'missing', 'deeper')}:ro`, /^mounts entry ".*\/missing\/deeper:ro" does not exist$/],
      ['/', /^mounts entry "\/" must not be the root directory$/],
      ['/:ro', /^mounts entry "\/:ro" must not be the root directory$/],
      [join(base, 'root-link'), /^mounts entry ".*\/root-link" must not be the root directory$/],
      [comma, /^mounts entry ".*\/a,b" must not contain a comma, a double quote or a control character$/],
      [`${quote}:ro`, /must not contain a comma, a double quote or a control character$/],
      [join(base, 'plain-link'), /^mounts entry ".*\/plain-link" resolves to ".*\/x,y", which must not contain a comma/],
    ];
    for (const [value, message] of cases) {
      await assertInvalid(buildDockerLaunch(withMounts(work, [value])), 'mounts', message);
    }
  });

  test('two mounts with the same destination are refused, also through a symlink', async (t) => {
    const { base, work } = await workDir(t);
    const data = join(base, 'data');
    await mkdir(data);
    await symlink(data, join(base, 'link-to-data'));
    await assertInvalid(
      buildDockerLaunch(withMounts(work, [`${work}:ro`])),
      'mounts',
      /^mounts entry ".*\/work:ro" has the same destination ".*\/work" as work directory/,
    );
    await assertInvalid(
      buildDockerLaunch(withMounts(work, [data, `${join(base, 'link-to-data')}:ro`])),
      'mounts',
      /^mounts entry ".*\/link-to-data:ro" has the same destination ".*\/data" as mounts entry ".*\/data"$/,
    );
  });

  test('a writable mount inside a read-only one is refused', async (t) => {
    const { work } = await workDir(t);
    const out = join(work, 'out');
    await mkdir(out);
    await assertInvalid(
      buildDockerLaunch(withMounts(work, [out], { dirReadOnly: true })),
      'mounts',
      /^mounts entry ".*\/work\/out" is writable inside the read-only work directory ".*\/work"$/,
    );
    await assertInvalid(
      buildDockerLaunch(withMounts(out, [`${work}:ro`])),
      'mounts',
      /^mounts entry ".*\/work:ro" is read-only and holds the writable work directory ".*\/work\/out"$/,
    );
  });

  test('a read-only mount inside a writable one is refused', async (t) => {
    const { work } = await workDir(t);
    const docs = join(work, 'docs');
    await mkdir(docs);
    await assertInvalid(
      buildDockerLaunch(withMounts(work, [`${docs}:ro`])),
      'mounts',
      /^mounts entry ".*\/work\/docs:ro" is read-only inside the writable work directory ".*\/work"$/,
    );
  });

  test('a mount above a reserved container path is refused', async (t) => {
    // Mounts land at their resolved path; on macOS /home is a symlink into /System/Volumes/Data.
    if ((await realpath('/home').catch(() => '')) !== '/home') {
      t.skip('/home is not a real directory on this host');
      return;
    }
    const { work } = await workDir(t);
    await assertInvalid(
      buildDockerLaunch(withMounts(work, ['/home:ro'])),
      'mounts',
      /^mounts entry "\/home:ro" would be mounted at "\/home": nothing may be mounted at, inside or above/,
    );
  });
});

describe('linked git worktree', () => {
  test('the common dir git reports is mounted read-only after the work directory', async (t) => {
    const { base } = await workDir(t);
    const { main, worktree, commonDir } = await repoWithWorktree(base);
    assert.equal(commonDir, join(main, '.git'));
    const launch = await buildDockerLaunch(options(worktree));
    assert.deepEqual(launch.args, expectedArgs(worktree, [], [bind(worktree), bind(commonDir, true)]));
  });

  test('with a read-only work directory both are readonly, and custom mounts follow', async (t) => {
    const { base } = await workDir(t);
    const { main, worktree, commonDir } = await repoWithWorktree(base);
    const data = join(base, 'data');
    await mkdir(data);
    const launch = await buildDockerLaunch(withMounts(worktree, [data, `${main}:ro`], { dirReadOnly: true }));
    assert.deepEqual(
      launch.args,
      expectedArgs(worktree, [], [bind(worktree, true), bind(commonDir, true), bind(data), bind(main, true)]),
    );
  });

  test('the main checkout is not a linked worktree: nothing is added', async (t) => {
    const { base } = await workDir(t);
    const { main } = await repoWithWorktree(base);
    const launch = await buildDockerLaunch(options(main));
    assert.deepEqual(launch.args, expectedArgs(main));
  });

  test('a writable mount that holds or sits inside the common dir is refused, so is the common dir itself', async (t) => {
    const { base } = await workDir(t);
    const { main, worktree, commonDir } = await repoWithWorktree(base);
    const extra = join(commonDir, 'extra');
    await mkdir(extra);
    await assertInvalid(
      buildDockerLaunch(withMounts(worktree, [main])),
      'mounts',
      /^mounts entry ".*\/main" is writable and holds the read-only git common dir ".*\/main\/.git"$/,
    );
    await assertInvalid(
      buildDockerLaunch(withMounts(worktree, [extra])),
      'mounts',
      /^mounts entry ".*\/main\/.git\/extra" is writable inside the read-only git common dir ".*\/main\/.git"$/,
    );
    for (const value of [commonDir, `${commonDir}:ro`]) {
      await assertInvalid(
        buildDockerLaunch(withMounts(worktree, [value])),
        'mounts',
        /has the same destination ".*\/main\/.git" as git common dir/,
      );
    }
  });

  test('relative gitdir, commondir and back-link paths are resolved, line ends dropped', async (t) => {
    const { base, work } = await workDir(t);
    const repo = join(base, 'repo.git');
    await mkdir(join(repo, 'worktrees', 'x'), { recursive: true });
    await writeFile(join(repo, 'worktrees', 'x', 'commondir'), '../..\r\n');
    await writeFile(join(repo, 'worktrees', 'x', 'gitdir'), '../../../work/.git\r\n');
    await writeFile(join(work, '.git'), 'gitdir: ../repo.git/worktrees/x\r\n');
    assert.equal(await gitCommonDir(work), repo);
  });

  test('a git dir without commondir is mounted only when its core.worktree names the work directory', async (t) => {
    const { base, work } = await workDir(t);
    const gitDir = join(base, 'modules', 'sub');
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(work, '.git'), `gitdir: ${gitDir}\n`);
    assert.deepEqual((await buildDockerLaunch(options(work))).args, expectedArgs(work));
    await writeFile(join(gitDir, 'config'), '[core]\n\tbare = false\n\tworktree = ../../elsewhere\n');
    assert.deepEqual((await buildDockerLaunch(options(work))).args, expectedArgs(work));
    await writeFile(join(gitDir, 'config'), '[core]\n\tbare = false\n\tworktree = ../../work\n');
    assert.deepEqual((await buildDockerLaunch(options(work))).args, expectedArgs(work, [], [bind(work), bind(gitDir, true)]));
  });

  test('no .git, a .git directory, or a .git file in another format adds nothing', async (t) => {
    const { base } = await workDir(t);
    assert.equal(await gitCommonDir(base), null);
    const cases: Array<[string, string | null]> = [
      ['plain', null],
      ['other-format', 'not a git file\n'],
      ['empty-gitdir', 'gitdir: \n'],
      ['no-space', 'gitdir:/somewhere\n'],
    ];
    for (const [name, content] of cases) {
      const dir = join(base, name);
      await mkdir(join(dir, content === null ? '.git' : ''), { recursive: true });
      if (content !== null) {
        await writeFile(join(dir, '.git'), content);
      }
      assert.equal(await gitCommonDir(dir), null, name);
      const launch = await buildDockerLaunch(options(dir));
      assert.deepEqual(launch.args, expectedArgs(dir), name);
    }
  });

  test('a real worktree whose common dir is not mount-safe is E_INVALID naming dir', async (t) => {
    const { base } = await workDir(t);
    const repo = join(base, 're,po');
    await mkdir(repo);
    await git(repo, base, 'init', '--quiet', '--initial-branch', 'main');
    await writeFile(join(repo, 'README.md'), 'test repository\n');
    await git(repo, base, 'add', 'README.md');
    await git(repo, base, 'commit', '--quiet', '-m', 'initial commit');
    const worktree = join(base, 'feature');
    await git(repo, base, 'worktree', 'add', '--quiet', '-b', 'feature', worktree);
    await assertInvalid(
      buildDockerLaunch(options(worktree)),
      'dir',
      /^dir is a git work tree whose common dir ".*\/re,po\/.git" must not contain a comma/,
    );
  });
});

describe('plugin state directory', () => {
  const tmpfs = (path: string) => `type=tmpfs,dst=${path}`;

  test('a work directory at or inside it is E_INVALID naming dir, also through a symlink', async (t) => {
    const { base } = await workDir(t);
    const link = join(base, 'link-to-homes');
    await symlink(join(kiroBase, 'homes'), link);
    for (const dir of [kiroBase, join(kiroBase, 'homes'), link]) {
      await assertInvalid(
        buildDockerLaunch(options(dir)),
        'dir',
        /would be mounted at ".*": nothing may be mounted at or inside the plugin state directory "/,
      );
    }
  });

  test('a custom mount at or inside it is E_INVALID naming mounts', async (t) => {
    const { work } = await workDir(t);
    for (const value of [`${kiroBase}:ro`, kiroBase, join(kiroBase, 'runs'), `${join(kiroBase, 'homes', 'default')}:ro`]) {
      await assertInvalid(
        buildDockerLaunch(withMounts(work, [value])),
        'mounts',
        /^mounts entry ".*" would be mounted at ".*": nothing may be mounted at or inside the plugin state directory "/,
      );
    }
  });

  test('a work directory above it gets an empty tmpfs over it, right after the work directory', async (t) => {
    const { base, work } = await workDir(t);
    const stateDir = join(work, '.local', 'state', 'kiro-sidecar');
    await mkdir(stateDir, { recursive: true });
    const data = join(base, 'data');
    await mkdir(data);
    for (const dirReadOnly of [false, true]) {
      const launch = await buildDockerLaunch(withMounts(work, [data], { stateDir, dirReadOnly }));
      assert.deepEqual(launch.args, expectedArgs(work, [], [bind(work, dirReadOnly), tmpfs(stateDir), bind(data)]));
    }
  });

  test('the tmpfs follows the last mount that holds it, and a symlinked state directory is masked at its real path', async (t) => {
    const { base, work } = await workDir(t);
    const data = join(base, 'data');
    const stateDir = join(data, 'state');
    await mkdir(stateDir, { recursive: true });
    const link = join(work, 'state-link');
    await symlink(stateDir, link);
    const other = join(base, 'other');
    await mkdir(other);
    const launch = await buildDockerLaunch(withMounts(base, [data, other], { stateDir: link }));
    assert.deepEqual(launch.args, expectedArgs(base, [], [bind(base), bind(data), tmpfs(stateDir), bind(other)]));
  });

  test('a set that does not hold it gets no tmpfs', async (t) => {
    const { work } = await workDir(t);
    const launch = await buildDockerLaunch(options(work));
    assert.ok(launch.args.every((arg) => !arg.startsWith('type=tmpfs')));
  });

  test('a git common dir inside it gets no mount', async (t) => {
    const { base } = await workDir(t);
    const stateDir = join(base, 'state');
    const main = join(stateDir, 'main');
    await mkdir(main, { recursive: true });
    await git(main, base, 'init', '--quiet', '--initial-branch', 'main');
    await writeFile(join(main, 'README.md'), 'test repository\n');
    await git(main, base, 'add', 'README.md');
    await git(main, base, 'commit', '--quiet', '-m', 'initial commit');
    const worktree = join(base, 'feature');
    await git(main, base, 'worktree', 'add', '--quiet', '-b', 'feature', worktree);
    assert.equal(await gitCommonDir(worktree), join(main, '.git'));
    const launch = await buildDockerLaunch(options(worktree, { stateDir }));
    assert.deepEqual(launch.args, expectedArgs(worktree));
  });
});

describe('core.worktree in a git config file', () => {
  test('the value git writes for a submodule is read', () => {
    const config = [
      '[core]',
      '\trepositoryformatversion = 0',
      '\tfilemode = true',
      '\tbare = false',
      '\tlogallrefupdates = true',
      '\tworktree = ../../../sub',
      '[remote "origin"]',
      '\turl = /srv/library',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '',
    ].join('\n');
    assert.equal(coreWorktree(config), '../../../sub');
    assert.equal(coreWorktree(config.replaceAll('\n', '\r\n')), '../../../sub');
  });

  test('names are matched without case, the last value wins, and quoting, escapes and comments are read', () => {
    const cases: Array<[string, string | null]> = [
      ['[Core]\nWorkTree = upper\n', 'upper'],
      ['[core]\nworktree = first\n[core]\nworktree = second\n', 'second'],
      ['[core]\nworktree = "with  space" # comment\n', 'with  space'],
      ['[core]\nworktree = a  \tb ; comment\n', 'a  \tb'],
      ['[core]\nworktree = "semi;colon"\n', 'semi;colon'],
      ['[core]\nworktree = back\\\\slash\n', 'back\\slash'],
      ['# leading comment\n; another\n[core] # trailing\n\tworktree=../x\n', '../x'],
      ['[core]\nbare = false\n', null],
      ['[core "sub"]\nworktree = ../x\n', null],
      ['[core.sub]\nworktree = ../x\n', null],
      ['[remote "origin"]\nworktree = ../x\n', null],
      ['', null],
    ];
    for (const [config, expected] of cases) {
      assert.equal(coreWorktree(config), expected, JSON.stringify(config));
    }
  });

  test('a line this reader does not know makes the whole file unread', () => {
    const cases = [
      '[core]\nworktree = ../x\\\n  continued\n',
      '[core]\nworktree = "open\n',
      '[core]\nworktree = bad\\qescape\n',
      '[core] worktree = ../x\n',
      '[core]\nworktree = ../x\nnot a variable line\n',
    ];
    for (const config of cases) {
      assert.equal(coreWorktree(config), null, JSON.stringify(config));
    }
  });
});

/** The `--mount` values of an argument array, in order. */
function mountValuesOf(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => (index > 0 && args[index - 1] === '--mount' ? [arg] : []));
}

/** Expects a plain error, not `E_INVALID`, with a message matching `message`. */
async function assertPlainError(launch: Promise<unknown>, message: RegExp): Promise<void> {
  await assert.rejects(launch, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: unknown }).code, undefined);
    assert.match(error.message, message);
    return true;
  });
}

describe('Kiro home mounts', () => {
  test('come first: the home read-write, then the empty skill and steering copies read-only', async (t) => {
    const { base, work } = await workDir(t);
    const data = join(base, 'data');
    await mkdir(data);
    const launch = await buildDockerLaunch(withMounts(work, [data], { dirReadOnly: true }));
    assert.deepEqual(mountValuesOf(launch.args), [...kiroBinds(), bind(work, true), bind(data)]);
    assert.deepEqual(launch.args, expectedArgs(work, [], [bind(work, true), bind(data)]));
  });

  test('each source is resolved with realpath', async (t) => {
    const { base, work } = await workDir(t);
    const links: KiroHomeSources = {
      home: join(base, 'home-link'),
      skills: join(base, 'skills-link'),
      steering: join(base, 'steering-link'),
    };
    await symlink(KIRO_HOME.home, links.home);
    await symlink(KIRO_HOME.skills, links.skills);
    await symlink(KIRO_HOME.steering, links.steering);
    const launch = await buildDockerLaunch(options(work, { kiroHome: links }));
    assert.deepEqual(mountValuesOf(launch.args).slice(0, 3), kiroBinds(KIRO_HOME));
  });

  for (const key of ['home', 'skills', 'steering'] as const) {
    test(`a ${key} source that cannot be mounted is a plain error, not E_INVALID`, async (t) => {
      const { base, work } = await workDir(t);
      const file = join(base, 'file');
      await writeFile(file, 'not a directory\n');
      const unsafe = join(base, 'ho,me');
      await mkdir(unsafe);
      const unsafeTarget = join(base, 'ta,rget');
      await mkdir(unsafeTarget);
      const unsafeLink = join(base, 'target-link');
      await symlink(unsafeTarget, unsafeLink);
      const cases: Array<[string, RegExp]> = [
        [join(base, 'missing'), /^The .* ".*\/missing" cannot be resolved \(ENOENT\)$/],
        [file, /^The .* ".*\/file" must be a directory$/],
        ['/', /^The .* "\/" must not resolve to the root directory$/],
        [unsafe, /^The .* ".*\/ho,me" must not contain a comma/],
        [unsafeLink, /^The .* ".*\/target-link" resolves to ".*\/ta,rget", which must not contain a comma/],
      ];
      for (const [path, message] of cases) {
        await assertPlainError(buildDockerLaunch(options(work, { kiroHome: { ...KIRO_HOME, [key]: path } })), message);
      }
    });
  }
});

describe('container labels', () => {
  test('follow the name: the launch id, the owner key, the driver pid, start time and host id', async (t) => {
    const { work } = await workDir(t);
    const launch = await buildDockerLaunch(options(work));
    const name = launch.args.indexOf('--name');
    assert.deepEqual(
      launch.args.slice(name + 2, name + 2 + 2 * EXPECTED_LABELS.length),
      EXPECTED_LABELS.flatMap((label) => ['--label', label]),
    );
    assert.equal(launch.args[name + 2 + 2 * EXPECTED_LABELS.length], '--user');
  });

  test('take their values from the launch and its identities', async (t) => {
    const { work } = await workDir(t);
    const owner: ContainerOwner = {
      ownerKey: 'pid-77-1234@other-host:boot-2:4026531999',
      driver: { pid: 88, startTime: 'Sat_Oct_17_10:00:00_2026', hostId: 'other-host:boot-2:4026531999' },
    };
    const launch = await buildDockerLaunch(options(work, { launchId: 'ks_ba9876543210', owner }));
    const labels = launch.args.flatMap((arg, index) => (launch.args[index - 1] === '--label' ? [arg] : []));
    assert.deepEqual(labels, [
      'kiro-sidecar.launch=ks_ba9876543210',
      'kiro-sidecar.owner=pid-77-1234@other-host:boot-2:4026531999',
      'kiro-sidecar.driver-pid=88',
      'kiro-sidecar.driver-start=Sat_Oct_17_10:00:00_2026',
      'kiro-sidecar.host=other-host:boot-2:4026531999',
    ]);
  });

  test('a label value holding a secret of the run fails the launch without naming the secret', async (t) => {
    const { work } = await workDir(t);
    const cases: Array<[string, RegExp]> = [
      ['987700', /^The container label kiro-sidecar\.driver-start holds a secret$/],
      ['boot-1', /^The container label kiro-sidecar\.owner holds a secret$/],
      ['ks_0123456789ab', /^The container label kiro-sidecar\.launch holds a secret$/],
    ];
    for (const [secret, message] of cases) {
      const secrets = buildSecretSet({ apiKey: TOKEN, env: { ...BASE_ENV, HTTPS_PROXY: secret } });
      await assertPlainError(buildDockerLaunch(options(work, { secrets })), message);
    }
  });
});

describe('task file', () => {
  function taskBind(source: string): string {
    return `type=bind,src=${source},dst=/home/agent/task.md,readonly`;
  }

  test('is mounted last and read-only at /home/agent/task.md, after the custom mounts', async (t) => {
    const { base, work } = await workDir(t);
    const data = join(base, 'data');
    await mkdir(data);
    const task = join(base, 'task.md');
    await writeFile(task, 'Fix the parser.\n');
    const launch = await buildDockerLaunch(withMounts(work, [`${data}:ro`], { taskFile: task }));
    assert.deepEqual(launch.args, expectedArgs(work, [], [bind(work), bind(data, true), taskBind(task)]));
  });

  test('a symlinked task file is mounted from its real path', async (t) => {
    const { base, work } = await workDir(t);
    const task = join(base, 'task.md');
    await writeFile(task, 'Fix the parser.\n');
    await symlink(task, join(base, 'task-link.md'));
    const launch = await buildDockerLaunch(options(work, { taskFile: join(base, 'task-link.md') }));
    assert.deepEqual(launch.args, expectedArgs(work, [], [bind(work), taskBind(task)]));
  });

  test('a task file that is a directory, missing or unsafe is a plain error', async (t) => {
    const { base, work } = await workDir(t);
    const cases: Array<[string, RegExp]> = [
      [base, /^The task file ".*" must be a regular file$/],
      [join(base, 'missing.md'), /^The task file ".*" cannot be resolved \(ENOENT\)$/],
      [join(base, 'a,b.md'), /^The task file ".*" must not contain a comma/],
    ];
    for (const [taskFile, message] of cases) {
      await assertPlainError(buildDockerLaunch(options(work, { taskFile })), message);
    }
  });
});

describe('tool server', () => {
  function toolServerBind(source: string): string {
    return `type=bind,src=${source},dst=/opt/kiro-sidecar/sidecar-tools.mjs,readonly`;
  }

  test('is mounted read-only at /opt/kiro-sidecar/sidecar-tools.mjs, after the task file, from its real path', async (t) => {
    const { base, work } = await workDir(t);
    const task = join(base, 'task.md');
    await writeFile(task, 'Fix the parser.\n');
    const tools = join(base, 'sidecar-tools.js');
    await writeFile(tools, '');
    await symlink(tools, join(base, 'tools-link.js'));
    const launch = await buildDockerLaunch(options(work, { taskFile: task, toolServerFile: join(base, 'tools-link.js') }));
    assert.deepEqual(
      launch.args,
      expectedArgs(work, [], [bind(work), `type=bind,src=${task},dst=/home/agent/task.md,readonly`, toolServerBind(tools)]),
    );
    const alone = await buildDockerLaunch(options(work, { toolServerFile: tools }));
    assert.deepEqual(alone.args, expectedArgs(work, [], [bind(work), toolServerBind(tools)]));
  });

  test('a tool server file that is a directory, missing or unsafe is a plain error', async (t) => {
    const { base, work } = await workDir(t);
    const cases: Array<[string, RegExp]> = [
      [base, /^The tool server ".*" must be a regular file$/],
      [join(base, 'missing.js'), /^The tool server ".*" cannot be resolved \(ENOENT\)$/],
      [join(base, 'a,b.js'), /^The tool server ".*" must not contain a comma/],
    ];
    for (const [toolServerFile, message] of cases) {
      await assertPlainError(buildDockerLaunch(options(work, { toolServerFile })), message);
    }
  });
});
