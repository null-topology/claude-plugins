import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { LookupError } from '../../src/broker/lookup.ts';
import type { AccountClient } from '../../src/broker/onepassword.ts';
import { createPool, mapError, PoolError, type PoolOptions } from '../../src/broker/pool.ts';
import { FakeClock, flush } from './clock.ts';

const MIN = 60_000;

/** Records every SDK call (connect included) as start/end, and whether two ever overlapped. */
class Recorder {
  active = 0;
  overlapped = false;
  events: string[] = [];
  connects: string[] = [];
  pings = new Map<string, number>();

  async call<T>(label: string, body: () => Promise<T>): Promise<T> {
    if (this.active > 0) this.overlapped = true;
    this.active += 1;
    this.events.push(`start ${label}`);
    try {
      return await body();
    } finally {
      this.active -= 1;
      this.events.push(`end ${label}`);
    }
  }
}

function setup(overrides: Partial<PoolOptions> = {}, clock = new FakeClock()) {
  const rec = new Recorder();
  let stuck = 0;
  let owned = true;
  const client = (account: string): AccountClient => ({
    listVaults: () =>
      rec.call(`${account} ping`, async () => {
        rec.pings.set(account, (rec.pings.get(account) ?? 0) + 1);
        return [];
      }),
    listItems: async () => [],
    getItem: async () => {
      throw new Error('unused');
    },
  });
  const pool = createPool({
    connect: (account) =>
      rec.call(`${account} connect`, async () => {
        rec.connects.push(account);
        await Promise.resolve();
        return client(account);
      }),
    owns: () => owned,
    onStuck: () => {
      stuck += 1;
    },
    clock,
    keepAliveIntervalMs: 1e12,
    ...overrides,
  });
  return {
    pool,
    rec,
    clock,
    stuck: () => stuck,
    disown: () => {
      owned = false;
    },
  };
}

/** An operation that takes `ms` of fake time, recorded under `label`. */
function slow(rec: Recorder, clock: FakeClock, label: string, ms: number) {
  return () => rec.call(label, () => new Promise<string>((resolve) => clock.setTimeout(() => resolve(label), ms)));
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof PoolError, `expected a PoolError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

describe('queue', () => {
  test('runs for two accounts never overlap, connect included, in FIFO order', async () => {
    const { pool, rec, clock } = setup();
    const results = Promise.all([
      pool.run('A', slow(rec, clock, 'A op1', 1000)),
      pool.run('B', slow(rec, clock, 'B op1', 500)),
      pool.run('A', slow(rec, clock, 'A op2', 10)),
    ]);
    await clock.advance(5000);
    assert.deepEqual(await results, ['A op1', 'B op1', 'A op2']);
    assert.equal(rec.overlapped, false);
    assert.deepEqual(rec.events, [
      'start A connect',
      'end A connect',
      'start A op1',
      'end A op1',
      'start B connect',
      'end B connect',
      'start B op1',
      'end B op1',
      'start A op2',
      'end A op2',
    ]);
    assert.deepEqual(rec.connects, ['A', 'B'], 'one client per account');
  });

  test('a cached stale account still waits its turn', async () => {
    const { pool, rec, clock } = setup();
    await pool.run('A', async () => 'warm');
    await clock.advance(30 * MIN);
    const both = Promise.all([pool.run('B', slow(rec, clock, 'B op', 2000)), pool.run('A', slow(rec, clock, 'A op', 10))]);
    await clock.advance(10_000);
    await both;
    assert.equal(rec.overlapped, false);
    assert.deepEqual(rec.connects, ['A', 'B']);
    assert.ok(rec.events.indexOf('start A op') > rec.events.indexOf('end B op'));
  });

  test('a failure answers its caller and the queue moves on', async () => {
    const { pool, clock } = setup();
    const failing = pool.run('A', async () => {
      throw new Error('boom');
    });
    const failed = rejectsWithCode(failing, 'internal');
    const next = pool.run('A', async () => 'next');
    await clock.advance(10);
    await failed;
    assert.equal(await next, 'next');
  });
});

describe('client cache', () => {
  test('an SDK failure drops the client, so the next run connects again', async () => {
    const { pool, rec } = setup();
    await pool.run('A', async () => 1);
    await rejectsWithCode(
      pool.run('A', async () => {
        throw new Error('IPC operation failed: -3');
      }),
      'integration_off',
    );
    await pool.run('A', async () => 2);
    assert.deepEqual(rec.connects, ['A', 'A']);
  });

  test('a failed connect caches nothing', async () => {
    let attempts = 0;
    const { pool } = setup({
      connect: async () => {
        attempts += 1;
        throw new Error('Denied authorization');
      },
    });
    await rejectsWithCode(pool.run('A', async () => 1), 'auth_denied');
    await rejectsWithCode(pool.run('A', async () => 1), 'auth_denied');
    assert.equal(attempts, 2);
  });

  test('a lookup miss keeps the client and passes its code through', async () => {
    const { pool, rec } = setup();
    await rejectsWithCode(
      pool.run('A', async () => {
        throw new LookupError('not_found', 'No vault "X" in this account');
      }),
      'not_found',
    );
    await pool.run('A', async () => 1);
    assert.deepEqual(rec.connects, ['A']);
  });

  test('accounts() lists cached clients, warm while the last success is under 8 minutes old', async () => {
    const { pool, clock } = setup();
    await pool.run('A', async () => 1);
    await clock.advance(5 * MIN);
    await pool.run('B', async () => 1);
    assert.deepEqual(pool.accounts(), [
      { account: 'A', warm: true },
      { account: 'B', warm: true },
    ]);
    await clock.advance(4 * MIN);
    assert.deepEqual(pool.accounts(), [
      { account: 'A', warm: false },
      { account: 'B', warm: true },
    ]);
  });
});

describe('keep-alive', () => {
  test('pings every 4 minutes while warm, and not after a 30 minute sleep', async () => {
    const { pool, rec, clock } = setup({ keepAliveIntervalMs: 4 * MIN });
    await pool.run('A', async () => 1);
    await clock.advance(4 * MIN);
    assert.equal(rec.pings.get('A'), 1, 'pinged at 4 min');
    await clock.advance(4 * MIN);
    assert.equal(rec.pings.get('A'), 2, 'pinged at 8 min: the 4 min ping refreshed the window');
    await clock.sleep(30 * MIN);
    await clock.advance(4 * MIN);
    assert.equal(rec.pings.get('A'), 2, 'an expired authorization is not pinged');
    assert.deepEqual(rec.connects, ['A'], 'the old client is kept for the next real request');
    pool.close();
  });

  test('a ping enqueued at 7 min 50 s behind a 20 s operation is skipped at the head of the queue', async () => {
    const { pool, rec, clock } = setup();
    await pool.run('A', async () => 1);
    await clock.advance(7 * MIN + 50_000);
    const other = pool.run('B', slow(rec, clock, 'B op', 20_000));
    await flush();
    pool.tick();
    await clock.advance(30_000);
    await other;
    assert.equal(rec.pings.get('A'), undefined);
    assert.equal(rec.overlapped, false);
  });

  test('one tick enqueues at most one ping per account', async () => {
    const { pool, rec, clock } = setup();
    await pool.run('A', async () => 1);
    const blocker = pool.run('B', slow(rec, clock, 'B op', 1000));
    await flush();
    pool.tick();
    pool.tick();
    await clock.advance(2000);
    await blocker;
    assert.equal(rec.pings.get('A'), 1);
  });

  test('a failed ping drops the client', async () => {
    const clock = new FakeClock();
    let fail = false;
    let connects = 0;
    const pool = createPool({
      connect: async () => {
        connects += 1;
        return {
          listVaults: async () => {
            if (fail) throw new Error('Denied authorization');
            return [];
          },
          listItems: async () => [],
          getItem: async () => {
            throw new Error('unused');
          },
        };
      },
      owns: () => true,
      onStuck: () => {},
      clock,
      keepAliveIntervalMs: 4 * MIN,
    });
    await pool.run('A', async () => 1);
    fail = true;
    await clock.advance(4 * MIN);
    assert.deepEqual(pool.accounts(), []);
    fail = false;
    await pool.run('A', async () => 1);
    assert.equal(connects, 2);
    pool.close();
  });
});

describe('timeout', () => {
  test('a pending operation answers auth_timeout after 120 s, calls onStuck once and starts nothing more', async () => {
    const { pool, rec, clock, stuck } = setup();
    const hung = rejectsWithCode(
      pool.run('A', () => rec.call('A hung', () => new Promise(() => {}))),
      'auth_timeout',
    );
    const queued = pool.run('B', async () => 'never');
    let queuedSettled = false;
    queued.then(
      () => (queuedSettled = true),
      () => (queuedSettled = true),
    );
    await clock.advance(119_000);
    assert.equal(stuck(), 0);
    await clock.advance(1000);
    await hung;
    assert.equal(stuck(), 1);
    await clock.advance(10 * MIN);
    assert.equal(stuck(), 1);
    assert.equal(queuedSettled, false, 'the queue does not advance past a stuck operation');
    assert.deepEqual(rec.connects, ['A'], 'B never connected');
    await rejectsWithCode(pool.run('C', async () => 1), 'auth_timeout');
    assert.deepEqual(rec.connects, ['A']);
  });

  test('the timeout covers connect, where the authorization prompt waits', async () => {
    const clock = new FakeClock();
    let stuck = 0;
    const pool = createPool({
      connect: () => new Promise(() => {}),
      owns: () => true,
      onStuck: () => {
        stuck += 1;
      },
      clock,
      keepAliveIntervalMs: 1e12,
    });
    const run = rejectsWithCode(
      pool.run('A', async () => 1),
      'auth_timeout',
    );
    await clock.advance(120_000);
    await run;
    assert.equal(stuck, 1);
  });
});

describe('ownership', () => {
  test('owns() false fails displaced without touching the SDK', async () => {
    const { pool, rec, disown } = setup();
    disown();
    let called = false;
    await rejectsWithCode(
      pool.run('A', async () => {
        called = true;
      }),
      'displaced',
    );
    assert.equal(called, false);
    assert.deepEqual(rec.events, []);
  });

  test('ownership is checked before each operation, not once', async () => {
    const { pool, rec, clock, disown } = setup();
    const first = pool.run('A', slow(rec, clock, 'A op', 1000));
    const second = rejectsWithCode(
      pool.run('A', async () => 'second'),
      'displaced',
    );
    await flush();
    disown();
    await clock.advance(1000);
    assert.equal(await first, 'A op');
    await second;
  });
});

describe('abort', () => {
  test('answers every queued run, refuses new ones and leaves the running one alone', async () => {
    const { pool, rec, clock } = setup();
    const running = pool.run('A', slow(rec, clock, 'A op', 1000));
    const queued = pool.run('B', async () => 1);
    await flush();
    pool.abort('displaced', 'another broker took over');
    await rejectsWithCode(queued, 'displaced');
    await rejectsWithCode(pool.run('C', async () => 1), 'displaced');
    await clock.advance(1000);
    assert.equal(await running, 'A op');
    assert.deepEqual(rec.connects, ['A']);
  });
});

describe('mapError', () => {
  test('maps the 1Password app failures', () => {
    const integration = mapError(new Error('IPC operation failed: -3'));
    assert.equal(integration.code, 'integration_off');
    assert.match(integration.message, /Turn on 1Password > Settings > Developer > Integrate with 1Password SDKs/);
    assert.equal(mapError(new Error('error: Denied authorization by user')).code, 'auth_denied');
    assert.equal(mapError(new Error('1Password desktop application not found')).code, 'no_app');
    assert.equal(mapError(new Error('Native library is not available.')).code, 'no_app');
  });

  test('passes a lookup error through and calls anything else internal', () => {
    assert.deepEqual(mapError(new LookupError('ambiguous', 'two')), { code: 'ambiguous', message: 'two' });
    const other = mapError(new Error('something odd'));
    assert.equal(other.code, 'internal');
    assert.match(other.message, /something odd/);
    assert.equal(mapError('not an error').code, 'internal');
  });
});

describe('busy and drop', () => {
  test('busy() holds while an operation runs or waits; drop() forgets the clients, so the next run connects again', async () => {
    const { pool, rec, clock } = setup();
    assert.equal(pool.busy(), false);
    const first = pool.run('A', slow(rec, clock, 'A op', 1000));
    const second = pool.run('A', async () => 2);
    await flush();
    assert.equal(pool.busy(), true);
    await clock.advance(1000);
    assert.equal(await first, 'A op');
    assert.equal(await second, 2);
    assert.equal(pool.busy(), false);
    assert.deepEqual(pool.accounts().map((a) => a.account), ['A']);
    pool.drop();
    assert.deepEqual(pool.accounts(), []);
    assert.equal(await pool.run('A', async () => 3), 3);
    assert.deepEqual(rec.connects, ['A', 'A']);
  });
});
