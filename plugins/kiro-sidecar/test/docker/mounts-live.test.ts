// Runs the mounts of the built `docker run` command for real, with a shell in
// place of kiro-cli, and checks what the container can do with them: git
// reads work in a linked worktree and writes to its common dir fail, a
// read-only work directory refuses writes, and the shared Kiro home takes
// writes while the run's skill and steering copies refuse them.
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDockerLaunch, resolveMountSet } from '../../src/docker/launch.ts';
import type { DockerLaunch, DockerLaunchOptions, MountRequest } from '../../src/docker/launch.ts';
import { resolveDockerUser } from '../../src/docker/user.ts';
import { SidecarError } from '../../src/errors.ts';
import { newLaunchId } from '../../src/store/paths.ts';
import { ensureHome, ensureRunCopyDirs, writeTaskCopy } from '../../src/store/runs.ts';
import { git, repoWithWorktree } from '../helpers/git.ts';
import { tempDir } from '../helpers/processes.ts';
import { SKIP_WITHOUT_IMAGE, TEST_IMAGE, liveLaunchIdentity, removeTestContainer, testContainerName } from './live.ts';

const PLACEHOLDER_TOKEN = 'placeholder-token-not-a-real-key';
const LIVE_TIMEOUT = { skip: SKIP_WITHOUT_IMAGE, timeout: 120_000 };

/** `auto`, or on a rootful daemon the uid and gid of this process. */
async function containerUser(): Promise<string> {
  try {
    return await resolveDockerUser('auto');
  } catch (error) {
    if (error instanceof SidecarError && error.code === 'E_DOCKER' && process.getuid !== undefined) {
      return `${process.getuid()}:${process.getgid?.() ?? 0}`;
    }
    throw error;
  }
}

interface ShellResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `script` with `sh -c` in a container started with the built command:
 * the same mounts, user, environment and working directory, with a test
 * container name and `sh` in place of the kiro-cli entrypoint.
 */
async function runShell(t: { after: (fn: () => Promise<void>) => void }, launch: DockerLaunch, script: string): Promise<ShellResult> {
  const nameIndex = launch.args.indexOf('--name') + 1;
  const entrypointIndex = launch.args.indexOf('--entrypoint');
  assert.ok(nameIndex > 0 && entrypointIndex > 0);
  const name = testContainerName();
  t.after(() => removeTestContainer(name));
  const args = [
    ...launch.args.slice(0, entrypointIndex).map((arg, index) => (index === nameIndex ? name : arg)),
    '--entrypoint',
    'sh',
    TEST_IMAGE,
    '-c',
    script,
  ];
  return new Promise((resolve) => {
    execFile(launch.command, args, { env: { ...launch.env }, encoding: 'utf8', timeout: 90_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
  });
}

/** The Kiro home directories of a launch, prepared the way a start prepares them. */
interface KiroState {
  readonly stateDir: string;
  readonly launchId: string;
  readonly home: string;
  readonly skills: string;
  readonly steering: string;
}

async function kiroState(t: TestContext): Promise<KiroState> {
  const stateDir = await realpath(await tempDir(t));
  const launchId = newLaunchId();
  const home = await ensureHome(stateDir, 'default');
  const copies = await ensureRunCopyDirs(stateDir, launchId);
  return { stateDir, launchId, home: home.dir, skills: copies.skills, steering: copies.steering };
}

async function launchFor(
  t: TestContext,
  dir: string,
  overrides: Partial<Omit<DockerLaunchOptions, 'mountSet'>> & Omit<MountRequest, 'dir' | 'stateDir'> = {},
  state?: KiroState,
): Promise<DockerLaunch> {
  const kiro = state ?? (await kiroState(t));
  const { dirReadOnly, mounts, ...rest } = overrides;
  return buildDockerLaunch({
    launchId: kiro.launchId,
    mountSet: await resolveMountSet({ dir, dirReadOnly, mounts, stateDir: kiro.stateDir }),
    user: await containerUser(),
    image: TEST_IMAGE,
    token: PLACEHOLDER_TOKEN,
    env: process.env,
    kiroHome: { home: kiro.home, skills: kiro.skills, steering: kiro.steering },
    ...(await liveLaunchIdentity(PLACEHOLDER_TOKEN)),
    ...rest,
  });
}

/** Every path under `root`, `root` included, with the uid that owns it. */
async function ownersUnder(root: string): Promise<Array<[string, number]>> {
  const owners: Array<[string, number]> = [[root, (await lstat(root)).uid]];
  for (const entry of await readdir(root, { recursive: true })) {
    const path = join(root, entry);
    owners.push([path, (await lstat(path)).uid]);
  }
  return owners;
}

describe('docker mounts, live', () => {
  test('in a linked worktree git reads work and a commit fails on the read-only common dir', LIVE_TIMEOUT, async (t) => {
    const base = await realpath(await tempDir(t));
    const { worktree, main } = await repoWithWorktree(base);
    const before = await git(main, base, 'rev-parse', 'feature');
    const launch = await launchFor(t, worktree);
    const result = await runShell(
      t,
      launch,
      [
        'git log -1 --format=SUBJECT:%s',
        'echo written > new-file.txt && echo WRITE_OK',
        'if git add new-file.txt; then echo ADD_OK; else echo ADD_FAILED; fi',
        'if git commit -q -m inside; then echo COMMIT_OK; else echo COMMIT_FAILED; fi',
      ].join('\n'),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^SUBJECT:initial commit$/m, result.stderr);
    assert.match(result.stdout, /^WRITE_OK$/m);
    assert.match(result.stdout, /^ADD_FAILED$/m, result.stdout);
    assert.match(result.stdout, /^COMMIT_FAILED$/m, result.stdout);
    assert.match(result.stderr, /Read-only file system/);
    assert.equal(await readFile(join(worktree, 'new-file.txt'), 'utf8'), 'written\n');
    assert.equal(await git(main, base, 'rev-parse', 'feature'), before);
  });

  test('a read-only work directory refuses writes and a writable custom mount takes them', LIVE_TIMEOUT, async (t) => {
    const base = await realpath(await tempDir(t));
    const { main } = await repoWithWorktree(base);
    const out = await realpath(await tempDir(t));
    const launch = await launchFor(t, main, { dirReadOnly: true, mounts: [{ path: out, readOnly: false }] });
    const result = await runShell(
      t,
      launch,
      [
        'cat README.md',
        'if touch probe 2>/dev/null; then echo DIR_WRITE_OK; else echo DIR_WRITE_FAILED; fi',
        `echo written > '${out}/result.txt' && echo MOUNT_WRITE_OK`,
      ].join('\n'),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^test repository$/m);
    assert.match(result.stdout, /^DIR_WRITE_FAILED$/m, result.stdout);
    assert.match(result.stdout, /^MOUNT_WRITE_OK$/m, result.stdout);
    assert.equal(await readFile(join(out, 'result.txt'), 'utf8'), 'written\n');
  });

  test('the Kiro home takes writes, the skill and steering copies refuse them, and no host path is root-owned', LIVE_TIMEOUT, async (t) => {
    const state = await kiroState(t);
    await mkdir(join(state.home, 'sessions', 'cli'), { recursive: true });
    await writeFile(join(state.home, 'sessions', 'cli', 'earlier.json'), '{"id":"earlier"}\n');
    const work = await realpath(await tempDir(t));
    const launch = await launchFor(t, work, {}, state);
    const kiro = '/home/agent/.kiro';
    const result = await runShell(
      t,
      launch,
      [
        `cat ${kiro}/sessions/cli/earlier.json`,
        `echo written > ${kiro}/probe.txt && echo HOME_WRITE_OK`,
        `mkdir -p ${kiro}/logs && echo logged > ${kiro}/logs/probe.log && echo HOME_TREE_OK`,
        `if touch ${kiro}/skills/probe 2>/dev/null; then echo SKILLS_WRITE_OK; else echo SKILLS_WRITE_FAILED; fi`,
        `if mkdir ${kiro}/skills/probe-dir 2>/dev/null; then echo SKILLS_MKDIR_OK; else echo SKILLS_MKDIR_FAILED; fi`,
        `if touch ${kiro}/steering/probe.md 2>/dev/null; then echo STEERING_WRITE_OK; else echo STEERING_WRITE_FAILED; fi`,
        'echo written > work.txt && echo WORK_WRITE_OK',
      ].join('\n'),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^\{"id":"earlier"\}$/m, result.stdout);
    assert.match(result.stdout, /^HOME_WRITE_OK$/m, result.stdout);
    assert.match(result.stdout, /^HOME_TREE_OK$/m, result.stdout);
    assert.match(result.stdout, /^SKILLS_WRITE_FAILED$/m, result.stdout);
    assert.match(result.stdout, /^SKILLS_MKDIR_FAILED$/m, result.stdout);
    assert.match(result.stdout, /^STEERING_WRITE_FAILED$/m, result.stdout);
    assert.match(result.stdout, /^WORK_WRITE_OK$/m, result.stdout);

    assert.equal(await readFile(join(state.home, 'probe.txt'), 'utf8'), 'written\n');
    assert.equal(await readFile(join(state.home, 'logs', 'probe.log'), 'utf8'), 'logged\n');
    assert.equal(await readFile(join(state.home, 'sessions', 'cli', 'earlier.json'), 'utf8'), '{"id":"earlier"}\n');
    for (const empty of [state.skills, state.steering, join(state.home, 'skills'), join(state.home, 'steering')]) {
      assert.deepEqual(await readdir(empty), [], empty);
    }
    const uid = process.getuid?.();
    assert.ok(uid !== undefined);
    for (const [path, owner] of [...(await ownersUnder(state.stateDir)), ...(await ownersUnder(work))]) {
      assert.equal(owner, uid, `${path} is owned by uid ${owner}`);
    }
  });

  test('a work directory above the state directory sees the state directory empty, and the Kiro home still works', LIVE_TIMEOUT, async (t) => {
    const work = await realpath(await tempDir(t));
    await writeFile(join(work, 'visible.txt'), 'visible\n');
    const stateDir = join(work, '.local', 'state', 'kiro-sidecar');
    const launchId = newLaunchId();
    const home = await ensureHome(stateDir, 'default');
    const copies = await ensureRunCopyDirs(stateDir, launchId);
    const meta = join(stateDir, 'runs', launchId, 'meta.json');
    await writeFile(meta, '{"state":"idle"}\n');
    const state: KiroState = { stateDir, launchId, home: home.dir, skills: copies.skills, steering: copies.steering };
    for (const dirReadOnly of [false, true]) {
      const launch = await launchFor(t, work, { dirReadOnly }, state);
      assert.ok(launch.args.includes(`type=tmpfs,dst=${stateDir}`), launch.args.join(' '));
      const result = await runShell(
        t,
        launch,
        [
          'cat visible.txt',
          `echo "STATE_ENTRIES:$(ls -A '${stateDir}' | wc -l | tr -d ' ')"`,
          `if [ -e '${meta}' ]; then echo META_SEEN; else echo META_HIDDEN; fi`,
          `echo probe > /home/agent/.kiro/probe-${dirReadOnly}.txt && echo HOME_WRITE_OK`,
        ].join('\n'),
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^visible$/m, result.stdout);
      assert.match(result.stdout, /^STATE_ENTRIES:0$/m, result.stdout);
      assert.match(result.stdout, /^META_HIDDEN$/m, result.stdout);
      assert.match(result.stdout, /^HOME_WRITE_OK$/m, result.stdout);
      assert.equal(await readFile(join(home.dir, `probe-${dirReadOnly}.txt`), 'utf8'), 'probe\n');
    }
    assert.equal(await readFile(meta, 'utf8'), '{"state":"idle"}\n');
  });

  test('the task file is readable at /home/agent/task.md and refuses writes', LIVE_TIMEOUT, async (t) => {
    const state = await kiroState(t);
    const taskFile = await writeTaskCopy(state.stateDir, state.launchId, Buffer.from('Fix the parser.\n'));
    const work = await realpath(await tempDir(t));
    const launch = await launchFor(t, work, { taskFile }, state);
    const result = await runShell(
      t,
      launch,
      [
        'cat /home/agent/task.md',
        'if echo more >> /home/agent/task.md 2>/dev/null; then echo TASK_APPEND_OK; else echo TASK_APPEND_FAILED; fi',
        'if rm -f /home/agent/task.md 2>/dev/null; then echo TASK_REMOVE_OK; else echo TASK_REMOVE_FAILED; fi',
      ].join('\n'),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Fix the parser\.$/m, result.stdout);
    assert.match(result.stdout, /^TASK_APPEND_FAILED$/m, result.stdout);
    assert.match(result.stdout, /^TASK_REMOVE_FAILED$/m, result.stdout);
    assert.equal(await readFile(taskFile, 'utf8'), 'Fix the parser.\n');
  });
});
