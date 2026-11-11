/**
 * B: the image refresh of the image check, without docker. The check's
 * docker operations are replaced by a fake (`ImageDocker`), and the Docker
 * CLI path by a `docker` script on PATH.
 */
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidecarError } from '../../src/errors.ts';
import {
  IMAGE_PULL_TIMEOUT_MS,
  PULL_RECORDS_DIR,
  PULL_RETRY_AFTER_MS,
  checkImage,
  dockerCli,
  isDigestPinned,
  pullRecordPath,
  readPullRecord,
} from '../../src/docker/image.ts';
import type { ImageCheckContext, ImageDocker, LocalImage } from '../../src/docker/image.ts';
import { isAlive, waitFor } from '../session/manager-helpers.ts';
import { removeTree } from '../helpers/processes.ts';

const IMAGE = 'example/kiro:latest';
const OLD: LocalImage = { id: 'sha256:0ld0000000000000000000000000000000000000000000000000000000000000', created: '2026-11-03T10:00:00Z' };
const NEW: LocalImage = { id: 'sha256:9e70000000000000000000000000000000000000000000000000000000000000', created: '2026-11-10T09:00:00Z' };
const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-11T08:00:00Z');

interface FakeDocker extends ImageDocker {
  local: LocalImage | null;
  pulls: number;
  inspects: number;
  /** What the next pull does: replace the local image with `NEW`, keep it, or fail with a reason. */
  next: { kind: 'replace' } | { kind: 'same' } | { kind: 'fail'; reason: string } | { kind: 'wait'; until: Promise<void> };
  readonly timeouts: number[];
}

function fakeDocker(local: LocalImage | null): FakeDocker {
  const fake: FakeDocker = {
    local,
    pulls: 0,
    inspects: 0,
    next: { kind: 'replace' },
    timeouts: [],
    inspect: async () => {
      fake.inspects += 1;
      return fake.local;
    },
    pull: async (_image, options) => {
      fake.pulls += 1;
      fake.timeouts.push(options.timeoutMs);
      const next = fake.next;
      if (next.kind === 'wait') {
        await next.until;
        fake.local = NEW;
        return;
      }
      if (next.kind === 'fail') {
        throw new SidecarError('E_DOCKER', next.reason);
      }
      if (next.kind === 'replace') {
        fake.local = NEW;
      }
    },
  };
  return fake;
}

async function stateDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kiro-sidecar-image-'));
  t.after(() => removeTree(dir));
  return dir;
}

interface Clock {
  now: number;
}

/** A context with a fake docker and clock; counts the calls through `query` and `pull`. */
function context(dir: string, docker: FakeDocker, clock: Clock, refreshHours = 24) {
  const calls = { query: 0, pull: 0 };
  const value: ImageCheckContext = {
    stateDir: dir,
    refreshHours,
    query: (work) => {
      calls.query += 1;
      return work;
    },
    pull: (work) => {
      calls.pull += 1;
      return work;
    },
    docker,
    now: () => clock.now,
  };
  return { value, calls };
}

function missing(image: string): string {
  return `Docker image ${image} is not present locally. Pull it with: docker pull ${image}`;
}

describe('image refresh: off (B1)', () => {
  test('refresh hours 0: inspect only, as before; nothing is pulled or recorded', async (t) => {
    const dir = await stateDir(t);
    const docker = fakeDocker(OLD);
    const { value, calls } = context(dir, docker, { now: T0 }, 0);
    assert.deepEqual(await checkImage(IMAGE, {}, value), { id: OLD.id, notice: null });
    assert.equal(docker.pulls, 0);
    assert.equal(calls.pull, 0);
    assert.equal(calls.query, 1, 'the inspect is bounded by the step');
    assert.deepEqual(await readdir(dir), []);
  });

  test('refresh hours 0 and absent: E_IMAGE_MISSING with the pull command, exactly as before', async (t) => {
    const dir = await stateDir(t);
    const docker = fakeDocker(null);
    await assert.rejects(checkImage(IMAGE, {}, context(dir, docker, { now: T0 }, 0).value), (error: unknown) => {
      assert.ok(error instanceof SidecarError);
      assert.equal(error.code, 'E_IMAGE_MISSING');
      assert.equal(error.message, missing(IMAGE));
      return true;
    });
    assert.equal(docker.pulls, 0);
  });

  test('without a context the check is the old one', async () => {
    // The context-free form takes the CLI; a missing CLI is E_DOCKER, as before.
    await assert.rejects(checkImage(IMAGE, { PATH: '/nonexistent-kiro-sidecar-path' }), { code: 'E_DOCKER' });
  });
});

describe('image refresh: a digest-pinned reference (B2)', () => {
  const PINNED = `example/kiro@sha256:${'a'.repeat(64)}`;

  test('is never pulled, present or absent', async (t) => {
    const dir = await stateDir(t);
    assert.equal(isDigestPinned(PINNED), true);
    assert.equal(isDigestPinned('example/kiro:sha256'), false);
    const present = fakeDocker(OLD);
    assert.deepEqual(await checkImage(PINNED, {}, context(dir, present, { now: T0 }).value), { id: OLD.id, notice: null });
    const absent = fakeDocker(null);
    await assert.rejects(checkImage(PINNED, {}, context(dir, absent, { now: T0 }).value), { code: 'E_IMAGE_MISSING', message: missing(PINNED) });
    assert.equal(present.pulls + absent.pulls, 0);
  });
});

describe('image refresh: on (B3)', () => {
  test('no record: one pull through the pull wrapper with its own 10-minute limit, then recorded', async (t) => {
    const dir = await stateDir(t);
    const docker = fakeDocker(OLD);
    docker.next = { kind: 'same' };
    const clock = { now: T0 };
    const { value, calls } = context(dir, docker, clock);
    assert.deepEqual(await checkImage(IMAGE, {}, value), { id: OLD.id, notice: null });
    assert.equal(docker.pulls, 1);
    assert.deepEqual(docker.timeouts, [IMAGE_PULL_TIMEOUT_MS]);
    assert.equal(IMAGE_PULL_TIMEOUT_MS, 600_000);
    assert.equal(calls.pull, 1);
    assert.deepEqual(await readPullRecord(dir, IMAGE), {
      reference: IMAGE,
      pulledAt: new Date(T0).toISOString(),
      failedAt: null,
      failure: null,
    });
  });

  test('a pull within the window means no pull; the first check after it pulls', async (t) => {
    const dir = await stateDir(t);
    const docker = fakeDocker(OLD);
    docker.next = { kind: 'same' };
    const clock = { now: T0 };
    await checkImage(IMAGE, {}, context(dir, docker, clock).value);
    clock.now = T0 + 24 * HOUR - 1;
    await checkImage(IMAGE, {}, context(dir, docker, clock).value);
    assert.equal(docker.pulls, 1);
    clock.now = T0 + 24 * HOUR;
    await checkImage(IMAGE, {}, context(dir, docker, clock).value);
    assert.equal(docker.pulls, 2);
  });

  test('the window follows refresh hours', async (t) => {
    const dir = await stateDir(t);
    const docker = fakeDocker(OLD);
    docker.next = { kind: 'same' };
    const clock = { now: T0 };
    await checkImage(IMAGE, {}, context(dir, docker, clock, 2).value);
    clock.now = T0 + 2 * HOUR - 1;
    await checkImage(IMAGE, {}, context(dir, docker, clock, 2).value);
    assert.equal(docker.pulls, 1);
    clock.now = T0 + 2 * HOUR;
    await checkImage(IMAGE, {}, context(dir, docker, clock, 2).value);
    assert.equal(docker.pulls, 2);
  });

  test('a record from the future does not hold refreshing off', async (t) => {
    const dir = await stateDir(t);
    await mkdir(join(dir, PULL_RECORDS_DIR));
    const future = { reference: IMAGE, pulledAt: new Date(T0 + 48 * HOUR).toISOString(), failedAt: null, failure: null };
    await writeFile(pullRecordPath(dir, IMAGE), JSON.stringify(future));
    const docker = fakeDocker(OLD);
    docker.next = { kind: 'same' };
    await checkImage(IMAGE, {}, context(dir, docker, { now: T0 }).value);
    assert.equal(docker.pulls, 1);
  });
});

describe('image refresh: a failed pull (B4)', () => {
  test('present: the start goes on with the local image, and the notice says why and which image', async (t) => {
    const dir = await stateDir(t);
    const docker = fakeDocker(OLD);
    docker.next = { kind: 'fail', reason: 'docker pull did not finish within 600000 ms' };
    const result = await checkImage(IMAGE, {}, context(dir, docker, { now: T0 }).value);
    assert.equal(result.id, OLD.id);
    assert.equal(
      result.notice,
      `The refresh of image ${IMAGE} failed (docker pull did not finish within 600000 ms); ` +
        `this start uses the local image ${OLD.id}, created ${OLD.created}.`,
    );
    const record = await readPullRecord(dir, IMAGE);
    assert.equal(record?.failedAt, new Date(T0).toISOString());
    assert.equal(record?.failure, 'docker pull did not finish within 600000 ms');
  });

  test('the reason is one short line', async (t) => {
    const dir = await stateDir(t);
    const docker = fakeDocker(OLD);
    docker.next = { kind: 'fail', reason: `line one\nline two ${'x'.repeat(1_000)}` };
    const { notice } = await checkImage(IMAGE, {}, context(dir, docker, { now: T0 }).value);
    assert.ok(notice !== null && !notice.includes('\n'), String(notice));
    assert.ok(notice.length < 600, `${notice.length} characters`);
    assert.ok(notice.includes('(line one line two xxx'), notice);
  });

  test('no new pull for an hour after a failure; the success before it is kept', async (t) => {
    const dir = await stateDir(t);
    const docker = fakeDocker(OLD);
    docker.next = { kind: 'same' };
    const clock = { now: T0 };
    await checkImage(IMAGE, {}, context(dir, docker, clock).value);
    clock.now = T0 + 25 * HOUR;
    docker.next = { kind: 'fail', reason: 'registry unreachable' };
    await checkImage(IMAGE, {}, context(dir, docker, clock).value);
    assert.equal(docker.pulls, 2);
    assert.equal((await readPullRecord(dir, IMAGE))?.pulledAt, new Date(T0).toISOString());
    clock.now = T0 + 25 * HOUR + PULL_RETRY_AFTER_MS - 1;
    assert.deepEqual(await checkImage(IMAGE, {}, context(dir, docker, clock).value), { id: OLD.id, notice: null });
    assert.equal(docker.pulls, 2);
    clock.now = T0 + 25 * HOUR + PULL_RETRY_AFTER_MS;
    docker.next = { kind: 'same' };
    await checkImage(IMAGE, {}, context(dir, docker, clock).value);
    assert.equal(docker.pulls, 3);
    assert.equal((await readPullRecord(dir, IMAGE))?.failedAt, null);
  });
});

describe('image refresh: an absent image (B5)', () => {
  test('is pulled, whatever the record says', async (t) => {
    const dir = await stateDir(t);
    const docker = fakeDocker(OLD);
    docker.next = { kind: 'same' };
    const clock = { now: T0 };
    await checkImage(IMAGE, {}, context(dir, docker, clock).value);
    docker.local = null;
    docker.next = { kind: 'replace' };
    clock.now = T0 + HOUR;
    assert.deepEqual(await checkImage(IMAGE, {}, context(dir, docker, clock).value), { id: NEW.id, notice: null });
    assert.equal(docker.pulls, 2);
  });

  test('a failed pull is E_IMAGE_MISSING with the pull command and the reason', async (t) => {
    const dir = await stateDir(t);
    const docker = fakeDocker(null);
    docker.next = { kind: 'fail', reason: 'docker pull exited with code 1: manifest unknown' };
    await assert.rejects(checkImage(IMAGE, {}, context(dir, docker, { now: T0 }).value), (error: unknown) => {
      assert.ok(error instanceof SidecarError);
      assert.equal(error.code, 'E_IMAGE_MISSING');
      assert.equal(error.message, `${missing(IMAGE)} (the pull failed: docker pull exited with code 1: manifest unknown)`);
      return true;
    });
  });

  test('within the hour after a failure it is not pulled again and says why', async (t) => {
    const dir = await stateDir(t);
    const docker = fakeDocker(null);
    docker.next = { kind: 'fail', reason: 'manifest unknown' };
    const clock = { now: T0 };
    await assert.rejects(checkImage(IMAGE, {}, context(dir, docker, clock).value), { code: 'E_IMAGE_MISSING' });
    clock.now = T0 + 10 * 60_000;
    await assert.rejects(checkImage(IMAGE, {}, context(dir, docker, clock).value), (error: unknown) => {
      assert.ok(error instanceof SidecarError);
      assert.equal(error.code, 'E_IMAGE_MISSING');
      assert.ok(error.message.startsWith(missing(IMAGE)), error.message);
      assert.ok(error.message.includes('manifest unknown'), error.message);
      return true;
    });
    assert.equal(docker.pulls, 1);
  });
});

describe('image refresh: the reply (B6)', () => {
  test('a pull that replaced the image names the old and the new id', async (t) => {
    const dir = await stateDir(t);
    const docker = fakeDocker(OLD);
    const result = await checkImage(IMAGE, {}, context(dir, docker, { now: T0 }).value);
    assert.equal(result.id, NEW.id);
    assert.equal(
      result.notice,
      `docker pull replaced image ${IMAGE}: ${OLD.id} is now ${NEW.id}; the Kiro CLI inside may have changed.`,
    );
  });

  test('a pull that changed nothing adds nothing', async (t) => {
    const dir = await stateDir(t);
    const docker = fakeDocker(OLD);
    docker.next = { kind: 'same' };
    assert.deepEqual(await checkImage(IMAGE, {}, context(dir, docker, { now: T0 }).value), { id: OLD.id, notice: null });
  });
});

describe('image refresh: the record (B7)', () => {
  test('one file per reference under the state directory, written atomically', async (t) => {
    const dir = await stateDir(t);
    const docker = fakeDocker(OLD);
    docker.next = { kind: 'same' };
    const other = 'registry.example:5000/team/kiro:2';
    await checkImage(IMAGE, {}, context(dir, docker, { now: T0 }).value);
    await checkImage(other, {}, context(dir, docker, { now: T0 }).value);
    assert.equal(docker.pulls, 2);
    const files = (await readdir(join(dir, PULL_RECORDS_DIR))).sort();
    assert.deepEqual(files, [pullRecordPath(dir, IMAGE), pullRecordPath(dir, other)].map((path) => path.split('/').pop()).sort());
    assert.ok(files.every((name) => /^[0-9a-f]{32}\.json$/.test(name)), 'no temp file is left');
    assert.equal(JSON.parse(await readFile(pullRecordPath(dir, other), 'utf8')).reference, other);
  });

  test('a missing, unreadable or foreign record counts as never pulled', async (t) => {
    const dir = await stateDir(t);
    await mkdir(join(dir, PULL_RECORDS_DIR));
    const recent = new Date(T0 - 60_000).toISOString();
    const cases: Array<string | null> = [
      'not json',
      JSON.stringify([]),
      JSON.stringify({ reference: 'someone/else:1', pulledAt: recent, failedAt: null, failure: null }),
      JSON.stringify({ reference: IMAGE, pulledAt: 42, failedAt: null, failure: null }),
      JSON.stringify({ reference: IMAGE, pulledAt: 'yesterday', failedAt: null, failure: null }),
      null,
    ];
    let pulls = 0;
    for (const content of cases) {
      const path = pullRecordPath(dir, IMAGE);
      await removeTree(path);
      if (content === null) {
        // A directory in its place: reading it fails.
        await mkdir(path);
      } else {
        await writeFile(path, content);
      }
      const docker = fakeDocker(OLD);
      docker.next = { kind: 'same' };
      await checkImage(IMAGE, {}, context(dir, docker, { now: T0 }).value);
      pulls += docker.pulls;
    }
    assert.equal(pulls, cases.length);
  });

  test('starts at the same time in one process share one pull', async (t) => {
    const dir = await stateDir(t);
    const docker = fakeDocker(OLD);
    let release: () => void = () => {};
    docker.next = { kind: 'wait', until: new Promise<void>((resolve) => (release = resolve)) };
    const clock = { now: T0 };
    const checks = [1, 2, 3].map(() => checkImage(IMAGE, {}, context(dir, docker, clock).value));
    await waitFor(() => docker.pulls === 1, 'the pull to start');
    release();
    const results = await Promise.all(checks);
    assert.equal(docker.pulls, 1);
    for (const result of results) {
      assert.equal(result.id, NEW.id);
      assert.ok(result.notice?.includes(`${OLD.id} is now ${NEW.id}`), String(result.notice));
    }
    // Once it has ended, a later start finds the record.
    await checkImage(IMAGE, {}, context(dir, docker, clock).value);
    assert.equal(docker.pulls, 1);
  });
});

describe('image refresh: the Docker CLI (B3, B4)', () => {
  /** A directory holding a `docker` script that does what `body` says; returns a PATH with it. */
  async function fakeCli(t: TestContext, body: string): Promise<{ PATH: string; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'kiro-sidecar-docker-cli-'));
    t.after(() => removeTree(dir));
    const script = join(dir, 'docker');
    await writeFile(script, `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst dir = ${JSON.stringify(dir)};\n${body}\n`);
    await chmod(script, 0o755);
    return { PATH: dir, dir };
  }

  test('inspect reads the id and the creation date; "no such image" is absent', async (t) => {
    const cli = await fakeCli(
      t,
      `if (args[4].endsWith(':gone')) { process.stderr.write('Error: No such image: x\\n'); process.exit(1); }
       process.stdout.write('${OLD.id} ${OLD.created}\\n');`,
    );
    const docker = dockerCli({ PATH: cli.PATH, CLAUDE_SECRET: 'x' });
    assert.deepEqual(await docker.inspect(IMAGE), OLD);
    assert.equal(await docker.inspect('example/kiro:gone'), null);
  });

  test('pull runs docker pull --quiet <reference>; a failure gives the exit code and stderr', async (t) => {
    const cli = await fakeCli(
      t,
      `require('node:fs').writeFileSync(dir + '/args.json', JSON.stringify(args));
       process.stderr.write('Error response from daemon: manifest unknown\\n'); process.exit(1);`,
    );
    const docker = dockerCli({ PATH: cli.PATH });
    await assert.rejects(docker.pull(IMAGE, { timeoutMs: 10_000, signal: undefined }), {
      message: 'docker pull exited with code 1: Error response from daemon: manifest unknown',
    });
    assert.deepEqual(JSON.parse(await readFile(join(cli.dir, 'args.json'), 'utf8')), ['pull', '--quiet', IMAGE]);
  });

  test('a pull that runs out of time is ended', async (t) => {
    const cli = await fakeCli(
      t,
      `require('node:fs').writeFileSync(dir + '/pid', String(process.pid)); setInterval(() => {}, 60_000);`,
    );
    const docker = dockerCli({ PATH: cli.PATH });
    await assert.rejects(docker.pull(IMAGE, { timeoutMs: 500, signal: undefined }), { message: /did not finish within 500 ms/ });
    const pid = Number(await readFile(join(cli.dir, 'pid'), 'utf8'));
    await waitFor(() => !isAlive(pid), 'the pull process to end');
  });

  test('a pull whose signal aborts (the server shuts down) is ended', async (t) => {
    const cli = await fakeCli(
      t,
      `require('node:fs').writeFileSync(dir + '/pid', String(process.pid)); setInterval(() => {}, 60_000);`,
    );
    const docker = dockerCli({ PATH: cli.PATH });
    const abort = new AbortController();
    const pulling = docker.pull(IMAGE, { timeoutMs: 60_000, signal: abort.signal });
    await waitFor(async () => (await readFile(join(cli.dir, 'pid'), 'utf8').catch(() => '')) !== '', 'the pull to start');
    abort.abort();
    await assert.rejects(pulling, { message: /aborted/ });
    const pid = Number(await readFile(join(cli.dir, 'pid'), 'utf8'));
    await waitFor(() => !isAlive(pid), 'the pull process to end');
  });
});
