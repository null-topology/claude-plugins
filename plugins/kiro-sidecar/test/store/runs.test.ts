import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../src/store/files.ts';
import { currentDriver, currentOwner, ownerKey } from '../../src/store/identity.ts';
import type { ProcessIdentity } from '../../src/store/identity.ts';
import { acquireRunLock } from '../../src/store/lock.ts';
import type { RunLock } from '../../src/store/lock.ts';
import { callsDir, runPaths } from '../../src/store/paths.ts';
import {
  RUN_STATES,
  appendClaudeSession,
  createRun,
  createTurnResult,
  ensureHome,
  ensureRunCopyDirs,
  observedState,
  parseRunMeta,
  readCall,
  readClaudeSessions,
  readMeta,
  readTurnResult,
  recordCall,
  recordCallFailure,
  writeMeta,
} from '../../src/store/runs.ts';
import type { RunMeta, RunState } from '../../src/store/runs.ts';
import { deadIdentity, tempDir } from '../helpers/processes.ts';

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function sampleMeta(launchId: string, overrides: Partial<RunMeta> = {}): Promise<RunMeta> {
  return {
    launchId,
    kiroSessionId: null,
    ownerKey: ownerKey(await currentOwner()),
    driver: await currentDriver(),
    home: 'default',
    projectDir: '/work/app',
    label: 'review',
    mode: 'docker',
    dir: '/work/app',
    dirReadOnly: false,
    mounts: ['/work/notes:ro'],
    skills: ['code-review'],
    steering: ['/work/app/steering.md'],
    model: 'example-model',
    effort: 'high',
    kiroMode: null,
    permissions: 'allow',
    preset: null,
    tokenSource: 'api_key',
    image: 'example/kiro-image:1.2.3',
    dockerUser: 'auto',
    containerName: `kiro-${launchId}`,
    child: null,
    state: 'starting',
    currentTurn: 0,
    firstPromptPreview: 'Review the change',
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
    ...overrides,
  };
}

async function lockedRun(t: Parameters<typeof tempDir>[0]) {
  const stateDir = await tempDir(t);
  const { launchId, paths } = await createRun(stateDir);
  const attempt = await acquireRunLock(stateDir, launchId);
  assert.ok(attempt.acquired);
  return { stateDir, launchId, paths, lock: attempt.lock };
}

describe('runs', () => {
  test('a new run gets a fresh launch id and private directories', async (t) => {
    const stateDir = await tempDir(t);
    const first = await createRun(stateDir);
    const second = await createRun(stateDir);
    assert.match(first.launchId, /^ks_[0-9a-f]{12}$/);
    assert.notEqual(first.launchId, second.launchId);
    assert.deepEqual(first.paths, runPaths(stateDir, first.launchId));
    for (const dir of [join(stateDir, 'runs'), first.paths.dir, first.paths.turns]) {
      assert.equal(await modeOf(dir), 0o700, dir);
    }
  });

  test('a home gets empty skills and steering directories', async (t) => {
    const stateDir = await tempDir(t);
    const home = await ensureHome(stateDir, '-work-app-70467eff');
    assert.equal(home.dir, join(stateDir, 'homes', '-work-app-70467eff'));
    for (const dir of [join(stateDir, 'homes'), home.dir, home.skills, home.steering]) {
      assert.equal(await modeOf(dir), 0o700, dir);
    }
    assert.deepEqual(await readdir(home.skills), []);
    assert.deepEqual(await readdir(home.steering), []);
    await assert.rejects(ensureHome(stateDir, '..'), TypeError);
    await assert.rejects(ensureHome(stateDir, '.'), TypeError);
  });

  test('preparing a home again keeps its session store and its skills', async (t) => {
    const stateDir = await tempDir(t);
    const home = await ensureHome(stateDir, 'default');
    const session = join(home.dir, 'sessions', 'cli', 'earlier.json');
    const skill = join(home.skills, 'lint', 'SKILL.md');
    await mkdir(join(home.dir, 'sessions', 'cli'), { recursive: true });
    await writeFile(session, '{"id":"earlier"}\n');
    await mkdir(join(home.skills, 'lint'));
    await writeFile(skill, '# Lint\n');
    assert.deepEqual(await ensureHome(stateDir, 'default'), home);
    assert.equal(await readFile(session, 'utf8'), '{"id":"earlier"}\n');
    assert.equal(await readFile(skill, 'utf8'), '# Lint\n');
    assert.deepEqual(await readdir(home.steering), []);
  });

  test('a home path that is a file is refused, and the file is left alone', async (t) => {
    const stateDir = await tempDir(t);
    await mkdir(join(stateDir, 'homes'));
    await writeFile(join(stateDir, 'homes', 'default'), 'not a directory\n');
    await assert.rejects(ensureHome(stateDir, 'default'));
    assert.equal(await readFile(join(stateDir, 'homes', 'default'), 'utf8'), 'not a directory\n');
  });
});

describe('run copy directories', () => {
  test('a run gets empty skills and steering directories, and preparing them again keeps their content', async (t) => {
    const stateDir = await tempDir(t);
    const launchId = 'ks_0123456789ab';
    const paths = await ensureRunCopyDirs(stateDir, launchId);
    assert.equal(paths.skills, join(stateDir, 'runs', launchId, 'skills'));
    assert.equal(paths.steering, join(stateDir, 'runs', launchId, 'steering'));
    for (const dir of [join(stateDir, 'runs', launchId), paths.skills, paths.steering]) {
      assert.equal(await modeOf(dir), 0o700, dir);
    }
    assert.deepEqual(await readdir(paths.skills), []);
    assert.deepEqual(await readdir(paths.steering), []);
    await writeFile(join(paths.steering, 'style.md'), 'Use short sentences.\n');
    await ensureRunCopyDirs(stateDir, launchId);
    assert.equal(await readFile(join(paths.steering, 'style.md'), 'utf8'), 'Use short sentences.\n');
    await assert.rejects(ensureRunCopyDirs(stateDir, 'ks_0123'), TypeError);
  });
});

describe('meta.json', () => {
  test('the lock holder writes it and a reader gets it back', async (t) => {
    const { stateDir, launchId, paths, lock } = await lockedRun(t);
    assert.equal(await readMeta(stateDir, launchId), undefined);
    const meta = await sampleMeta(launchId);
    await writeMeta(lock, meta);
    assert.deepEqual(await readMeta(stateDir, launchId), meta);
    assert.equal(await modeOf(paths.meta), 0o600);
    const updated = { ...meta, state: 'idle' as const, kiroSessionId: 'session-1', currentTurn: 1 };
    await writeMeta(lock, updated);
    assert.deepEqual(await readMeta(stateDir, launchId), updated);
    const completed = { ...updated, state: 'completed' as const };
    await writeMeta(lock, completed);
    assert.deepEqual(await readMeta(stateDir, launchId), completed);
    await writeMeta(lock, updated);
    assert.deepEqual((await readdir(paths.dir)).sort(), ['lock', 'meta.json', 'turns']);
  });

  test('a write without the held lock is refused', async (t) => {
    const { stateDir, launchId, paths, lock } = await lockedRun(t);
    const meta = await sampleMeta(launchId);

    const forged = { stateDir, launchId, path: paths.lock, holder: lock.holder } as unknown as RunLock;
    await assert.rejects(writeMeta(forged, meta), /needs the held run lock/);

    const other = await createRun(stateDir);
    await assert.rejects(writeMeta(lock, await sampleMeta(other.launchId)), /does not cover/);

    const taken: ProcessIdentity = { ...lock.holder, startTime: 'another' };
    await writeJsonAtomic(paths.lock, taken);
    await assert.rejects(writeMeta(lock, meta), /no longer held/);
    await writeJsonAtomic(paths.lock, lock.holder);

    await lock.release();
    await assert.rejects(writeMeta(lock, meta), /released/);
    assert.equal(await readMeta(stateDir, launchId), undefined);
  });

  test('malformed metadata is neither written nor read', async (t) => {
    const { stateDir, launchId, paths, lock } = await lockedRun(t);
    const meta = await sampleMeta(launchId);
    const bad = { ...meta, state: 'paused' } as unknown as RunMeta;
    await assert.rejects(writeMeta(lock, bad), /bad field state/);
    await writeJsonAtomic(paths.meta, { ...meta, currentTurn: -1 });
    await assert.rejects(readMeta(stateDir, launchId), /bad field currentTurn/);
    assert.throws(() => parseRunMeta([]), /not an object/);
    const { mounts: _mounts, ...missing } = meta;
    assert.throws(() => parseRunMeta(missing), /bad field mounts/);
  });
});

describe('observed state', () => {
  test('idle or running with a dead driver is lost', async () => {
    const dead = await deadIdentity();
    const meta = await sampleMeta('ks_0123456789ab', { driver: dead });
    for (const state of RUN_STATES) {
      const expected: RunState = state === 'idle' || state === 'running' ? 'lost' : state;
      assert.equal(await observedState({ ...meta, state }), expected, state);
    }
  });

  test('a live driver or one on another host keeps the recorded state', async () => {
    const live = await sampleMeta('ks_0123456789ab');
    const dead = await deadIdentity();
    const remote = await sampleMeta('ks_0123456789ab', {
      driver: { ...dead, hostId: 'elsewhere:boot:1' },
    });
    for (const state of ['idle', 'running'] as const) {
      assert.equal(await observedState({ ...live, state }), state);
      assert.equal(await observedState({ ...remote, state }), state);
    }
  });
});

describe('call records', () => {
  test('a call is recorded once, then replaced by its failure', async (t) => {
    const stateDir = await tempDir(t);
    const driver = await currentDriver();
    const first = { launchId: 'ks_0123456789ab', turn: 1, driver };
    assert.equal(await recordCall(stateDir, 'toolu_01', first), true);
    assert.equal(await recordCall(stateDir, 'toolu_01', { ...first, turn: 2 }), false);
    assert.deepEqual(await readCall(stateDir, 'toolu_01'), first);
    assert.equal(await modeOf(join(callsDir(stateDir), 'toolu_01.json')), 0o600);
    assert.equal(await modeOf(callsDir(stateDir)), 0o700);

    await recordCallFailure(stateDir, 'toolu_01', 'E_STEP_spawn: no such file');
    assert.deepEqual(await readCall(stateDir, 'toolu_01'), {
      failed: true,
      error: 'E_STEP_spawn: no such file',
    });
    assert.deepEqual(await readdir(callsDir(stateDir)), ['toolu_01.json']);
  });

  test('a call that opened no turn records a null turn', async (t) => {
    const stateDir = await tempDir(t);
    const record = { launchId: 'ks_0123456789ab', turn: null, driver: await currentDriver() };
    assert.equal(await recordCall(stateDir, 'toolu_02', record), true);
    assert.deepEqual(await readCall(stateDir, 'toolu_02'), record);
    assert.equal(await readCall(stateDir, 'toolu_03'), undefined);
  });

  test('a failure keeps the run, turn and driver of the record it replaces', async (t) => {
    const stateDir = await tempDir(t);
    const driver = await currentDriver();
    for (const [id, turn] of [
      ['toolu_04', 2],
      ['toolu_05', null],
    ] as const) {
      const record = { launchId: 'ks_0123456789ab', turn, driver };
      assert.equal(await recordCall(stateDir, id, record), true);
      await recordCallFailure(stateDir, id, 'E_CANCEL_TIMEOUT: the turn did not end', record);
      const expected = { ...record, failed: true, error: 'E_CANCEL_TIMEOUT: the turn did not end' };
      assert.deepEqual(JSON.parse(await readFile(join(callsDir(stateDir), `${id}.json`), 'utf8')), expected);
      assert.deepEqual(await readCall(stateDir, id), expected);
    }
  });

  test('a failure written without its run, turn and driver still reads as failed', async (t) => {
    const stateDir = await tempDir(t);
    await mkdir(callsDir(stateDir), { recursive: true });
    await writeJsonAtomic(join(callsDir(stateDir), 'toolu_06.json'), { failed: true, error: 'E_STEP_spawn: no such file' });
    assert.deepEqual(await readCall(stateDir, 'toolu_06'), { failed: true, error: 'E_STEP_spawn: no such file' });
    const invalid = { launchId: 'not-a-launch', turn: 1, driver: await currentDriver(), failed: true, error: 'E_STEP_spawn' };
    await writeJsonAtomic(join(callsDir(stateDir), 'toolu_07.json'), invalid);
    assert.deepEqual(await readCall(stateDir, 'toolu_07'), { failed: true, error: 'E_STEP_spawn' });
  });

  test('an invalid tool use id writes nothing', async (t) => {
    const stateDir = await tempDir(t);
    const record = { launchId: 'ks_0123456789ab', turn: 1, driver: await currentDriver() };
    for (const id of ['', '../escape', 'a.b', 'x'.repeat(129)]) {
      await assert.rejects(recordCall(stateDir, id, record), TypeError, id);
      await assert.rejects(recordCallFailure(stateDir, id, 'error'), TypeError, id);
    }
    assert.deepEqual(await readdir(stateDir), []);
  });
});

describe('claude-sessions.jsonl', () => {
  test('entries are appended as lines and read back in order', async (t) => {
    const stateDir = await tempDir(t);
    const { launchId, paths } = await createRun(stateDir);
    await appendClaudeSession(stateDir, launchId, { id: 'session-a', event: 'start', at: '2026-10-18T01:00:00.000Z' });
    await appendClaudeSession(stateDir, launchId, {
      id: 'session-b',
      event: 'clear',
      at: '2026-10-18T02:00:00.000Z',
      agentType: 'reviewer',
    });
    const now = await appendClaudeSession(stateDir, launchId, { id: 'session-b', event: 'wake' });
    assert.ok(!Number.isNaN(Date.parse(now.at)));

    const text = await readFile(paths.claudeSessions, 'utf8');
    assert.deepEqual(text.trimEnd().split('\n').slice(0, 2), [
      '{"id":"session-a","event":"start","at":"2026-10-18T01:00:00.000Z"}',
      '{"id":"session-b","event":"clear","at":"2026-10-18T02:00:00.000Z","agentType":"reviewer"}',
    ]);
    assert.equal(await modeOf(paths.claudeSessions), 0o600);
    assert.deepEqual(await readClaudeSessions(stateDir, launchId), [
      { id: 'session-a', event: 'start', at: '2026-10-18T01:00:00.000Z' },
      { id: 'session-b', event: 'clear', at: '2026-10-18T02:00:00.000Z', agentType: 'reviewer' },
      now,
    ]);
  });

  test('a cut-off last line is skipped and a missing log is empty', async (t) => {
    const stateDir = await tempDir(t);
    const { launchId, paths } = await createRun(stateDir);
    assert.deepEqual(await readClaudeSessions(stateDir, launchId), []);
    await appendClaudeSession(stateDir, launchId, { id: 'session-a', event: 'start', at: '2026-10-18T01:00:00.000Z' });
    await appendFile(paths.claudeSessions, '{"id":"session-b","ev');
    assert.deepEqual(await readClaudeSessions(stateDir, launchId), [
      { id: 'session-a', event: 'start', at: '2026-10-18T01:00:00.000Z' },
    ]);
  });
});

describe('turn results', () => {
  test('a turn result is created once and the first one stays', async (t) => {
    const stateDir = await tempDir(t);
    const { launchId, paths } = await createRun(stateDir);
    assert.equal(await readTurnResult(stateDir, launchId, 1), undefined);
    assert.equal(await createTurnResult(stateDir, launchId, 1, { outcome: 'end_turn' }), true);
    assert.equal(await createTurnResult(stateDir, launchId, 1, { outcome: 'lost' }), false);
    assert.deepEqual(await readTurnResult(stateDir, launchId, 1), { outcome: 'end_turn' });
    assert.equal(await modeOf(join(paths.turns, '1.json')), 0o600);
    assert.deepEqual(await readdir(paths.turns), ['1.json']);
  });
});
