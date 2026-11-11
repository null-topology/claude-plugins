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
  /** Accounts whose pings hang until the test settles them through `held`. */
  hold = new Set<string>();
  held = new Map<string, { resolve(): void; reject(err: Error): void }>();

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
  const hung: string[] = [];
  const client = (account: string): AccountClient => ({
    listVaults: () =>
      rec.call(`${account} ping`, async () => {
        rec.pings.set(account, (rec.pings.get(account) ?? 0) + 1);
        if (rec.hold.has(account)) {
          await new Promise<void>((resolve, reject) => rec.held.set(account, { resolve, reject }));
        }
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
    onHungPing: (stage, result) => {
      hung.push(`${stage} ${result}`);
    },
    clock,
    keepAliveIntervalMs: 1e12,
    ...overrides,
  });
  return {
    pool,
    rec,
    clock,
    hung,
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

/** Whether a promise has settled yet, without letting its rejection go unhandled. */
function track(promise: Promise<unknown>): { settled(): boolean } {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  return { settled: () => settled };
}

describe('a keep-alive ping that does not return', () => {
  test('is given up after 120 s without onStuck or a refusal, and logged twice', async () => {
    const { pool, rec, clock, stuck, hung } = setup();
    await pool.run('A', async () => 1);
    rec.hold.add('A');
    pool.tick();
    await clock.advance(119_000);
    assert.equal(rec.pings.get('A'), 1, 'the ping is running');
    assert.deepEqual(hung, []);
    await clock.advance(1000);
    assert.deepEqual(hung, ['given_up auth_timeout']);
    await clock.advance(30 * MIN);
    assert.equal(stuck(), 0, 'a ping never calls onStuck');
    rec.held.get('A')?.resolve();
    await flush();
    assert.deepEqual(hung, ['given_up auth_timeout', 'settled ok']);
    assert.equal(await pool.run('B', async () => 'served'), 'served', 'the pool refuses nothing');
    assert.equal(stuck(), 0);
    assert.equal(rec.overlapped, false);
  });

  for (const outcome of ['ok', 'auth_denied'] as const) {
    test(`forgets the account's client at the timeout; a late ${outcome} does not bring it back`, async () => {
      const { pool, rec, clock, hung } = setup();
      await pool.run('A', async () => 1);
      await pool.run('B', async () => 1);
      rec.hold.add('A');
      pool.tick();
      await clock.advance(120_000);
      assert.deepEqual(pool.accounts(), [{ account: 'B', warm: true }], 'A is forgotten, B is kept');
      const held = rec.held.get('A');
      if (outcome === 'ok') held?.resolve();
      else held?.reject(new Error('Denied authorization'));
      await flush();
      assert.equal(hung.at(-1), `settled ${outcome}`);
      // B's ping, queued behind A's, ran once A's call freed the queue.
      assert.deepEqual(pool.accounts(), [{ account: 'B', warm: true }], 'the late outcome changes no client');
      rec.hold.clear();
      await pool.run('A', async () => 2);
      assert.deepEqual(rec.connects, ['A', 'B', 'A'], 'the next real request for A connects again');
      assert.equal(rec.overlapped, false);
    });
  }

  test('nothing starts while it is pending; when it settles the queue runs in FIFO order', async () => {
    const { pool, rec, clock, stuck } = setup();
    await pool.run('A', async () => 1);
    await pool.run('B', async () => 1);
    rec.hold.add('A');
    pool.tick();
    await clock.advance(125_000);
    const first = pool.run('A', slow(rec, clock, 'A r1', 1000));
    await clock.advance(1000);
    const second = pool.run('B', slow(rec, clock, 'B r2', 1000));
    const events = rec.events.length;
    await clock.advance(60_000);
    assert.equal(rec.events.length, events, 'no SDK call starts behind the pending ping');
    assert.equal(rec.active, 1, 'only the ping is in flight');
    rec.held.get('A')?.resolve();
    await clock.advance(10_000);
    assert.equal(await first, 'A r1');
    assert.equal(await second, 'B r2');
    assert.deepEqual(rec.events.slice(events - 1), [
      'start A ping',
      'end A ping',
      'start B ping',
      'end B ping',
      'start A connect',
      'end A connect',
      'start A r1',
      'end A r1',
      'start B r2',
      'end B r2',
    ]);
    assert.equal(stuck(), 0);
    assert.equal(rec.overlapped, false);
  });

  test('a request queued while it runs fails auth_timeout 120 s after it was queued and takes the stuck path', async () => {
    const { pool, rec, clock, stuck } = setup();
    await pool.run('A', async () => 1);
    rec.hold.add('A');
    pool.tick();
    await clock.advance(30_000);
    const request = pool.run('A', async () => 'never');
    const state = track(request);
    await clock.advance(119_000);
    assert.equal(state.settled(), false, 'still waiting at 149 s');
    assert.equal(stuck(), 0);
    await clock.advance(1000);
    await rejectsWithCode(request, 'auth_timeout');
    assert.equal(stuck(), 1);
    await rejectsWithCode(pool.run('B', async () => 1), 'auth_timeout');
    rec.held.get('A')?.resolve();
    await clock.advance(10 * MIN);
    assert.equal(stuck(), 1, 'onStuck once');
    assert.deepEqual(rec.connects, ['A'], 'nothing started after the ping');
    assert.equal(rec.overlapped, false);
  });

  test('a request queued before the ping started waits 120 s from the ping start', async () => {
    const { pool, rec, clock, stuck } = setup();
    await pool.run('A', async () => 1);
    rec.hold.add('A');
    const blocker = pool.run('B', slow(rec, clock, 'B op', 20_000));
    await clock.advance(1000);
    pool.tick();
    await clock.advance(1000);
    const request = pool.run('A', async () => 'never');
    const state = track(request);
    // The ping starts at 20 s, when B's operation ends.
    await clock.advance(137_000);
    assert.equal(await blocker, 'B op');
    assert.equal(state.settled(), false, 'still waiting at 139 s');
    assert.equal(stuck(), 0);
    await clock.advance(1000);
    assert.equal(state.settled(), true, 'answered at 140 s');
    await rejectsWithCode(request, 'auth_timeout');
    assert.equal(stuck(), 1);
    assert.equal(rec.overlapped, false);
  });

  test('a request behind a ping that settles in time runs normally, with its own timer from its start', async () => {
    const { pool, rec, clock, stuck } = setup();
    await pool.run('A', async () => 1);
    rec.hold.add('A');
    pool.tick();
    await clock.advance(10_000);
    const request = pool.run('B', slow(rec, clock, 'B op', 110_000));
    const state = track(request);
    await clock.advance(115_000);
    assert.equal(stuck(), 0, 'the given-up ping is not stuck');
    rec.held.get('A')?.resolve();
    // B's operation starts at 125 s and ends at 235 s: past 120 s from its queueing, inside its own timer.
    await clock.advance(110_000);
    assert.equal(state.settled(), true, 'answered at 235 s');
    assert.equal(await request, 'B op');
    assert.equal(stuck(), 0);
    const hung = rejectsWithCode(
      pool.run('B', () => rec.call('B hung', () => new Promise(() => {}))),
      'auth_timeout',
    );
    await clock.advance(120_000);
    await hung;
    assert.equal(stuck(), 1, 'a real operation still takes the stuck path');
    assert.equal(rec.overlapped, false);
  });

  test('busy() is false once it is given up, with only pings queued behind it', async () => {
    const { pool, rec, clock } = setup();
    await pool.run('A', async () => 1);
    await pool.run('B', async () => 1);
    rec.hold.add('A');
    pool.tick();
    await flush();
    assert.equal(pool.busy(), true, 'a running ping counts before its timeout');
    await clock.advance(120_000);
    assert.equal(pool.busy(), false, "B's queued ping does not count");
    const request = pool.run('B', async () => 2);
    assert.equal(pool.busy(), true, 'a queued real request counts');
    rec.held.get('A')?.resolve();
    await clock.advance(1000);
    assert.equal(await request, 2);
    assert.equal(pool.busy(), false);
  });

  test('pings do not pile up behind it, and a queued ping whose authorization went stale does not run', async () => {
    const { pool, rec, clock, stuck } = setup({ keepAliveIntervalMs: 4 * MIN });
    await pool.run('A', async () => 1);
    await pool.run('B', async () => 1);
    rec.hold.add('A');
    // A's ping hangs from 4 min; B's waits behind it; the ticks at 8, 12 and 16 min add nothing.
    await clock.advance(17 * MIN);
    assert.equal(pool.busy(), false, 'no real request waits');
    rec.held.get('A')?.resolve();
    await flush();
    assert.equal(rec.pings.get('A'), 1);
    assert.equal(rec.pings.get('B'), undefined, "B's ping, 13 minutes past B's last success, is skipped");
    assert.deepEqual(pool.accounts(), [{ account: 'B', warm: false }]);
    await clock.advance(8 * MIN);
    assert.equal(rec.pings.get('B'), undefined, 'a stale client is not pinged later either');
    assert.equal(stuck(), 0);
    assert.equal(rec.overlapped, false);
    pool.close();
  });

  test('a queued ping still fresh when it settles runs once', async () => {
    const { pool, rec, clock } = setup({ keepAliveIntervalMs: 4 * MIN });
    await pool.run('A', async () => 1);
    await clock.advance(3 * MIN);
    await pool.run('B', async () => 1);
    rec.hold.add('A');
    // At 4 min: A's ping hangs, B's is queued; given up at 6 min; the tick at 8 min adds no second B ping.
    await clock.advance(5 * MIN + 30_000);
    rec.held.get('A')?.resolve();
    await flush();
    assert.equal(rec.pings.get('B'), 1);
    assert.equal(pool.busy(), false);
    assert.equal(rec.overlapped, false);
    pool.close();
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
