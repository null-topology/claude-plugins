import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnProcess } from '../../src/acp/process.ts';
import type { ProcessSpec } from '../../src/acp/process.ts';
import { SidecarError } from '../../src/errors.ts';
import { readCall } from '../../src/store/runs.ts';
import { InvalidInputError } from '../../src/text/errors.ts';
import { TURN_OUTCOMES } from '../../src/session/types.ts';
import {
  PROCESS_TIMEOUT,
  TEST_TOKEN,
  endedTurn,
  isAlive,
  managerFixture,
  metaOf,
  testEnvironment,
  waitFor,
} from './manager-helpers.ts';
import type { ManagerFixture } from './manager-helpers.ts';

const RECORDED_PROMPT =
  "Create a file named hello.txt containing the line 'hello from the smoke test', then run the shell command " +
  "'ls -la' and show its output. End your reply with exactly one line: QUESTION: Should I keep hello.txt?";
const RECORDED_SESSION = 'sess_00000000-0000-4000-8000-000000000001';

const RESULT_KEYS = [
  'launchId', 'sessionId', 'label', 'turn', 'outcome', 'endedBy', 'startedAt', 'endedAt', 'durationS', 'toolCalls',
  'lastTool', 'messages', 'messagesDropped', 'completion', 'final', 'textChars', 'truncated', 'error',
  'stderrTail',
].sort();

function assertCode(error: unknown, code: string, fragment?: string): boolean {
  assert.ok(error instanceof SidecarError || error instanceof InvalidInputError, `unexpected ${String(error)}`);
  assert.equal(error.code, code, error.message);
  if (fragment !== undefined) {
    assert.ok(error.message.includes(fragment), error.message);
  }
  return true;
}

async function runIds(stateDir: string): Promise<string[]> {
  try {
    return await readdir(join(stateDir, 'runs'));
  } catch {
    return [];
  }
}

async function onlyRun(fixture: ManagerFixture): Promise<string> {
  const ids = await runIds(fixture.stateDir);
  assert.equal(ids.length, 1, `runs: ${ids.join(', ')}`);
  return ids[0] as string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A failed start: state failed, process gone, lock released, out of the
 * registry. The process is the one the manager spawned, whether or not the
 * fake got far enough to report its own start.
 */
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

describe('SessionManager.start', () => {
  test('without a prompt: idle, no turn, read-back config, local spawn', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const { manager, stateDir, workspace } = fixture;
    const result = await manager.start({ dir: workspace.dir, label: 'alpha' }, { toolUseId: 'toolu_start_1' });

    assert.equal(result.turn, null);
    assert.equal(result.trailer, null);
    assert.equal(result.sessionId, 'sess_00000000-0000-4000-8000-100000000001');
    assert.equal(result.mode, 'local');
    assert.equal(result.dir, await realpath(workspace.dir));
    assert.equal(result.home, 'default');
    assert.equal(result.model, 'auto');
    assert.equal(result.effort, null);
    assert.equal(result.kiroMode, 'vibe');
    assert.equal(result.permissions, 'allow');

    const meta = await metaOf(stateDir, result.launchId);
    assert.equal(meta.state, 'idle');
    assert.equal(meta.kiroSessionId, result.sessionId);
    assert.equal(meta.currentTurn, 0);
    assert.equal(meta.firstPromptPreview, null);
    assert.equal(meta.tokenSource, 'api_key');
    assert.equal(meta.label, 'alpha');
    const started = await workspace.started();
    assert.equal(meta.child?.pid, started.pid);
    assert.deepEqual(started.argv, ['acp', '--agent-engine', 'v3']);
    assert.equal(started.cwd, await realpath(workspace.dir));
    assert.equal(started.env['KIRO_API_KEY'], TEST_TOKEN);
    assert.deepEqual(await readCall(stateDir, 'toolu_start_1'), {
      launchId: result.launchId,
      turn: null,
      driver: meta.driver,
    });
    assert.deepEqual(manager.get(result.launchId), {
      launchId: result.launchId,
      state: 'idle',
      currentTurn: 0,
      runningTurn: null,
      permissionsAnswered: { allowed: 0, denied: 0 },
    });
  });

  test('with a prompt (replayed turn): trailer, running, then the turn result', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'replay');
    const { manager, stateDir, workspace } = fixture;
    const result = await manager.start({ dir: workspace.dir, prompt: RECORDED_PROMPT, label: 'replayed' }, { toolUseId: 'toolu_start_2' });
    const { launchId } = result;

    assert.equal(result.turn, 1);
    assert.equal(result.trailer, `kiro-turn: ${launchId}#1`);
    assert.equal(result.sessionId, RECORDED_SESSION);
    const live = manager.get(launchId);
    assert.equal(live?.state, 'running');
    assert.equal(live?.currentTurn, 1);
    assert.equal(live?.runningTurn?.turn, 1);
    const running = await metaOf(stateDir, launchId);
    assert.equal(running.state, 'running');
    assert.equal(running.firstPromptPreview, RECORDED_PROMPT.slice(0, 200));
    assert.equal((await readCall(stateDir, 'toolu_start_2') as { turn: number }).turn, 1);

    const turn = await endedTurn(fixture, launchId, 1);
    assert.deepEqual(Object.keys(turn).sort(), RESULT_KEYS);
    assert.equal(turn.outcome, 'end_turn');
    assert.equal(turn.endedBy, null);
    assert.equal(turn.launchId, launchId);
    assert.equal(turn.sessionId, RECORDED_SESSION);
    assert.equal(turn.label, 'replayed');
    assert.equal(turn.toolCalls, 3);
    assert.equal(turn.lastTool, 'Run Command');
    // The recorded `QUESTION:` line is plain text: it stays in the final text and is not a message.
    assert.deepEqual(turn.messages, []);
    assert.equal(turn.completion, null);
    assert.ok(turn.final.trimEnd().endsWith('QUESTION: Should I keep hello.txt?'), turn.final.slice(-80));
    assert.ok(turn.final.startsWith('Perfect.'), turn.final.slice(0, 40));
    assert.equal(turn.truncated, false);
    assert.equal(turn.error, null);
    assert.equal(turn.stderrTail, null);
    assert.match(turn.startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.match(turn.endedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok(Number.isInteger(turn.durationS));

    const text = await readFile(join(stateDir, 'runs', launchId, 'turns', '1.md'), 'utf8');
    assert.ok(text.startsWith("I'll create the file, run the command, and show the output."), text.slice(0, 80));
    assert.equal(turn.textChars, text.length);
    assert.equal(await exists(join(stateDir, 'runs', launchId, 'turns', '1.md.part')), false);

    const idle = await metaOf(stateDir, launchId);
    assert.equal(idle.state, 'idle');
    assert.equal(idle.currentTurn, 1);
    assert.deepEqual(manager.get(launchId)?.permissionsAnswered, { allowed: 3, denied: 0 });
    assert.equal(manager.get(launchId)?.runningTurn, null);
    assert.ok(TURN_OUTCOMES.includes(turn.outcome));
  });

  test('permissions deny answers the recorded requests and counts them denied', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'replay');
    const result = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: RECORDED_PROMPT, permissions: 'deny' });
    await endedTurn(fixture, result.launchId, 1);
    assert.deepEqual(fixture.manager.get(result.launchId)?.permissionsAnswered, { allowed: 0, denied: 3 });
  });

  test('permissions deny still allows the plugin own tools and does not count them', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const steps = [
      { tool: 'send_message', args: { text: 'Asked under deny.' }, end: 'completed', ask: true },
      { tool: 'complete_task', args: { result: 'Done under deny.' }, end: 'completed', ask: true },
      { tool: 'send_message', args: { text: 'Not an own tool.' }, end: 'completed', ask: true, title: 'Write File' },
    ];
    const prompt = `own-tools ${JSON.stringify(steps)}`;
    const result = await fixture.manager.start({ dir: fixture.workspace.dir, prompt, permissions: 'deny' });
    // The completion closes the session: its counts are read when the turn ends, while it is still live.
    const answered = fixture.manager
      .turnEnded(result.launchId, 1)
      ?.then(() => fixture.manager.get(result.launchId)?.permissionsAnswered);
    const turn = await endedTurn(fixture, result.launchId, 1);
    assert.equal(turn.final, '@sidecar/send_message: allow_once\n@sidecar/complete_task: allow_once\nWrite File: reject_once');
    assert.deepEqual(turn.messages, ['Asked under deny.']);
    assert.equal(turn.completion?.result, 'Done under deny.');
    assert.deepEqual(await answered, { allowed: 0, denied: 1 });
    assert.equal(fixture.manager.get(result.launchId), undefined);
  });

  test('permissions deny rejects and counts a request titled as an own tool without its identity', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const ask = { tool: 'send_message', end: 'completed', ask: true } as const;
    const steps = [
      { ...ask, args: { text: 'No identity.' }, identity: null },
      { ...ask, args: { text: 'Another server.' }, identity: { serverName: 'other', toolName: 'send_message' } },
      { ...ask, args: { text: 'Another tool.' }, identity: { serverName: 'sidecar', toolName: 'complete_task' } },
      { ...ask, args: { text: 'The real one.' } },
    ];
    const prompt = `own-tools ${JSON.stringify(steps)}`;
    const result = await fixture.manager.start({ dir: fixture.workspace.dir, prompt, permissions: 'deny' });
    const turn = await endedTurn(fixture, result.launchId, 1);
    assert.equal(
      turn.final,
      [
        '@sidecar/send_message: reject_once',
        '@sidecar/send_message: reject_once',
        '@sidecar/send_message: reject_once',
        '@sidecar/send_message: allow_once',
      ].join('\n'),
    );
    assert.deepEqual(turn.messages, ['The real one.']);
    assert.deepEqual(fixture.manager.get(result.launchId)?.permissionsAnswered, { allowed: 0, denied: 3 });
  });

  test('model, effort and kiro_mode are set and read back', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const result = await fixture.manager.start({
      dir: fixture.workspace.dir,
      model: 'claude-opus-5.5',
      effort: 'high',
      kiro_mode: 'spec',
    });
    assert.equal(result.model, 'claude-opus-5.5');
    assert.equal(result.effort, 'high');
    assert.equal(result.kiroMode, 'spec');
    const meta = await metaOf(fixture.stateDir, result.launchId);
    assert.equal(meta.model, 'claude-opus-5.5');
    assert.equal(meta.effort, 'high');
    assert.equal(meta.kiroMode, 'spec');
  });

  for (const [name, params, field, fragment] of [
    ['a Kiro mode it does not offer', { kiro_mode: 'turbo' }, 'kiro_mode', 'vibe, spec'],
    ['an effort with the auto model', { effort: 'high' }, 'effort', 'effortLevel'],
    ['a model it does not offer', { model: 'gpt-x' }, 'model', 'auto, claude-opus-5.5, claude-haiku-4.5'],
  ] as const) {
    test(`${name} is E_INVALID listing the offered values, after a cleanup`, PROCESS_TIMEOUT, async (t) => {
      // The default 15 s step cap: none of these waits for an offer.
      const fixture = await managerFixture(t, 'default');
      const started = performance.now();
      await assert.rejects(fixture.manager.start({ dir: fixture.workspace.dir, ...params }, { toolUseId: 'toolu_bad' }), (error) => {
        assertCode(error, 'E_INVALID', fragment);
        assert.ok((error as Error).message.startsWith(`${field} `), (error as Error).message);
        return true;
      });
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 2_000, `failed after ${Math.round(elapsed)} ms`);
      const launchId = await onlyRun(fixture);
      await assertCleanedUp(fixture, launchId);
      const call = await readCall(fixture.stateDir, 'toolu_bad');
      assert.equal((call as { failed: boolean }).failed, true);
    });
  }

  test('every argument is checked before anything is created', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const { manager, workspace, stateDir } = fixture;
    const dir = workspace.dir;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ dir, preset: 'review' }, 'preset is not available in this version'],
      [{ dir, skills: ['a'] }, 'skills is available in docker mode only in this version'],
      [{ dir, steering: ['/tmp/a.md'] }, 'steering is available in docker mode only in this version'],
      [{ dir, mounts: ['/tmp'] }, 'mounts is available in docker mode only'],
      [{ dir, prompt_file: join(dir, 'missing-task.md') }, 'prompt_file does not exist'],
      [{ dir, prompt: 'hi', prompt_file: join(dir, 'missing-task.md') }, 'prompt_file cannot be given together with prompt'],
      [{ dir: `${dir}:ro` }, 'dir with ":ro" is available in docker mode only'],
      [{ dir: 'relative/path' }, 'dir must be an absolute path'],
      [{ dir: join(dir, 'missing') }, 'dir does not exist'],
      [{ dir, prompt: '' }, 'prompt must not be empty'],
      [{ dir, label: 'has space' }, 'label'],
      [{ dir, effort: 'extreme' }, 'effort must be one of low, medium, high, xhigh, max'],
      [{ dir, permissions: 'ask' }, 'permissions must be "allow" or "deny"'],
      [{ dir, mode: 'cloud' }, 'mode must be "local" or "docker"'],
      [{ dir, image: 'kiro:latest' }, 'image is available in docker mode only'],
      [{ dir, home: '..' }, 'home must be'],
    ];
    for (const [params, fragment] of cases) {
      await assert.rejects(
        manager.start(params as never, { toolUseId: 'toolu_invalid' }),
        (error) => assertCode(error, 'E_INVALID', fragment),
        JSON.stringify(params),
      );
    }
    assert.deepEqual(await runIds(stateDir), []);
    assert.equal(await readCall(stateDir, 'toolu_invalid'), undefined);
    assert.equal(await promptsOrStart(workspace), false);
  });

  test('without api_key no start begins in either mode, whatever the server KIRO_API_KEY', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default', {
      settings: { api_key: '' },
      env: testEnvironment({ KIRO_API_KEY: 'server_inherited_key_0123456789' }),
    });
    const { manager, workspace, stateDir } = fixture;
    for (const mode of ['local', 'docker'] as const) {
      await assert.rejects(
        manager.start({ dir: workspace.dir, mode, prompt: 'hello' }, { toolUseId: 'toolu_no_token' }),
        (error) => assertCode(error, 'E_INVALID', 'api_key is not set: Kiro needs a token'),
        mode,
      );
    }
    assert.deepEqual(await runIds(stateDir), []);
    assert.equal(await readCall(stateDir, 'toolu_no_token'), undefined);
    assert.equal(await promptsOrStart(workspace), false);
  });

  test('a label is unique among live sessions', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    await fixture.manager.start({ dir: fixture.workspace.dir, label: 'twin' });
    await assert.rejects(fixture.manager.start({ dir: fixture.workspace.dir, label: 'twin' }), (error) =>
      assertCode(error, 'E_INVALID', 'already used by a live session'),
    );
    assert.equal((await runIds(fixture.stateDir)).length, 1);
  });

  test('a step timeout is E_STEP_INITIALIZE with the stderr tail, and cleans up', PROCESS_TIMEOUT, async (t) => {
    // The fake must be running before the 500 ms count, or it has written no stderr line yet.
    const fixture = await managerFixture(t, 'hang-initialize', { startLimits: { initializeMs: 500 }, waitForFakeStart: true });
    await assert.rejects(
      fixture.manager.start({ dir: fixture.workspace.dir, prompt: 'hello' }, { toolUseId: 'toolu_hang' }),
      (error) => assertCode(error, 'E_STEP_INITIALIZE', 'fixture: initialize hangs') && /within 500 ms/.test((error as Error).message),
    );
    const launchId = await onlyRun(fixture);
    await assertCleanedUp(fixture, launchId);
    const call = await readCall(fixture.stateDir, 'toolu_hang');
    const { error, ...location } = call as { error: string };
    assert.ok(error.startsWith('E_STEP_INITIALIZE'), JSON.stringify(call));
    // The failure keeps the run, the turn the start would have opened, and the driver.
    const { driver } = await metaOf(fixture.stateDir, launchId);
    assert.deepEqual(location, { launchId, turn: 1, driver, failed: true });
  });

  test('a failed session/new is E_STEP_SESSION_NEW with the stderr tail', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'fail-session-new');
    await assert.rejects(fixture.manager.start({ dir: fixture.workspace.dir }), (error) =>
      assertCode(error, 'E_STEP_SESSION_NEW', 'fixture: session/new refused'),
    );
    await assertCleanedUp(fixture, await onlyRun(fixture));
  });

  test('the start deadline caps every step', PROCESS_TIMEOUT, async (t) => {
    // The fake never answers initialize, so the deadline lands there once the steps before it are
    // done; the deadline leaves them time for that on a loaded host.
    const deadlineMs = 5_000;
    const fixture = await managerFixture(t, 'hang-initialize', { startLimits: { deadlineMs } });
    const began = performance.now();
    await assert.rejects(fixture.manager.start({ dir: fixture.workspace.dir }), (error) => {
      assertCode(error, 'E_STEP_INITIALIZE');
      // The step was given what was left of the deadline, not its own much longer limit.
      const limit = /initialize did not finish within (\d+) ms/.exec((error as Error).message)?.[1];
      assert.ok(limit !== undefined && Number(limit) <= deadlineMs, (error as Error).message);
      return true;
    });
    assert.ok(performance.now() - began < deadlineMs + 2_600, `took ${Math.round(performance.now() - began)} ms`);
    await assertCleanedUp(fixture, await onlyRun(fixture));
  });

  test('a client abort mid-start cleans up the same way', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'hang-initialize');
    const abort = new AbortController();
    const start = fixture.manager.start({ dir: fixture.workspace.dir, prompt: 'hello' }, { toolUseId: 'toolu_abort', signal: abort.signal });
    await waitFor(async () => {
      try {
        await fixture.workspace.started();
        return true;
      } catch {
        return false;
      }
    }, 'the fake to start');
    assert.equal(fixture.manager.list()[0]?.state, 'starting');
    abort.abort();
    await assert.rejects(start, (error) => assertCode(error, 'E_STEP_INITIALIZE', 'the start was aborted'));
    await assertCleanedUp(fixture, await onlyRun(fixture));
    assert.equal(((await readCall(fixture.stateDir, 'toolu_abort')) as { failed: boolean }).failed, true);
  });

  test('api_key reaches a local Kiro as KIRO_API_KEY, never the server one, with the home as KIRO_HOME', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default', {
      settings: { api_key: TEST_TOKEN },
      env: testEnvironment({ KIRO_API_KEY: 'server_inherited_key_0123456789', KIRO_HOME: '/server/kiro-home' }),
    });
    const result = await fixture.manager.start({ dir: fixture.workspace.dir });
    const started = await fixture.workspace.started();
    assert.equal(started.env['KIRO_API_KEY'], TEST_TOKEN);
    assert.equal(started.env['KIRO_HOME'], join(fixture.stateDir, 'homes', 'default'));
    assert.equal((await metaOf(fixture.stateDir, result.launchId)).tokenSource, 'api_key');
  });
});

describe('SessionManager.start in docker mode (injected docker)', () => {
  test('host checks, the docker run command and the container name', PROCESS_TIMEOUT, async (t) => {
    const specs: ProcessSpec[] = [];
    const checked: string[] = [];
    let workspaceCommand = '';
    const fixture = await managerFixture(t, 'default', {
      settings: { api_key: TEST_TOKEN },
      deps: {
        resolveDockerUser: async () => '0:0',
        checkImage: async (image) => {
          checked.push(image);
        },
        spawn: (spec, options) => {
          specs.push(spec);
          // Run the fake agent in place of `docker run`.
          return spawnProcess(
            { argv: [workspaceCommand, 'acp', '--agent-engine', 'v3'], env: testEnvironment() as Record<string, string>, cwd: spec.cwd },
            options,
          );
        },
        removeContainers: () => {},
      },
    });
    workspaceCommand = fixture.workspace.command;
    const result = await fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir, image: 'kiro-test:1' });
    assert.deepEqual(checked, ['kiro-test:1']);
    const spec = specs[0];
    assert.ok(spec !== undefined);
    assert.equal(spec.argv[0], 'docker');
    assert.equal(spec.argv[1], 'run');
    const name = `kiro-sidecar-${result.launchId.slice('ks_'.length)}`;
    assert.equal(spec.argv[spec.argv.indexOf('--name') + 1], name);
    assert.equal(spec.argv[spec.argv.indexOf('--user') + 1], '0:0');
    assert.ok(spec.argv.includes('kiro-test:1'));
    assert.equal(spec.env['KIRO_API_KEY'], TEST_TOKEN);
    assert.equal(spec.argv.some((arg) => arg.includes(TEST_TOKEN)), false);
    const meta = await metaOf(fixture.stateDir, result.launchId);
    assert.equal(meta.containerName, name);
    assert.equal(meta.dockerUser, '0:0');
    assert.equal(meta.image, 'kiro-test:1');
    assert.equal(meta.child, null);
    assert.equal(meta.state, 'idle');
  });

  test('a missing image keeps its code and spawns nothing', PROCESS_TIMEOUT, async (t) => {
    let spawned = 0;
    const fixture = await managerFixture(t, 'default', {
      settings: { api_key: TEST_TOKEN },
      deps: {
        resolveDockerUser: async () => '0:0',
        checkImage: async () => {
          throw new SidecarError('E_IMAGE_MISSING', 'Run: docker pull kiro-test:1');
        },
        spawn: () => {
          spawned += 1;
          throw new Error('must not spawn');
        },
      },
    });
    await assert.rejects(
      fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir, image: 'kiro-test:1' }, { toolUseId: 'toolu_image' }),
      (error) => assertCode(error, 'E_IMAGE_MISSING', 'docker pull'),
    );
    assert.equal(spawned, 0);
    const launchId = await onlyRun(fixture);
    assert.equal((await metaOf(fixture.stateDir, launchId)).state, 'failed');
    assert.equal(((await readCall(fixture.stateDir, 'toolu_image')) as { failed: boolean }).failed, true);
    assert.deepEqual(fixture.manager.list(), []);
  });
});

/** True when the fake was started at all. */
async function promptsOrStart(workspace: ManagerFixture['workspace']): Promise<boolean> {
  try {
    await workspace.started();
    return true;
  } catch {
    return false;
  }
}

