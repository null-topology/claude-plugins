/**
 * The plugin's tool server at `start` (4.11): the file check, the
 * `mcpServers` of `session/new` in both modes, and the step `tools` against
 * the statuses the fake agent reports (`fake-mcp-status`).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { spawnProcess } from '../../src/acp/process.ts';
import type { ProcessSpec } from '../../src/acp/process.ts';
import { SidecarError } from '../../src/errors.ts';
import { TOOL_SERVER_MISSING, TOOL_SERVER_NOT_CONNECTED } from '../../src/session/tool-server.ts';
import { readCall } from '../../src/store/runs.ts';
import {
  PROCESS_TIMEOUT,
  TOOL_SERVER_FILE,
  endedTurn,
  isAlive,
  managerFixture,
  metaOf,
  testEnvironment,
  waitFor,
} from './manager-helpers.ts';
import type { ManagerFixture, ManagerFixtureOptions } from './manager-helpers.ts';

interface ToolsEntry {
  readonly event: string;
  readonly status?: string;
  readonly tools?: number;
}

const CONNECTING: ToolsEntry = { event: 'mcp_status', status: 'connecting', tools: 0 };
const CONNECTED: ToolsEntry = { event: 'mcp_status', status: 'connected', tools: 2 };
const PROMPT: ToolsEntry = { event: 'prompt' };

/** The statuses of `sidecar` the fake sent and the prompts it got, in order. */
async function toolsLog(dir: string): Promise<ToolsEntry[]> {
  let text: string;
  try {
    text = await readFile(join(dir, 'fake-tools.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as ToolsEntry);
}

/** A fixture whose fake reports the tool server as `mode` says; null is the fake's default. */
async function fixtureWith(t: TestContext, mode: string | null, options: ManagerFixtureOptions = {}): Promise<ManagerFixture> {
  const fixture = await managerFixture(t, 'default', options);
  if (mode !== null) {
    await writeFile(join(fixture.workspace.dir, 'fake-mcp-status'), mode);
  }
  return fixture;
}

async function onlyRun(fixture: ManagerFixture): Promise<string> {
  const ids = await readdir(join(fixture.stateDir, 'runs')).catch(() => [] as string[]);
  assert.equal(ids.length, 1, `runs: ${ids.join(', ')}`);
  return ids[0] as string;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** The cleanup every failed start step gets, as the other failed-step tests assert it. */
async function assertCleanedUp(fixture: ManagerFixture, launchId: string): Promise<void> {
  const meta = await metaOf(fixture.stateDir, launchId);
  assert.equal(meta.state, 'failed');
  assert.equal(fixture.spawned.length, 1, `spawned: ${fixture.spawned.join(', ')}`);
  const pid = fixture.spawned[0] as number;
  await waitFor(() => !isAlive(pid), 'the fake to be gone', 5_000);
  assert.equal(await exists(join(fixture.stateDir, 'runs', launchId, 'lock')), false);
  assert.equal(fixture.manager.get(launchId), undefined);
  assert.deepEqual(fixture.manager.list(), []);
}

/** The `mcpServers` of the `session/new` the fake received. */
async function sessionNewServers(fixture: ManagerFixture): Promise<unknown> {
  const received = await fixture.workspace.received();
  const request = received.find((message) => 'method' in message && message.method === 'session/new');
  assert.ok(request !== undefined && 'params' in request, 'session/new was received');
  return (request.params as { mcpServers: unknown }).mcpServers;
}

/**
 * `E_STEP_TOOLS` as every step error: the cause hint, the last status Kiro
 * reported for the server, and the stderr tail when Kiro wrote one.
 */
function isStepTools(last: string, stderr: string | null): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof SidecarError, `unexpected ${String(error)}`);
    assert.equal(error.code, 'E_STEP_TOOLS', error.message);
    const [head, tail] = error.message.split('\nKiro stderr (last lines):\n');
    assert.equal(head, `start step tools failed: ${TOOL_SERVER_NOT_CONNECTED}; last status of server sidecar: ${last}`);
    if (stderr === null) {
      assert.equal(tail, undefined, error.message);
    } else {
      assert.ok(tail?.includes(stderr), error.message);
    }
    return true;
  };
}

describe('SessionManager.start: the tool server', () => {
  test('local mode gives session/new the tool server run by this node, with an empty KIRO_API_KEY', PROCESS_TIMEOUT, async (t) => {
    const fixture = await fixtureWith(t, null);
    await fixture.manager.start({ dir: fixture.workspace.dir });
    assert.deepEqual(await sessionNewServers(fixture), [
      {
        name: 'sidecar',
        command: process.execPath,
        args: [await realpath(TOOL_SERVER_FILE)],
        env: [{ name: 'KIRO_API_KEY', value: '' }],
      },
    ]);
  });

  test('docker mode mounts the tool server read-only and gives session/new the image node', PROCESS_TIMEOUT, async (t) => {
    const specs: ProcessSpec[] = [];
    let command = '';
    const fixture = await fixtureWith(t, null, {
      deps: {
        resolveDockerUser: async () => '0:0',
        checkImage: async () => {},
        spawn: (spec, options) => {
          specs.push(spec);
          // Run the fake agent in place of `docker run`.
          return spawnProcess(
            { argv: [command, 'acp', '--agent-engine', 'v3'], env: testEnvironment() as Record<string, string>, cwd: spec.cwd },
            options,
          );
        },
        removeContainers: () => {},
      },
    });
    command = fixture.workspace.command;
    await fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir, image: 'kiro-test:1' });
    const argv = specs[0]?.argv ?? [];
    const mounts = argv.flatMap((arg, index) => (arg === '--mount' ? [argv[index + 1]] : []));
    assert.equal(
      mounts.at(-1),
      `type=bind,src=${await realpath(TOOL_SERVER_FILE)},dst=/opt/kiro-sidecar/sidecar-tools.mjs,readonly`,
    );
    assert.deepEqual(await sessionNewServers(fixture), [
      {
        name: 'sidecar',
        command: '/usr/bin/node',
        args: ['/opt/kiro-sidecar/sidecar-tools.mjs'],
        env: [{ name: 'KIRO_API_KEY', value: '' }],
      },
    ]);
  });

  for (const mode of ['local', 'docker'] as const) {
    test(`${mode} mode: a missing, non-regular or unmountable tool server file is E_INTERNAL before any spawn`, PROCESS_TIMEOUT, async (t) => {
      const probe = await managerFixture(t, 'default');
      const base = probe.workspace.dir;
      const directory = join(base, 'tools-dir.js');
      await mkdir(directory);
      const unsafe = join(base, 'a,b.js');
      await writeFile(unsafe, '');
      for (const file of [join(base, 'missing.js'), directory, unsafe]) {
        let spawned = 0;
        const fixture = await managerFixture(t, 'default', {
          toolServerFile: file,
          deps: {
            resolveDockerUser: async () => '0:0',
            checkImage: async () => {},
            spawn: () => {
              spawned += 1;
              throw new Error('must not spawn');
            },
          },
        });
        const params = mode === 'docker' ? { mode, dir: fixture.workspace.dir, image: 'kiro-test:1' } : { dir: fixture.workspace.dir };
        await assert.rejects(fixture.manager.start(params, { toolUseId: 'toolu_tools_file' }), (error) => {
          assert.ok(error instanceof SidecarError, `unexpected ${String(error)}`);
          assert.equal(error.code, 'E_INTERNAL', `${file}: ${error.message}`);
          assert.equal(error.message, TOOL_SERVER_MISSING);
          return true;
        });
        assert.equal(spawned, 0, file);
        assert.deepEqual(fixture.spawned, [], file);
        const launchId = await onlyRun(fixture);
        assert.equal((await metaOf(fixture.stateDir, launchId)).state, 'failed');
        assert.equal(((await readCall(fixture.stateDir, 'toolu_tools_file')) as { failed: boolean }).failed, true);
        assert.deepEqual(fixture.manager.list(), []);
      }
    });
  }
});

describe('SessionManager.start: the step tools', () => {
  for (const [mode, what] of [
    [null, 'connected after the session/new answer (the default)'],
    ['before', 'connected before the session/new answer'],
    ['late 300', 'connected 300 ms after the answer'],
  ] as const) {
    test(`${what}: the prompt is sent only after the tool server is connected`, PROCESS_TIMEOUT, async (t) => {
      const fixture = await fixtureWith(t, mode);
      const result = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: 'hello' });
      await endedTurn(fixture, result.launchId, 1);
      assert.deepEqual(await toolsLog(fixture.workspace.dir), [CONNECTING, CONNECTING, CONNECTED, PROMPT]);
    });
  }

  test('a start without a prompt also waits for the tool server', PROCESS_TIMEOUT, async (t) => {
    const fixture = await fixtureWith(t, 'late 300');
    const result = await fixture.manager.start({ dir: fixture.workspace.dir });
    assert.deepEqual(await toolsLog(fixture.workspace.dir), [CONNECTING, CONNECTING, CONNECTED]);
    assert.equal((await metaOf(fixture.stateDir, result.launchId)).state, 'idle');
  });

  test('another status is logged and waited through', PROCESS_TIMEOUT, async (t) => {
    const fixture = await fixtureWith(t, 'failed 200');
    const result = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: 'hello' });
    await endedTurn(fixture, result.launchId, 1);
    assert.deepEqual(await toolsLog(fixture.workspace.dir), [
      CONNECTING,
      CONNECTING,
      { event: 'mcp_status', status: 'failed', tools: 0 },
      CONNECTED,
      PROMPT,
    ]);
    const log = await readFile(join(fixture.stateDir, 'runs', result.launchId, 'acp.jsonl'), 'utf8');
    const statuses = log
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry['event'] === 'mcp_status')
      .map(({ server, status, tools }) => ({ server, status, tools }));
    assert.deepEqual(statuses, [
      { server: 'sidecar', status: 'connecting', tools: 0 },
      { server: 'sidecar', status: 'connecting', tools: 0 },
      { server: 'sidecar', status: 'failed', tools: 0 },
      { server: 'sidecar', status: 'connected', tools: 2 },
    ]);
  });

  for (const [mode, what, last, stderr] of [
    ['never', 'never connected', 'connecting', 'fixture: the sidecar server does not connect'],
    ['late 3000', 'connected past the cap', 'connecting', null],
    ['missing-tool', 'connected without complete_task', 'connected with tools send_message', null],
    ['failed 3000', 'failed, then connected past the cap', 'failed', null],
    ['silent', 'no status at all', 'none', null],
  ] as const) {
    test(`${what}: E_STEP_TOOLS naming the last status, no prompt, and the cleanup of a failed step`, PROCESS_TIMEOUT, async (t) => {
      const fixture = await fixtureWith(t, mode, { startLimits: { toolsMs: 500 } });
      await assert.rejects(
        fixture.manager.start({ dir: fixture.workspace.dir, prompt: 'hello' }, { toolUseId: 'toolu_tools_cap' }),
        isStepTools(last, stderr),
      );
      const launchId = await onlyRun(fixture);
      await assertCleanedUp(fixture, launchId);
      const call = (await readCall(fixture.stateDir, 'toolu_tools_cap')) as { error: string; failed: boolean };
      assert.equal(call.failed, true);
      assert.ok(call.error.startsWith('E_STEP_TOOLS'), JSON.stringify(call));
      assert.equal((await toolsLog(fixture.workspace.dir)).some((entry) => entry.event === 'prompt'), false);
    });
  }
});
