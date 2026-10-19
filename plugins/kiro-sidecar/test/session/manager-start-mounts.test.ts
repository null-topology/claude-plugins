import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { spawnProcess } from '../../src/acp/process.ts';
import type { ProcessSpec } from '../../src/acp/process.ts';
import { SidecarError } from '../../src/errors.ts';
import { PROTOCOL_STEERING, PROTOCOL_STEERING_FILE } from '../../src/session/protocol-steering.ts';
import { readCall } from '../../src/store/runs.ts';
import { InvalidInputError } from '../../src/text/errors.ts';
import { tempDir } from '../helpers/processes.ts';
import {
  PROCESS_TIMEOUT,
  TEST_TOKEN,
  TOOL_SERVER_FILE,
  endedTurn,
  managerFixture,
  metaOf,
  testEnvironment,
} from './manager-helpers.ts';
import type { ManagerFixture, ManagerFixtureOptions } from './manager-helpers.ts';

function assertInvalid(error: unknown, field: string, fragment: string): boolean {
  assert.ok(error instanceof SidecarError || error instanceof InvalidInputError, `unexpected ${String(error)}`);
  assert.equal(error.code, 'E_INVALID', error.message);
  assert.equal((error as InvalidInputError).field, field, error.message);
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

/**
 * A manager whose docker host checks pass and whose `docker run` is replaced
 * by the fake agent; `atSpawn` sees each spec at the moment of the spawn, and
 * `atImageCheck` runs at the image check, after validation and before the
 * command is built.
 */
async function dockerFixture(
  t: TestContext,
  atSpawn: (spec: ProcessSpec) => void = () => {},
  options: Pick<ManagerFixtureOptions, 'env' | 'owner'> = {},
  atImageCheck: () => Promise<void> = async () => {},
): Promise<{ fixture: ManagerFixture; specs: ProcessSpec[] }> {
  const specs: ProcessSpec[] = [];
  let command = '';
  let agentDir = '';
  const fixture = await managerFixture(t, 'default', {
    ...options,
    settings: { api_key: TEST_TOKEN },
    deps: {
      resolveDockerUser: async () => '0:0',
      checkImage: atImageCheck,
      spawn: (spec, options) => {
        atSpawn(spec);
        specs.push(spec);
        // The fake agent runs in its workspace, which holds its scenario, whatever dir the start was given.
        return spawnProcess(
          { argv: [command, 'acp', '--agent-engine', 'v3'], env: testEnvironment() as Record<string, string>, cwd: agentDir },
          options,
        );
      },
      removeContainers: () => {},
    },
  });
  command = fixture.workspace.command;
  agentDir = fixture.workspace.dir;
  return { fixture, specs };
}

/** The `--mount` values of a command line, in order. */
function mountValues(argv: readonly string[]): string[] {
  return argv.flatMap((arg, index) => (arg === '--mount' ? [argv[index + 1] as string] : []));
}

/** The `--mount` values of the Kiro home mounts of a run, in order. */
async function kiroBinds(stateDir: string, launchId: string): Promise<string[]> {
  const state = await realpath(stateDir);
  const run = join(state, 'runs', launchId);
  return [
    `type=bind,src=${join(state, 'homes', 'default')},dst=/home/agent/.kiro`,
    `type=bind,src=${join(run, 'skills')},dst=/home/agent/.kiro/skills,readonly`,
    `type=bind,src=${join(run, 'steering')},dst=/home/agent/.kiro/steering,readonly`,
  ];
}

/** The `--mount` value of the plugin's tool server, mounted after everything else. */
async function toolServerBind(): Promise<string> {
  return `type=bind,src=${await realpath(TOOL_SERVER_FILE)},dst=/opt/kiro-sidecar/sidecar-tools.mjs,readonly`;
}

/** Whether `path` is a directory, checked synchronously. */
function isDirectorySync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

describe('SessionManager.start mounts in docker mode', () => {
  test('a read-only dir and custom mounts reach the docker command and the run meta', PROCESS_TIMEOUT, async (t) => {
    const { fixture, specs } = await dockerFixture(t);
    const outside = await realpath(await tempDir(t));
    const data = join(outside, 'data');
    const docs = join(outside, 'docs');
    await mkdir(data);
    await mkdir(docs);
    await symlink(data, join(outside, 'link-to-data'));
    const dir = await realpath(fixture.workspace.dir);
    const result = await fixture.manager.start({
      mode: 'docker',
      dir: `${fixture.workspace.dir}:ro`,
      mounts: [join(outside, 'link-to-data'), `${docs}:ro`],
    });
    assert.equal(result.dir, dir);
    const argv = specs[0]?.argv ?? [];
    assert.deepEqual(mountValues(argv), [
      ...(await kiroBinds(fixture.stateDir, result.launchId)),
      `type=bind,src=${dir},dst=${dir},readonly`,
      `type=bind,src=${data},dst=${data}`,
      `type=bind,src=${docs},dst=${docs},readonly`,
      await toolServerBind(),
    ]);
    assert.equal(argv[argv.indexOf('-w') + 1], dir);
    assert.equal(specs[0]?.cwd, dir);
    const meta = await metaOf(fixture.stateDir, result.launchId);
    assert.equal(meta.dir, dir);
    assert.equal(meta.dirReadOnly, true);
    assert.deepEqual(meta.mounts, [data, `${docs}:ro`]);
    assert.equal(meta.state, 'idle');
  });

  for (const change of ['replaced by a link to another directory', 'removed'] as const) {
    test(`a mount source ${change} after validation fails the start at the spawn step, before any container`, PROCESS_TIMEOUT, async (t) => {
      const outside = await realpath(await tempDir(t));
      const source = join(outside, 'source');
      const other = join(outside, 'other');
      await mkdir(source);
      await mkdir(other);
      // After validation and before the command is built.
      const { fixture, specs } = await dockerFixture(t, () => {}, {}, async () => {
        await rm(source, { recursive: true });
        if (change !== 'removed') {
          await symlink(other, source);
        }
      });
      const { manager, workspace, stateDir } = fixture;
      const given = `${source}:ro`;
      const reason = change === 'removed' ? `: mounts entry ${JSON.stringify(given)} does not exist` : '';
      await assert.rejects(manager.start({ mode: 'docker', dir: workspace.dir, mounts: [given] }), (error: unknown) => {
        assert.ok(error instanceof SidecarError, String(error));
        assert.equal(error.code, 'E_STEP_SPAWN', error.message);
        assert.equal(error.message, `start step spawn failed: the mount sources changed after validation${reason}`);
        return true;
      });
      assert.deepEqual(specs, []);
      const ids = await runIds(stateDir);
      assert.equal(ids.length, 1);
      assert.equal((await metaOf(stateDir, ids[0] as string)).state, 'failed');
    });
  }

  test('a dir or mount at or inside the state directory is refused before anything is created', PROCESS_TIMEOUT, async (t) => {
    const { fixture, specs } = await dockerFixture(t);
    const { manager, workspace, stateDir } = fixture;
    const inside = join(stateDir, 'inside');
    await mkdir(inside);
    const rule = 'nothing may be mounted at or inside the plugin state directory';
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ dir: stateDir }, 'dir'],
      [{ dir: `${inside}:ro` }, 'dir'],
      [{ mounts: [`${stateDir}:ro`] }, 'mounts'],
      [{ mounts: [inside] }, 'mounts'],
    ];
    for (const [params, field] of cases) {
      await assert.rejects(
        manager.start({ mode: 'docker', dir: workspace.dir, ...params } as never, { toolUseId: 'toolu_state' }),
        (error) => assertInvalid(error, field, rule),
        JSON.stringify(params),
      );
    }
    assert.deepEqual(specs, []);
    assert.deepEqual(await runIds(stateDir), []);
    assert.equal(await readCall(stateDir, 'toolu_state'), undefined);
  });

  test('a dir above the state directory reaches docker with an empty tmpfs over the state directory', PROCESS_TIMEOUT, async (t) => {
    const { fixture, specs } = await dockerFixture(t);
    const state = await realpath(fixture.stateDir);
    const above = dirname(state);
    const result = await fixture.manager.start({ mode: 'docker', dir: `${above}:ro` });
    assert.deepEqual(mountValues(specs[0]?.argv ?? []), [
      ...(await kiroBinds(fixture.stateDir, result.launchId)),
      `type=bind,src=${above},dst=${above},readonly`,
      `type=tmpfs,dst=${state}`,
      await toolServerBind(),
    ]);
  });

  test('without mounts or ":ro" the meta records a writable dir and no mounts', PROCESS_TIMEOUT, async (t) => {
    const { fixture, specs } = await dockerFixture(t);
    const dir = await realpath(fixture.workspace.dir);
    const result = await fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir, mounts: [] });
    assert.deepEqual(mountValues(specs[0]?.argv ?? []), [
      ...(await kiroBinds(fixture.stateDir, result.launchId)),
      `type=bind,src=${dir},dst=${dir}`,
      await toolServerBind(),
    ]);
    const meta = await metaOf(fixture.stateDir, result.launchId);
    assert.equal(meta.dirReadOnly, false);
    assert.deepEqual(meta.mounts, []);
  });

  test('a mount set that breaks a rule is refused before anything is created', PROCESS_TIMEOUT, async (t) => {
    const { fixture, specs } = await dockerFixture(t);
    const { manager, workspace, stateDir } = fixture;
    const inside = join(workspace.dir, 'inside');
    await mkdir(inside);
    // Mounts land at their resolved path; on macOS /home is a symlink into /System/Volumes/Data.
    const homeIsReal = (await realpath('/home').catch(() => '')) === '/home';
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ mounts: 'not-a-list' }, 'mounts', 'mounts must be an array of strings'],
      [{ mounts: [1] }, 'mounts', 'mounts must be an array of strings'],
      [{ mounts: ['relative/path'] }, 'mounts', 'mounts entry "relative/path" must be an absolute path'],
      [{ mounts: [join(workspace.dir, 'missing')] }, 'mounts', 'does not exist'],
      [{ mounts: ['/'] }, 'mounts', 'must not be the root directory'],
      [{ mounts: [workspace.dir] }, 'mounts', 'has the same destination'],
      [{ mounts: [`${inside}:ro`] }, 'mounts', 'is read-only inside the writable work directory'],
      [{ dir: `${workspace.dir}:ro`, mounts: [inside] }, 'mounts', 'is writable inside the read-only work directory'],
      ...(homeIsReal ? [[{ mounts: ['/home:ro'] }, 'mounts', 'nothing may be mounted at, inside or above'] as [Record<string, unknown>, string, string]] : []),
      [{ dir: 'relative:ro' }, 'dir', 'dir must be an absolute path'],
      [{ dir: `${join(workspace.dir, 'missing')}:ro` }, 'dir', 'dir does not exist'],
    ];
    for (const [params, field, fragment] of cases) {
      await assert.rejects(
        manager.start({ mode: 'docker', dir: workspace.dir, ...params } as never, { toolUseId: 'toolu_mounts' }),
        (error) => assertInvalid(error, field, fragment),
        JSON.stringify(params),
      );
    }
    assert.deepEqual(specs, []);
    assert.deepEqual(await runIds(stateDir), []);
    assert.equal(await readCall(stateDir, 'toolu_mounts'), undefined);
  });

  test('the home and the run copy directories exist at spawn, and what the home holds is kept', PROCESS_TIMEOUT, async (t) => {
    const seen: Array<Record<string, boolean>> = [];
    let stateDir = '';
    const { fixture, specs } = await dockerFixture(t, (spec) => {
      const values = mountValues(spec.argv);
      const source = (index: number): string => /src=([^,]+)/.exec(values[index] ?? '')?.[1] ?? '';
      const home = source(0);
      seen.push({
        homeSkills: isDirectorySync(join(home, 'skills')),
        homeSteering: isDirectorySync(join(home, 'steering')),
        runSkills: isDirectorySync(source(1)),
        runSteering: isDirectorySync(source(2)),
        homeUnderState: home === join(stateDir, 'homes', 'default'),
      });
    });
    stateDir = await realpath(fixture.stateDir);
    const home = join(stateDir, 'homes', 'default');
    const earlier = join(home, 'sessions', 'cli', 'earlier.json');
    const skill = join(home, 'skills', 'lint', 'SKILL.md');
    await mkdir(join(home, 'sessions', 'cli'), { recursive: true });
    await writeFile(earlier, '{"id":"earlier"}\n');
    await mkdir(join(home, 'skills', 'lint'), { recursive: true });
    await writeFile(skill, '# Lint\n');
    const result = await fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir });
    assert.equal(specs.length, 1);
    assert.deepEqual(seen, [{ homeSkills: true, homeSteering: true, runSkills: true, runSteering: true, homeUnderState: true }]);
    assert.equal(await readFile(earlier, 'utf8'), '{"id":"earlier"}\n');
    assert.equal(await readFile(skill, 'utf8'), '# Lint\n');
    assert.deepEqual(await readdir(join(home, 'steering')), []);
    const run = join(stateDir, 'runs', result.launchId);
    assert.deepEqual(await readdir(join(run, 'skills')), []);
    assert.deepEqual(await readdir(join(run, 'steering')), [PROTOCOL_STEERING_FILE]);
  });

  test('the protocol steering is in the run steering copies at spawn, mounted read-only over the home steering', PROCESS_TIMEOUT, async (t) => {
    const seen: Array<{ bind: string; names: string[]; text: string }> = [];
    const { fixture, specs } = await dockerFixture(t, (spec) => {
      const bind = mountValues(spec.argv).find((value) => value.includes(',dst=/home/agent/.kiro/steering,')) ?? '';
      const source = /src=([^,]+)/.exec(bind)?.[1] ?? '';
      seen.push({
        bind,
        names: readdirSync(source),
        text: readFileSync(join(source, PROTOCOL_STEERING_FILE), 'utf8'),
      });
    });
    const result = await fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir });
    assert.equal(specs.length, 1);
    const steeringBind = (await kiroBinds(fixture.stateDir, result.launchId))[2] as string;
    assert.deepEqual(seen, [{ bind: steeringBind, names: [PROTOCOL_STEERING_FILE], text: PROTOCOL_STEERING }]);
    // The home's own steering is left alone in docker mode.
    const state = await realpath(fixture.stateDir);
    assert.deepEqual(await readdir(join(state, 'homes', 'default', 'steering')), []);
  });

  test('a protocol steering that cannot be written fails the start at the spawn step, before any container', PROCESS_TIMEOUT, async (t) => {
    let stateDir = '';
    // The run directory exists by the image check: a directory in the file's place makes the write fail.
    const { fixture, specs } = await dockerFixture(t, () => {}, {}, async () => {
      const [id] = await runIds(stateDir);
      await mkdir(join(stateDir, 'runs', id as string, 'steering', PROTOCOL_STEERING_FILE), { recursive: true });
    });
    stateDir = fixture.stateDir;
    const toolUseId = 'toolu_steering_unwritable_docker';
    await assert.rejects(fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir }, { toolUseId }), (error: unknown) => {
      assert.ok(error instanceof SidecarError, String(error));
      assert.equal(error.code, 'E_STEP_SPAWN', error.message);
      assert.match(error.message, /^start step spawn failed/);
      return true;
    });
    assert.deepEqual(specs, []);
    const ids = await runIds(stateDir);
    assert.equal(ids.length, 1);
    assert.equal((await metaOf(stateDir, ids[0] as string)).state, 'failed');
    const record = (await readCall(stateDir, toolUseId)) as { failed?: boolean } | undefined;
    assert.equal(record?.failed, true, JSON.stringify(record));
    assert.deepEqual(fixture.errors, []);
  });

  for (const blocked of ['', 'skills', 'steering']) {
    const what = blocked === '' ? 'a home' : `a home whose ${blocked} mount target`;
    test(`${what} that is a file fails the start at the spawn step, before any container`, PROCESS_TIMEOUT, async (t) => {
      const { fixture, specs } = await dockerFixture(t);
      const { manager, workspace, stateDir } = fixture;
      const file = join(stateDir, 'homes', 'default', blocked);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, 'not a directory\n');
      await assert.rejects(manager.start({ mode: 'docker', dir: workspace.dir }), (error: unknown) => {
        assert.ok(error instanceof SidecarError, String(error));
        assert.equal(error.code, 'E_STEP_SPAWN', error.message);
        assert.match(error.message, /^start step spawn failed/);
        return true;
      });
      assert.deepEqual(specs, []);
      const ids = await runIds(stateDir);
      assert.equal(ids.length, 1);
      const meta = await metaOf(stateDir, ids[0] as string);
      assert.equal(meta.state, 'failed');
      assert.equal(await readFile(file, 'utf8'), 'not a directory\n');
    });
  }
});

/** The `--label` values of a command line, in order. */
function labelValues(argv: readonly string[]): string[] {
  return argv.flatMap((arg, index) => (arg === '--label' ? [argv[index + 1] as string] : []));
}

describe('SessionManager.start container labels', () => {
  test('docker run carries the launch id, the owner key and the driver identity of the run', PROCESS_TIMEOUT, async (t) => {
    const owner = { pid: 4100, startTime: '987654', hostId: 'test-host:boot-1:4026531836' };
    const { fixture, specs } = await dockerFixture(t, () => {}, { owner });
    const { launchId } = await fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir });
    const meta = await metaOf(fixture.stateDir, launchId);
    assert.equal(meta.ownerKey, 'pid-4100-987654@test-host:boot-1:4026531836');
    assert.notEqual(meta.driver.pid, owner.pid);
    assert.deepEqual(labelValues(specs[0]?.argv ?? []), [
      `kiro-sidecar.launch=${launchId}`,
      `kiro-sidecar.owner=${meta.ownerKey}`,
      `kiro-sidecar.driver-pid=${meta.driver.pid}`,
      `kiro-sidecar.driver-start=${meta.driver.startTime}`,
      `kiro-sidecar.host=${meta.driver.hostId}`,
    ]);
  });

  test('a label value holding a secret of the run fails the start at the spawn step, before any container', PROCESS_TIMEOUT, async (t) => {
    const owner = { pid: 4100, startTime: '987654', hostId: 'test-host:boot-label-secret:4026531836' };
    const { fixture, specs } = await dockerFixture(t, () => {}, {
      owner,
      env: testEnvironment({ HTTPS_PROXY: 'boot-label-secret' }),
    });
    await assert.rejects(fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir }), (error: unknown) => {
      assert.ok(error instanceof SidecarError, String(error));
      assert.equal(error.code, 'E_STEP_SPAWN', error.message);
      assert.match(error.message, /kiro-sidecar\.owner holds a secret/);
      assert.equal(error.message.includes('boot-label-secret'), false, error.message);
      return true;
    });
    assert.deepEqual(specs, []);
  });
});

describe('SessionManager.start with prompt_file in docker mode', () => {
  test('the copy is mounted after the custom mounts and read-only, and the prompt asks Kiro to read it', PROCESS_TIMEOUT, async (t) => {
    const { fixture, specs } = await dockerFixture(t);
    const outside = await realpath(await tempDir(t));
    const data = join(outside, 'data');
    await mkdir(data);
    const task = join(outside, 'task.md');
    const content = `Fix the parser.\n\n${'Keep the public API. '.repeat(20)}\n`;
    await writeFile(task, content);
    const dir = await realpath(fixture.workspace.dir);
    const result = await fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir, mounts: [data], prompt_file: task });
    const copy = join(await realpath(fixture.stateDir), 'runs', result.launchId, 'task.md');
    assert.deepEqual(mountValues(specs[0]?.argv ?? []), [
      ...(await kiroBinds(fixture.stateDir, result.launchId)),
      `type=bind,src=${dir},dst=${dir}`,
      `type=bind,src=${data},dst=${data}`,
      `type=bind,src=${copy},dst=/home/agent/task.md,readonly`,
      await toolServerBind(),
    ]);
    assert.equal(await readFile(copy, 'utf8'), content);
    await endedTurn(fixture, result.launchId, 1);
    const message = (await fixture.workspace.received()).find((entry) => 'method' in entry && entry.method === 'session/prompt');
    const blocks = (message as { params: { prompt: Array<{ type: string; text: string }> } } | undefined)?.params.prompt;
    assert.deepEqual(blocks, [{ type: 'text', text: 'Read the task in /home/agent/task.md and carry it out.' }]);
    const meta = await metaOf(fixture.stateDir, result.launchId);
    assert.equal(meta.firstPromptPreview, content.slice(0, 200));
  });

  test('a refused prompt_file creates nothing and starts no container', PROCESS_TIMEOUT, async (t) => {
    const { fixture, specs } = await dockerFixture(t);
    const missing = join(await tempDir(t), 'missing.md');
    await assert.rejects(
      fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir, prompt_file: missing }, { toolUseId: 'toolu_task' }),
      (error) => assertInvalid(error, 'prompt_file', 'does not exist'),
    );
    assert.deepEqual(specs, []);
    assert.deepEqual(await runIds(fixture.stateDir), []);
    assert.equal(await readCall(fixture.stateDir, 'toolu_task'), undefined);
  });
});
