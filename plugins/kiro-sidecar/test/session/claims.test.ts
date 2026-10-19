import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { AcpClientError } from '../../src/acp/errors.ts';
import { SidecarError } from '../../src/errors.ts';
import { TurnClaims, isoSeconds, readClaimHolder } from '../../src/session/claims.ts';
import { currentDriver } from '../../src/store/identity.ts';
import { SessionMutex } from '../../src/session/mutex.ts';
import { decideOutcome } from '../../src/session/outcome.ts';
import { runPaths, turnPaths } from '../../src/store/paths.ts';
import { createRun } from '../../src/store/runs.ts';
import { tempDir } from '../helpers/processes.ts';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('TurnClaims', () => {
  test('the marker exists before claim resolves and stays until the last holder releases', async (t) => {
    const stateDir = await tempDir(t);
    const { launchId } = await createRun(stateDir);
    const claims = new TurnClaims(stateDir);
    const marker = turnPaths(stateDir, launchId, 1).claimed;

    const [releaseA, releaseB] = await Promise.all([claims.claim(launchId, 1), claims.claim(launchId, 1)]);
    assert.equal(await exists(marker), true);
    assert.equal(claims.holders(launchId, 1), 2);
    await releaseA();
    await releaseA();
    assert.equal(await exists(marker), true, 'the second holder keeps the marker');
    assert.equal(claims.holders(launchId, 1), 1);
    await releaseB();
    assert.equal(await exists(marker), false);
    assert.equal(claims.holders(launchId, 1), 0);
  });

  test('the marker records when and by which server process the turn was claimed', async (t) => {
    const stateDir = await tempDir(t);
    const { launchId } = await createRun(stateDir);
    const marker = turnPaths(stateDir, launchId, 1).claimed;

    const release = await new TurnClaims(stateDir).claim(launchId, 1);
    const content = JSON.parse(await readFile(marker, 'utf8')) as { at: string; holder: unknown };
    assert.match(content.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(content.holder, await currentDriver());
    assert.deepEqual(await readClaimHolder(marker), await currentDriver());
    await release();
    assert.equal(await readClaimHolder(marker), undefined);
  });

  test('a marker without a readable holder reads as recording none', async (t) => {
    const stateDir = await tempDir(t);
    const { launchId } = await createRun(stateDir);
    const marker = turnPaths(stateDir, launchId, 1).claimed;
    await mkdir(runPaths(stateDir, launchId).turns, { recursive: true });
    for (const content of ['{"at":"2026-10-18T01:00:00Z"}\n', '{}\n', '', '{"at":', '{"holder":{"pid":0}}', 'null']) {
      await writeFile(marker, content);
      assert.equal(await readClaimHolder(marker), null, JSON.stringify(content));
    }
  });

  test('a claim right after the last release writes the marker again', async (t) => {
    const stateDir = await tempDir(t);
    const { launchId } = await createRun(stateDir);
    const claims = new TurnClaims(stateDir);
    const marker = turnPaths(stateDir, launchId, 2).claimed;
    const first = await claims.claim(launchId, 2);
    const releasing = first();
    const second = await claims.claim(launchId, 2);
    await releasing;
    assert.equal(await exists(marker), true);
    await second();
    assert.equal(await exists(marker), false);
  });

  test('a claim that cannot write its marker rejects and holds nothing', async (t) => {
    const stateDir = await tempDir(t);
    const claims = new TurnClaims(stateDir);
    await assert.rejects(claims.claim('ks_0123456789ab', 1));
    assert.equal(claims.holders('ks_0123456789ab', 1), 0);
  });

  test('a claim that joins a marker write that fails rejects too and holds nothing', async (t) => {
    const stateDir = await tempDir(t);
    const { launchId } = await createRun(stateDir);
    const turns = runPaths(stateDir, launchId).turns;
    const marker = turnPaths(stateDir, launchId, 1).claimed;
    await rm(turns, { recursive: true });
    const claims = new TurnClaims(stateDir);

    const settled = await Promise.allSettled([claims.claim(launchId, 1), claims.claim(launchId, 1)]);
    assert.deepEqual(settled.map((claim) => claim.status), ['rejected', 'rejected']);
    assert.equal(await exists(marker), false);
    assert.equal(claims.holders(launchId, 1), 0);

    await mkdir(turns);
    const release = await claims.claim(launchId, 1);
    assert.equal(await exists(marker), true, 'a later claim writes the marker');
    assert.equal(claims.holders(launchId, 1), 1);
    await release();
    assert.equal(await exists(marker), false);
  });

  test('markReturned writes the marker once', async (t) => {
    const stateDir = await tempDir(t);
    const { launchId } = await createRun(stateDir);
    const claims = new TurnClaims(stateDir);
    await claims.markReturned(launchId, 3);
    const path = turnPaths(stateDir, launchId, 3).returned;
    const first = await readFile(path, 'utf8');
    await claims.markReturned(launchId, 3);
    assert.equal(await readFile(path, 'utf8'), first);
    assert.match(JSON.parse(first).at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  test('isoSeconds drops the milliseconds', () => {
    assert.equal(isoSeconds(new Date('2026-10-18T00:31:23.456Z')), '2026-10-18T00:31:23Z');
  });
});

describe('SessionMutex', () => {
  test('a second call on the same session is E_BUSY at once; other sessions are free', async () => {
    const mutex = new SessionMutex();
    let release: () => void = () => {};
    const first = mutex.run('ks_000000000001', 'send', () => new Promise<string>((resolve) => {
      release = () => resolve('first');
    }));
    await assert.rejects(mutex.run('ks_000000000001', 'stop', async () => 'second'), (error) => {
      assert.ok(error instanceof SidecarError);
      assert.equal(error.code, 'E_BUSY');
      assert.ok(error.message.includes('send'), error.message);
      return true;
    });
    assert.equal(await mutex.run('ks_000000000002', 'send', async () => 'other'), 'other');
    release();
    assert.equal(await first, 'first');
    assert.equal(mutex.holder('ks_000000000001'), undefined);
    assert.equal(await mutex.run('ks_000000000001', 'send', async () => 'again'), 'again');
  });

  test('the mutex is released when the body throws', async () => {
    const mutex = new SessionMutex();
    await assert.rejects(mutex.run('ks_000000000001', 'send', async () => {
      throw new Error('boom');
    }));
    assert.equal(mutex.holder('ks_000000000001'), undefined);
  });
});

describe('decideOutcome', () => {
  test('stop reasons', () => {
    for (const reason of ['end_turn', 'refusal', 'max_tokens', 'max_turn_requests']) {
      assert.deepEqual(decideOutcome({ kind: 'stop', stopReason: reason }, 'cancel'), {
        outcome: reason,
        endedBy: null,
        error: null,
      });
    }
    assert.deepEqual(decideOutcome({ kind: 'stop', stopReason: 'cancelled' }, null), {
      outcome: 'cancelled',
      endedBy: null,
      error: null,
    });
    assert.deepEqual(decideOutcome({ kind: 'stop', stopReason: 'cancelled' }, 'interrupt'), {
      outcome: 'cancelled',
      endedBy: 'interrupt',
      error: null,
    });
    assert.deepEqual(decideOutcome({ kind: 'stop', stopReason: 'cancelled' }, 'stop'), {
      outcome: 'stopped',
      endedBy: 'stop',
      error: null,
    });
    assert.equal(decideOutcome({ kind: 'stop', stopReason: 'later' }, null).outcome, 'error');
  });

  test('failures', () => {
    const closed = (closeReason: 'exited' | 'message_too_large' | 'terminated' | 'stream_closed') =>
      new AcpClientError('closed', `closed: ${closeReason}`, { closeReason });
    assert.equal(decideOutcome({ kind: 'failure', error: closed('exited') }, null).outcome, 'exited');
    assert.equal(decideOutcome({ kind: 'failure', error: closed('stream_closed') }, null).outcome, 'exited');
    assert.equal(decideOutcome({ kind: 'failure', error: closed('terminated') }, null).outcome, 'exited');
    assert.equal(decideOutcome({ kind: 'failure', error: closed('message_too_large') }, null).outcome, 'error');
    assert.deepEqual(decideOutcome({ kind: 'failure', error: closed('terminated') }, 'stop'), {
      outcome: 'stopped',
      endedBy: 'stop',
      error: null,
    });
    assert.equal(decideOutcome({ kind: 'failure', error: closed('exited') }, 'stop').outcome, 'stopped');
    assert.equal(decideOutcome({ kind: 'failure', error: closed('stream_closed') }, 'stop').outcome, 'stopped');
    assert.equal(decideOutcome({ kind: 'failure', error: closed('message_too_large') }, 'stop').outcome, 'error');
    assert.equal(decideOutcome({ kind: 'failure', error: closed('exited') }, 'cancel').outcome, 'exited');
    const rejected = decideOutcome({ kind: 'failure', error: new Error('rejected') }, null);
    assert.equal(rejected.outcome, 'error');
    assert.equal(rejected.error, 'rejected');
  });
});
