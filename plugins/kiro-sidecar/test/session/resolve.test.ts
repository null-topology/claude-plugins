import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SidecarError } from '../../src/errors.ts';
import { ownerKey } from '../../src/store/identity.ts';
import { runPaths, runsDir } from '../../src/store/paths.ts';
import { createRun } from '../../src/store/runs.ts';
import { resolveSession, scanVisibleRuns } from '../../src/session/resolve.ts';
import { InvalidInputError } from '../../src/text/errors.ts';
import { deadIdentity, startIdleProcess, tempDir } from '../helpers/processes.ts';
import {
  HOME,
  OTHER_HOST_DRIVER,
  liveSession,
  makeDeps,
  nextCreatedAt,
  writeRun,
} from './helpers-runs.ts';

function isCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof SidecarError || error instanceof InvalidInputError, String(error));
    assert.equal(error.code, code, error.message);
    return true;
  };
}

describe('session resolution', () => {
  test('a launch id names its run', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const meta = await writeRun(stateDir);
    await writeRun(stateDir);
    const run = await resolveSession(deps, meta.launchId);
    assert.equal(run.launchId, meta.launchId);
    assert.equal(run.relation, 'own');
    assert.equal(run.state, 'idle');
    assert.equal(run.live, null);
  });

  test('a Kiro session id names its run', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    await writeRun(stateDir, { kiroSessionId: 'sess-first' });
    const meta = await writeRun(stateDir, { kiroSessionId: 'sess-second' });
    const run = await resolveSession(deps, 'sess-second');
    assert.equal(run.launchId, meta.launchId);
  });

  test('a label prefers the own live session over a newer finished one', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const live = await writeRun(stateDir, { label: 'review', state: 'idle' });
    await writeRun(stateDir, { label: 'review', state: 'stopped' });
    const run = await resolveSession(deps, 'review');
    assert.equal(run.launchId, live.launchId);
  });

  test('a label without a live session resolves to the latest one', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    await writeRun(stateDir, { label: 'review', state: 'stopped' });
    const latest = await writeRun(stateDir, { label: 'review', state: 'exited' });
    await writeRun(stateDir, { label: 'other', state: 'idle' });
    const run = await resolveSession(deps, 'review');
    assert.equal(run.launchId, latest.launchId);
  });

  test('a label whose own live session died resolves to the latest one', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const dead = await deadIdentity();
    await writeRun(stateDir, { label: 'review', state: 'idle', driver: dead });
    const latest = await writeRun(stateDir, { label: 'review', state: 'stopped' });
    const run = await resolveSession(deps, 'review');
    assert.equal(run.launchId, latest.launchId);
  });

  test('a label with two own live sessions is E_INVALID listing both', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const first = await writeRun(stateDir, { label: 'review', state: 'idle' });
    const second = await writeRun(stateDir, { label: 'review', state: 'running' });
    const finished = await writeRun(stateDir, { label: 'review', state: 'stopped' });
    await assert.rejects(resolveSession(deps, 'review'), (error: unknown) => {
      isCode('E_INVALID')(error);
      const { message } = error as Error;
      assert.match(message, new RegExp(first.launchId));
      assert.match(message, new RegExp(second.launchId));
      assert.doesNotMatch(message, new RegExp(finished.launchId));
      return true;
    });
  });

  test('a label whose latest sessions tie is E_INVALID listing the tied ones', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const older = await writeRun(stateDir, { label: 'review', state: 'stopped' });
    const createdAt = nextCreatedAt();
    const a = await writeRun(stateDir, { label: 'review', state: 'stopped', createdAt });
    const b = await writeRun(stateDir, { label: 'review', state: 'exited', createdAt });
    await assert.rejects(resolveSession(deps, 'review'), (error: unknown) => {
      isCode('E_INVALID')(error);
      const { message } = error as Error;
      assert.match(message, new RegExp(a.launchId));
      assert.match(message, new RegExp(b.launchId));
      assert.doesNotMatch(message, new RegExp(older.launchId));
      return true;
    });
  });

  test('the live registry decides the state of an own session it drives', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, registry } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, { state: 'idle' });
    registry.put(liveSession(meta.launchId, { state: 'running', currentTurn: 1 }));
    const run = await resolveSession(deps, meta.launchId);
    assert.equal(run.state, 'running');
    assert.equal(run.live?.currentTurn, 1);
  });

  test('a run of another home answers E_NOT_FOUND like one that does not exist', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const foreign = await writeRun(stateDir, {
      home: 'another-home',
      ownerKey: 'pid-1-1@elsewhere',
      kiroSessionId: 'sess-foreign',
      label: 'foreign',
    });
    const { launchId: missing } = await createRun(stateDir);
    const messages: string[] = [];
    for (const session of [foreign.launchId, 'sess-foreign', 'foreign', missing, 'nothing']) {
      await assert.rejects(resolveSession(deps, session), (error: unknown) => {
        isCode('E_NOT_FOUND')(error);
        messages.push((error as Error).message.replace(session, '<id>'));
        return true;
      });
    }
    assert.equal(new Set(messages).size, 1, messages.join(' | '));
  });

  test('an own run is visible whatever home it uses', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, { home: 'another-home' });
    const run = await resolveSession(deps, meta.launchId);
    assert.equal(run.relation, 'own');
  });

  test('another owner of the same home is same-home; its dead driver reads as lost', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const owner = await startIdleProcess();
    t.after(() => owner.stop());
    const dead = await deadIdentity();
    const meta = await writeRun(stateDir, {
      ownerKey: ownerKey(owner.identity),
      driver: dead,
      state: 'running',
    });
    const run = await resolveSession(deps, meta.launchId);
    assert.equal(run.relation, 'same-home');
    assert.equal(run.state, 'lost');
    assert.equal(run.live, null);
  });

  test('a record of another host is read-only and keeps its recorded state', async (t) => {
    const stateDir = await tempDir(t);
    const { deps, registry } = makeDeps(stateDir);
    const meta = await writeRun(stateDir, {
      ownerKey: `pid-4242-777@${OTHER_HOST_DRIVER.hostId}`,
      driver: OTHER_HOST_DRIVER,
      state: 'running',
      label: 'far',
    });
    registry.put(liveSession(meta.launchId, { state: 'stopped' }));
    const run = await resolveSession(deps, 'far');
    assert.equal(run.relation, 'other-host');
    assert.equal(run.state, 'running');
    assert.equal(run.live, null);
  });

  test('runs with a missing or invalid meta.json are skipped', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    const good = await writeRun(stateDir);
    const { launchId: empty } = await createRun(stateDir);
    const { launchId: broken } = await createRun(stateDir);
    await writeFile(runPaths(stateDir, broken).meta, '{"launchId": ', 'utf8');
    const { launchId: invalid } = await createRun(stateDir);
    await writeFile(runPaths(stateDir, invalid).meta, '{"launchId": "x"}\n', 'utf8');
    await writeFile(join(runsDir(stateDir), 'not-a-run'), 'x', 'utf8');
    const runs = await scanVisibleRuns(deps);
    assert.deepEqual(
      runs.map((run) => run.launchId),
      [good.launchId],
    );
    for (const launchId of [empty, broken, invalid]) {
      await assert.rejects(resolveSession(deps, launchId), isCode('E_NOT_FOUND'));
    }
  });

  test('a state directory without runs resolves nothing', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    assert.deepEqual(await scanVisibleRuns(deps), []);
    await assert.rejects(resolveSession(deps, 'review'), isCode('E_NOT_FOUND'));
  });

  test('a session argument that is not a non-empty string is E_INVALID', async (t) => {
    const stateDir = await tempDir(t);
    const { deps } = makeDeps(stateDir);
    for (const session of ['', undefined, 42, null]) {
      await assert.rejects(resolveSession(deps, session), (error: unknown) => {
        isCode('E_INVALID')(error);
        assert.equal((error as InvalidInputError).field, 'session');
        return true;
      });
    }
  });

  test('the home of the scope is the one compared', async (t) => {
    const stateDir = await tempDir(t);
    const meta = await writeRun(stateDir, { ownerKey: 'pid-1-1@elsewhere', home: HOME });
    const { deps } = makeDeps(stateDir, { home: 'another-home' });
    await assert.rejects(resolveSession(deps, meta.launchId), isCode('E_NOT_FOUND'));
  });
});
