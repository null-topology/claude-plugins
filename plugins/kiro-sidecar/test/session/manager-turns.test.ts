import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnProcess } from '../../src/acp/process.ts';
import { SidecarError } from '../../src/errors.ts';
import { currentOwner, ownerKey } from '../../src/store/identity.ts';
import type { ProcessIdentity } from '../../src/store/identity.ts';
import { acquireRunLock } from '../../src/store/lock.ts';
import { createRun, readCall, writeMeta } from '../../src/store/runs.ts';
import type { RunMeta } from '../../src/store/runs.ts';
import { InvalidInputError } from '../../src/text/errors.ts';
import { deadIdentity, startIdleProcess } from '../helpers/processes.ts';
import {
  ESCAPED_TOKEN,
  ESCAPED_TOKEN_ENCODED_LOWER,
  PROCESS_TIMEOUT,
  TEST_TOKEN,
  endedTurn,
  isAlive,
  managerFixture,
  metaOf,
  promptsReceived,
  testEnvironment,
  turnResultOf,
  waitFor,
} from './manager-helpers.ts';

function assertCode(error: unknown, code: string, fragment?: string): boolean {
  assert.ok(error instanceof SidecarError || error instanceof InvalidInputError, `unexpected ${String(error)}`);
  assert.equal(error.code, code, error.message);
  if (fragment !== undefined) {
    assert.ok(error.message.includes(fragment), error.message);
  }
  return true;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('SessionManager turns', () => {
  test('stop reasons map to their outcomes; send opens the next turn of an idle session', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'stop-reason');
    const { manager, stateDir } = fixture;
    const started = await manager.start({ dir: fixture.workspace.dir, prompt: 'end_turn' });
    const { launchId } = started;
    assert.equal((await endedTurn(fixture, launchId, 1)).outcome, 'end_turn');

    const reasons = ['refusal', 'max_tokens', 'max_turn_requests', 'cancelled'] as const;
    for (const [index, reason] of reasons.entries()) {
      const turn = index + 2;
      const sent = await manager.send({ launchId, text: reason }, { toolUseId: `toolu_send_${turn}` });
      assert.equal(sent.turn, turn);
      assert.equal(sent.trailer, `kiro-turn: ${launchId}#${turn}`);
      assert.equal(sent.sessionId, started.sessionId);
      assert.deepEqual(await readCall(stateDir, `toolu_send_${turn}`), {
        launchId,
        turn,
        driver: (await metaOf(stateDir, launchId)).driver,
      });
      const result = await endedTurn(fixture, launchId, turn);
      assert.equal(result.outcome, reason);
      assert.equal(result.endedBy, null);
      assert.equal(result.error, null);
      assert.equal(result.stderrTail, null);
      assert.equal(result.final, `stopping with ${reason}`);
      assert.equal((await metaOf(stateDir, launchId)).state, 'idle');
    }
    const meta = await metaOf(stateDir, launchId);
    assert.equal(meta.currentTurn, 5);
    assert.equal(meta.firstPromptPreview, 'end_turn');
    assert.deepEqual(fixture.errors, []);
  });

  test('a rejected prompt ends the turn as error; the session stays idle', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'prompt-error');
    const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: 'go' });
    const result = await endedTurn(fixture, launchId, 1);
    assert.equal(result.outcome, 'error');
    assert.ok(result.error?.includes('fixture prompt failure'), String(result.error));
    assert.equal(result.final, 'partial answer');
    assert.equal(fixture.manager.get(launchId)?.state, 'idle');
    assert.equal((await metaOf(fixture.stateDir, launchId)).state, 'idle');
  });

  test('a process that dies mid-turn ends it exited, with the error and the stderr tail', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'crash-mid-turn');
    const { manager, stateDir } = fixture;
    const { launchId } = await manager.start({ dir: fixture.workspace.dir, prompt: 'go' });
    const result = await endedTurn(fixture, launchId, 1);
    assert.equal(result.outcome, 'exited');
    assert.notEqual(result.error, null);
    assert.ok(result.stderrTail?.includes('fixture: fatal error mid-turn'), String(result.stderrTail));
    assert.equal(result.toolCalls, 1);
    assert.equal(result.lastTool, 'Run Command');
    assert.equal((await metaOf(stateDir, launchId)).state, 'exited');
    assert.equal(manager.get(launchId), undefined);
    assert.equal(await exists(join(stateDir, 'runs', launchId, 'lock')), false);
    await assert.rejects(manager.send({ launchId, text: 'again' }), (error) =>
      assertCode(error, 'E_INVALID', 'is exited; the session has ended, start a new session'),
    );
  });

  test('own-tool calls reach the turn result; failed, open and non-string calls record nothing', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'harness');
    const steps = [
      { tool: 'send_message', args: { text: 'First message.' }, end: 'completed' },
      { tool: 'send_message', args: { text: 'Failed message.' }, end: 'failed' },
      { tool: 'send_message', args: { text: 42 }, end: 'completed' },
      { tool: 'complete_task', args: { result: 'The task is done.' }, end: 'completed' },
      { tool: 'complete_task', args: { result: 'Done once more.' }, end: 'completed' },
      { tool: 'send_message', args: { text: 'Wrong tool id.' }, end: 'completed', toolId: 'other::send_message' },
      { tool: 'send_message', args: { text: 'Second message.' }, end: 'completed' },
      { tool: 'send_message', args: { text: 'Left open.' }, end: 'open' },
    ];
    const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: `own-tools ${JSON.stringify(steps)}` });
    const result = await endedTurn(fixture, launchId, 1);
    assert.equal(result.outcome, 'end_turn');
    assert.deepEqual(result.messages, ['First message.', 'Second message.']);
    assert.equal(result.messagesDropped, 0);
    assert.equal(result.completion?.result, 'The task is done.');
    assert.ok(result.completion !== null && result.completion.at >= result.startedAt && result.completion.at <= result.endedAt);
    assert.equal(result.toolCalls, steps.length);
    assert.equal(result.lastTool, '@sidecar/send_message');
    const log = await readFile(join(fixture.stateDir, 'runs', launchId, 'acp.jsonl'), 'utf8');
    assert.equal(log.split('\n').filter((line) => line.includes('"event":"complete_task_ignored"')).length, 1);
  });

  async function echoSecret(t: Parameters<typeof managerFixture>[0], debug: boolean, token = TEST_TOKEN) {
    const fixture = await managerFixture(t, 'secret-echo', { settings: { api_key: token, debug_acp: debug } });
    const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: 'echo' });
    const result = await endedTurn(fixture, launchId, 1);
    await fixture.manager.shutdown();
    await fixture.manager.settled();
    const runDir = join(fixture.stateDir, 'runs', launchId);
    return {
      result,
      text: await readFile(join(runDir, 'turns', '1.md'), 'utf8'),
      acp: await readFile(join(runDir, 'acp.jsonl'), 'utf8'),
      stderr: await readFile(join(runDir, 'stderr.log'), 'utf8'),
      json: await readFile(join(runDir, 'turns', '1.json'), 'utf8'),
    };
  }

  test('a secret split across chunks never reaches .md, acp.jsonl, stderr.log or the result', PROCESS_TIMEOUT, async (t) => {
    const { result, text, acp, stderr, json } = await echoSecret(t, false);
    for (const [name, content] of [['md', text], ['acp.jsonl', acp], ['stderr.log', stderr], ['json', json]] as const) {
      assert.equal(content.includes(TEST_TOKEN), false, `${name} holds the token`);
      assert.equal(content.includes(TEST_TOKEN.slice(0, 17)), false, `${name} holds half of the token`);
    }
    assert.ok(text.includes('The token is [REDACTED].'), text);
    assert.ok(stderr.includes('fixture: token [REDACTED]'), stderr);
    assert.equal(acp.includes('The token is'), false, 'acp.jsonl holds no message text without debug_acp');
    assert.deepEqual(result.messages, ['Is the token [REDACTED] right?']);
  });

  test('debug frames are redacted per frame', PROCESS_TIMEOUT, async (t) => {
    const { acp } = await echoSecret(t, true);
    // The second chunk carries the whole token; a token split across two
    // frames can survive in debug frames, which the setting documents.
    assert.ok(acp.includes('"event":"frame"'), 'debug frames are logged');
    assert.ok(acp.includes('Is the token [REDACTED] right?'), 'the frame with the whole token is redacted');
    assert.equal(acp.includes(TEST_TOKEN), false);
  });

  test('a URL-encoded secret with mixed-case escapes never reaches .md, acp.jsonl, stderr.log or the result', PROCESS_TIMEOUT, async (t) => {
    const { result, text, acp, stderr, json } = await echoSecret(t, false, ESCAPED_TOKEN);
    for (const [name, content] of [['md', text], ['acp.jsonl', acp], ['stderr.log', stderr], ['json', json]] as const) {
      const lower = content.toLowerCase();
      assert.equal(content.includes(ESCAPED_TOKEN), false, `${name} holds the token`);
      assert.equal(lower.includes(ESCAPED_TOKEN_ENCODED_LOWER), false, `${name} holds the encoded token`);
      assert.equal(lower.includes(ESCAPED_TOKEN_ENCODED_LOWER.slice(0, 20)), false, `${name} holds half of the encoded token`);
    }
    assert.ok(text.includes('The encoded token is [REDACTED].'), text);
    assert.ok(stderr.includes('fixture: token [REDACTED] or [REDACTED]'), stderr);
    assert.deepEqual(result.messages, ['Is the token [REDACTED] or [REDACTED] right?']);
  });

  test('debug frames redact a URL-encoded secret with mixed-case escapes', PROCESS_TIMEOUT, async (t) => {
    const { acp } = await echoSecret(t, true, ESCAPED_TOKEN);
    assert.ok(acp.includes('Is the token [REDACTED] or [REDACTED] right?'), 'the frame with the whole encoded token is redacted');
    assert.equal(acp.toLowerCase().includes(ESCAPED_TOKEN_ENCODED_LOWER), false);
  });
});

describe('SessionManager: processes a local Kiro started', () => {
  /** True when `pid` has ended: no such process, or a zombie nobody has reaped yet. */
  async function isGone(pid: number): Promise<boolean> {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z');
    } catch {
      return !isAlive(pid);
    }
  }

  test('stop ends a process the local Kiro left running', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    await writeFile(join(fixture.workspace.dir, 'fake-leave-grandchild'), '');
    const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir });
    const grandchild = Number(await readFile(join(fixture.workspace.dir, 'fake-grandchild.pid'), 'utf8'));
    t.after(() => {
      if (isAlive(grandchild)) {
        process.kill(grandchild, 'SIGKILL');
      }
    });
    assert.equal(await isGone(grandchild), false);
    await fixture.manager.stop({ launchId });
    await waitFor(() => isGone(grandchild), 'the process the agent left', 3_000);
  });
});

describe('SessionManager.send', () => {
  test('empty text is E_INVALID', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir });
    await assert.rejects(fixture.manager.send({ launchId, text: '' }), (error) => assertCode(error, 'E_INVALID', 'text'));
  });

  test('send during a running turn is E_BUSY and no second prompt reaches the agent', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'cancel-tool');
    const { manager, workspace } = fixture;
    const { launchId } = await manager.start({ dir: workspace.dir, prompt: 'run a long tool' });
    await waitFor(async () => (await promptsReceived(workspace)) === 1, 'the first prompt');
    await waitFor(() => manager.get(launchId)?.runningTurn?.toolCalls === 1, 'the tool call');
    await assert.rejects(manager.send({ launchId, text: 'second', }, { toolUseId: 'toolu_busy' }), (error) =>
      assertCode(error, 'E_BUSY', 'running turn 1'),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await promptsReceived(workspace), 1);
    assert.equal(await readCall(fixture.stateDir, 'toolu_busy'), undefined);
    const live = manager.get(launchId);
    assert.equal(live?.state, 'running');
    assert.equal(live?.runningTurn?.lastTool, 'Run Command');
  });

  test('send while the session is starting is E_BUSY', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'hang-initialize', { startLimits: { initializeMs: 2_000 } });
    const start = fixture.manager.start({ dir: fixture.workspace.dir });
    await waitFor(() => fixture.manager.list().length === 1, 'the starting session');
    const launchId = fixture.manager.list()[0]?.launchId as string;
    await assert.rejects(fixture.manager.send({ launchId, text: 'hi' }), (error) => assertCode(error, 'E_BUSY', 'starting'));
    await assert.rejects(start, (error) => assertCode(error, 'E_STEP_INITIALIZE'));
  });

  test('a send that overlaps another on the same session is E_BUSY at once', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const { manager, workspace } = fixture;
    const { launchId } = await manager.start({ dir: workspace.dir });
    const first = manager.send({ launchId, text: 'one' });
    const began = performance.now();
    await assert.rejects(manager.send({ launchId, text: 'two' }), (error) => assertCode(error, 'E_BUSY', 'busy with another send'));
    assert.ok(performance.now() - began < 50, 'the second call did not wait');
    assert.equal((await first).turn, 1);
    await endedTurn(fixture, launchId, 1);
    assert.equal(await promptsReceived(workspace), 1);
  });

  describe('ids this manager does not drive', () => {
    async function seedRun(
      stateDir: string,
      owner: ProcessIdentity,
      patch: Partial<RunMeta>,
    ): Promise<string> {
      const { launchId } = await createRun(stateDir);
      const driver = await deadIdentity();
      const attempt = await acquireRunLock(stateDir, launchId, (await startIdleProcessIdentity()));
      assert.ok(attempt.acquired);
      const now = '2026-10-18T00:00:00Z';
      const meta: RunMeta = {
        launchId, kiroSessionId: 'sess_seeded', ownerKey: ownerKey(owner), driver, home: 'default', projectDir: null,
        label: null, mode: 'local', dir: '/tmp', dirReadOnly: false, mounts: [], skills: [], steering: [], model: null,
        effort: null, kiroMode: null, permissions: 'allow', preset: null, tokenSource: null, image: null,
        dockerUser: null, containerName: null, child: null, state: 'exited', currentTurn: 1, firstPromptPreview: null,
        createdAt: now, updatedAt: now, ...patch,
      };
      await writeMeta(attempt.lock, meta);
      await attempt.lock.release();
      return launchId;
    }

    let idleOwner: Awaited<ReturnType<typeof startIdleProcess>> | undefined;
    async function startIdleProcessIdentity(): Promise<ProcessIdentity> {
      idleOwner ??= await startIdleProcess();
      return idleOwner.identity;
    }

    test('the state and owner decide the answer', PROCESS_TIMEOUT, async (t) => {
      t.after(async () => idleOwner?.stop());
      const fixture = await managerFixture(t, 'default');
      const { manager, stateDir } = fixture;
      const own = await currentOwner();
      const live = await startIdleProcessIdentity();
      const dead = await deadIdentity();
      const send = (launchId: string) => manager.send({ launchId, text: 'hi' });

      await assert.rejects(send('ks_0123456789ab'), (error) => assertCode(error, 'E_NOT_FOUND'));
      for (const state of ['exited', 'stopped', 'lost', 'failed'] as const) {
        const id = await seedRun(stateDir, own, { state });
        await assert.rejects(send(id), (error) =>
          assertCode(error, 'E_INVALID', `is ${state}; the session has ended, start a new session`),
        );
      }
      const failed = await seedRun(stateDir, own, { state: 'failed', kiroSessionId: null });
      await assert.rejects(send(failed), (error) => assertCode(error, 'E_INVALID', 'failed to start'));
      const ownIdle = await seedRun(stateDir, own, { state: 'idle' });
      await assert.rejects(send(ownIdle), (error) => assertCode(error, 'E_INVALID', 'is lost'));
      const ownDriven = await seedRun(stateDir, own, { state: 'idle', driver: live });
      await assert.rejects(send(ownDriven), (error) => assertCode(error, 'E_OWNED', 'another server process'));
      const otherLive = await seedRun(stateDir, live, { state: 'idle', driver: live });
      await assert.rejects(send(otherLive), (error) => assertCode(error, 'E_OWNED', 'another Claude session'));
      const otherHome = await seedRun(stateDir, live, { state: 'idle', home: 'elsewhere' });
      await assert.rejects(send(otherHome), (error) => assertCode(error, 'E_NOT_FOUND'));
      const otherDead = await seedRun(stateDir, dead, { state: 'exited' });
      await assert.rejects(send(otherDead), (error) => assertCode(error, 'E_OWNED', 'another Claude session'));
    });
  });
});

describe('SessionManager.shutdown', () => {
  test('local children are gone and shutdown returns within 500 ms', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'cancel-tool');
    const { manager, workspace } = fixture;
    const idle = await manager.start({ dir: workspace.dir });
    const firstPid = (await workspace.started()).pid;
    const running = await manager.start({ dir: workspace.dir, prompt: 'run a long tool' });
    await waitFor(async () => (await workspace.started()).pid !== firstPid, 'the second fake');
    const secondPid = (await workspace.started()).pid;
    await waitFor(() => manager.get(running.launchId)?.runningTurn?.toolCalls === 1, 'the running tool');

    const began = performance.now();
    await manager.shutdown();
    const took = performance.now() - began;
    assert.ok(took < 500, `shutdown took ${Math.round(took)} ms`);
    await waitFor(() => !isAlive(firstPid) && !isAlive(secondPid), 'both fakes to be gone', 2_000);
    await manager.settled();
    const result = await turnResultOf(fixture.stateDir, running.launchId, 1);
    assert.equal(result.outcome, 'exited');
    assert.equal((await metaOf(fixture.stateDir, running.launchId)).state, 'exited');
    assert.equal((await metaOf(fixture.stateDir, idle.launchId)).state, 'exited');
    assert.deepEqual(manager.list(), []);
    await assert.rejects(manager.start({ dir: workspace.dir }), (error) => assertCode(error, 'E_BUSY', 'shutting down'));
  });

  test('when shutdown returns, a running turn has its result and every run is exited', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'cancel-tool');
    const { manager, stateDir, workspace } = fixture;
    const idle = await manager.start({ dir: workspace.dir });
    const firstPid = (await workspace.started()).pid;
    const running = await manager.start({ dir: workspace.dir, prompt: 'run a long tool' });
    await waitFor(async () => (await workspace.started()).pid !== firstPid, 'the second fake');
    await waitFor(() => manager.get(running.launchId)?.runningTurn?.toolCalls === 1, 'the running tool');

    const began = performance.now();
    await manager.shutdown();
    const took = performance.now() - began;
    // Read synchronously, before any other work can run: the server exits right here.
    const runDir = join(stateDir, 'runs', running.launchId);
    const turns = readdirSync(join(runDir, 'turns'));
    const resultText = turns.includes('1.json') ? readFileSync(join(runDir, 'turns', '1.json'), 'utf8') : null;
    const runningState = (JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as { state: string }).state;
    const idleState = (
      JSON.parse(readFileSync(join(stateDir, 'runs', idle.launchId, 'meta.json'), 'utf8')) as { state: string }
    ).state;

    assert.ok(took < 500, `shutdown took ${Math.round(took)} ms`);
    assert.notEqual(resultText, null, `turns/ holds ${turns.join(', ')}`);
    const result = JSON.parse(resultText ?? '{}') as { outcome: string; endedBy: string | null; error: string | null };
    assert.equal(result.outcome, 'exited');
    assert.equal(result.endedBy, null);
    assert.match(String(result.error), /server shut down/);
    assert.deepEqual(turns.filter((name) => name.endsWith('.tmp')), []);
    assert.equal(runningState, 'exited');
    assert.equal(idleState, 'exited');
    assert.deepEqual(fixture.errors, []);
  });

  test('docker sessions get one detached removal of their containers', PROCESS_TIMEOUT, async (t) => {
    const removed: string[][] = [];
    let command = '';
    const fixture = await managerFixture(t, 'default', {
      settings: { api_key: TEST_TOKEN },
      deps: {
        resolveDockerUser: async () => '0:0',
        checkImage: async () => {},
        spawn: (spec, options) =>
          spawnProcess(
            { argv: [command, 'acp', '--agent-engine', 'v3'], env: testEnvironment() as Record<string, string>, cwd: spec.cwd },
            options,
          ),
        removeContainers: (names) => {
          removed.push([...names]);
        },
      },
    });
    command = fixture.workspace.command;
    const a = await fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir });
    const b = await fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir });
    const began = performance.now();
    await fixture.manager.shutdown();
    assert.ok(performance.now() - began < 500);
    const names = [a.launchId, b.launchId].map((id) => `kiro-sidecar-${id.slice('ks_'.length)}`);
    assert.deepEqual(removed, [names]);
  });
});
