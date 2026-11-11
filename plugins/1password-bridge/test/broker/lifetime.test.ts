import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { KEEP_ALIVE_INTERVAL_MS, OPERATION_TIMEOUT_MS } from '../../src/broker/pool.ts';
import { encodeAck, parseResponse, type Request } from '../../src/protocol.ts';
import { FORGET_SCAN_MS, SESSION_FORGET_MS } from '../../src/session-lifetime.ts';
import { PROTOCOL_VERSION } from '../../src/version.ts';
import { FakeClock } from './clock.ts';
import { TOKEN_VALUE } from './fixtures.ts';
import {
  call,
  harness,
  issue,
  issueRequest,
  OTHER_SESSION,
  redeemOpen,
  redeemRequest,
  running,
  scriptedDialog,
  SESSION,
  waitFor,
  type Harness,
} from './harness.ts';

const v = PROTOCOL_VERSION;
let h: Harness | undefined;
/** Redeem connections a test leaves open; destroyed afterwards, so a failed assertion does not hang the file. */
const open: Socket[] = [];

afterEach(() => {
  for (const socket of open.splice(0)) socket.destroy();
  h?.cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A ticket id this broker never issued. */
const NEVER_ISSUED = 'tkt_aaaaaaaaaaaaaaaa';

/** A FakeClock that lists the period of every interval set on it. */
class RecordingClock extends FakeClock {
  readonly intervals: number[] = [];

  override setInterval(fn: () => void, ms: number): unknown {
    this.intervals.push(ms);
    return super.setInterval(fn, ms);
  }
}

/** Redeems `id` through an approved window and acknowledges the value: the ticket ends used, its mask armed. */
async function deliver(b: Harness, w: ReturnType<typeof scriptedDialog>, id: string): Promise<void> {
  const before = w.shown.length;
  running(b.stateDir, `T="$(op-bridge redeem ${id})" && curl`);
  const { socket, lines } = await redeemOpen(b.options.socketPath, id);
  await waitFor('the window', () => w.shown.length > before);
  w.shown[before]?.answer('approve');
  assert.deepEqual(parseResponse((await lines.next()) ?? '', 'redeem'), { ok: true, op: 'redeem', value: TOKEN_VALUE });
  socket.write(encodeAck('received'));
  socket.end(encodeAck('delivered'));
  await once(socket, 'close');
}

describe('broker lifetime', () => {
  test('without tickets or masks the broker exits after the idle window', async () => {
    h = harness({ idleMs: 100 });
    await h.start();
    await call(h.options.socketPath, { v, op: 'fields', account: 'example.1password.test', ref: 'op://Deploy/Deploy server' });
    await waitFor('the idle exit', () => h?.exits.length === 1);
    assert.deepEqual(h.exits, [0]);
  });

  test('a live ticket keeps the process; the idle window drops the 1Password clients', async () => {
    let connects = 0;
    let base: Harness | undefined;
    h = harness({
      idleMs: 100,
      connect: async () => {
        connects++;
        return (base as Harness).account;
      },
    });
    base = h;
    await h.start();
    const [id = ''] = await issue(h.options.socketPath);
    await sleep(350);
    assert.deepEqual(h.exits, [], 'still running');
    const status = await call(h.options.socketPath, { v, op: 'status' });
    assert.ok(status !== null && status.ok && status.op === 'status');
    assert.deepEqual(status.accounts, [], 'the authorized client was dropped');
    await call(h.options.socketPath, { v, op: 'fields', account: 'example.1password.test', ref: 'op://Deploy/Deploy server' });
    assert.equal(connects, 2, 'the next request connects again');
    await call(h.options.socketPath, { v, op: 'release', session: SESSION, tickets: [id] });
    await waitFor('the idle exit', () => h?.exits.length === 1);
  });

  test('a mask keeps the process after its ticket is used; its release lets the broker exit', async () => {
    const w = scriptedDialog();
    h = harness({ idleMs: 100, dialog: w.dialog, attributionWaitMs: 200, recheckMs: 20 });
    await h.start();
    const path = h.options.socketPath;
    const [id = ''] = await issue(path);
    await deliver(h, w, id);
    await sleep(350);
    assert.deepEqual(h.exits, [], 'the mask keeps the process');
    const masked = await call(path, { v, op: 'mask', session: SESSION, tickets: [id], output: `token ${TOKEN_VALUE}` });
    assert.deepEqual(masked, { ok: true, op: 'mask', known: true, changed: true, output: `token <masked ticket=${id}>`, missing: [] });
    await call(path, { v, op: 'release', session: SESSION, tickets: [id] });
    await waitFor('the idle exit', () => h?.exits.length === 1);
    assert.deepEqual(h.exits, [0]);
  });

  test('a session quiet for the forget period loses its tickets, and the broker may exit', async () => {
    h = harness({ idleMs: 100, sessionForgetMs: 50 });
    await h.start();
    const [id = ''] = await issue(h.options.socketPath);
    await waitFor('the idle exit', () => h?.exits.length === 1, 2000);
    assert.ok(id.startsWith('tkt_'));
  });

  test('with the default forget age the broker scans every FORGET_SCAN_MS and forgets a quiet session one scan past the age', async () => {
    const clock = new RecordingClock();
    h = harness({ clock });
    await h.start();
    const path = h.options.socketPath;
    // The pool's keep-alive is the only other interval on this clock.
    assert.deepEqual(
      clock.intervals.filter((ms) => ms !== KEEP_ALIVE_INTERVAL_MS),
      [FORGET_SCAN_MS],
      'the forget scan runs every FORGET_SCAN_MS',
    );
    const [id = ''] = await issue(path);
    // A scan at exactly the forget age keeps the session; the next one forgets it.
    await clock.sleep(SESSION_FORGET_MS);
    await clock.advance(FORGET_SCAN_MS);
    const res = await call(path, { v, op: 'release', session: SESSION, tickets: [id] });
    assert.deepEqual(res, { ok: true, op: 'release', results: [{ ticket: id, result: 'unknown' }] }, 'the quiet session was forgotten');
  });

  test('a quiet session is forgotten even while another session keeps resetting the idle window', async () => {
    h = harness({ idleMs: 100, sessionForgetMs: 150 });
    await h.start();
    const path = h.options.socketPath;
    const [quiet = ''] = await issue(path);
    // Every issue_tickets resets the idle window; released at once, the other session holds nothing alive.
    const until = Date.now() + 600;
    while (Date.now() < until) {
      const [busy = ''] = await issue(path, { session: { id: OTHER_SESSION, title: 'Other' } });
      await call(path, { v, op: 'release', session: OTHER_SESSION, tickets: [busy] });
      await sleep(20);
    }
    assert.deepEqual(h.exits, [], 'the busy session kept the broker in the idle window');
    const res = await call(path, { v, op: 'release', session: SESSION, tickets: [quiet] });
    assert.deepEqual(res, { ok: true, op: 'release', results: [{ ticket: quiet, result: 'unknown' }] }, 'the quiet session was forgotten');
  });

  test('each of mask, release, redeem and issue_tickets keeps a session; quiet for the forget period, it loses its masks', async () => {
    const w = scriptedDialog();
    h = harness({ dialog: w.dialog, attributionWaitMs: 200, recheckMs: 20, sessionForgetMs: 200 });
    await h.start();
    const path = h.options.socketPath;
    const [id = ''] = await issue(path);
    await deliver(h, w, id);
    const maskReq: Request = { v, op: 'mask', session: SESSION, tickets: [id], output: `token ${TOKEN_VALUE}` };
    const requests: [string, Request][] = [
      ['mask', maskReq],
      ['release', { v, op: 'release', session: SESSION, tickets: [NEVER_ISSUED] }],
      ['redeem', redeemRequest(NEVER_ISSUED)],
      ['issue_tickets', issueRequest()],
    ];
    // Each kind alone, for longer than the forget period plus one sweep, keeps the session's mask.
    for (const [kind, req] of requests) {
      const until = Date.now() + 500;
      while (Date.now() < until) {
        const res = await call(path, req);
        assert.ok(res !== null && res.ok !== undefined, `${kind} answered`);
        await sleep(20);
      }
      const held = await call(path, maskReq);
      assert.ok(held !== null && held.ok && held.op === 'mask' && held.known, `${kind} requests kept the session's mask`);
    }
    await sleep(500);
    assert.deepEqual(await call(path, maskReq), { ok: true, op: 'mask', known: false, changed: false, output: null, missing: [id] });
  });

  test('a failed issue_tickets keeps a session too', async () => {
    const w = scriptedDialog();
    h = harness({ dialog: w.dialog, attributionWaitMs: 200, recheckMs: 20, sessionForgetMs: 200 });
    await h.start();
    const path = h.options.socketPath;
    const [id = ''] = await issue(path);
    await deliver(h, w, id);
    // Only failing issues, for longer than the forget period plus one sweep.
    const missing = issueRequest({ ref: 'op://Deploy/Deploy server/no such field' });
    const until = Date.now() + 500;
    while (Date.now() < until) {
      const res = await call(path, missing);
      assert.ok(res !== null && !res.ok && res.code === 'not_found', 'the issue failed');
      await sleep(20);
    }
    const held = await call(path, { v, op: 'mask', session: SESSION, tickets: [id], output: `token ${TOKEN_VALUE}` });
    assert.ok(held !== null && held.ok && held.op === 'mask' && held.known, "the failed issues kept the session's mask");
  });

  test('an unanswered window does not keep the 1Password clients past the idle window; the approved fetch connects again', async () => {
    let connects = 0;
    let base: Harness | undefined;
    const w = scriptedDialog();
    h = harness({
      idleMs: 100,
      dialog: w.dialog,
      attributionWaitMs: 200,
      recheckMs: 20,
      connect: async () => {
        connects++;
        return (base as Harness).account;
      },
    });
    base = h;
    await h.start();
    const path = h.options.socketPath;
    const [id = ''] = await issue(path);
    running(h.stateDir, `T="$(op-bridge redeem ${id})" && curl`);
    const { socket, lines } = await redeemOpen(path, id);
    open.push(socket);
    await waitFor('the window', () => w.shown.length === 1);
    await sleep(350);
    const status = await call(path, { v, op: 'status' });
    assert.ok(status !== null && status.ok && status.op === 'status');
    assert.deepEqual(status.accounts, [], 'the open window did not keep the authorized client');
    assert.deepEqual(h.exits, [], 'the open window keeps the process');
    assert.equal(connects, 1);
    w.shown[0]?.answer('approve');
    assert.deepEqual(parseResponse((await lines.next()) ?? '', 'redeem'), { ok: true, op: 'redeem', value: TOKEN_VALUE });
    assert.equal(connects, 2, 'the fetch after the drop authorized again');
    socket.write(encodeAck('received'));
    socket.end(encodeAck('delivered'));
  });

  test('a delivery the CLI does not acknowledge does not keep the 1Password clients past the idle window', async () => {
    const w = scriptedDialog();
    h = harness({ idleMs: 100, dialog: w.dialog, attributionWaitMs: 200, recheckMs: 20 });
    await h.start();
    const path = h.options.socketPath;
    const [id = ''] = await issue(path);
    running(h.stateDir, `T="$(op-bridge redeem ${id})" && curl`);
    const { socket, lines } = await redeemOpen(path, id);
    open.push(socket);
    await waitFor('the window', () => w.shown.length === 1);
    w.shown[0]?.answer('approve');
    assert.deepEqual(parseResponse((await lines.next()) ?? '', 'redeem'), { ok: true, op: 'redeem', value: TOKEN_VALUE });
    await sleep(350);
    const status = await call(path, { v, op: 'status' });
    assert.ok(status !== null && status.ok && status.op === 'status');
    assert.deepEqual(status.accounts, [], 'the stalled delivery did not keep the authorized client');
    assert.deepEqual(h.exits, [], 'the open delivery keeps the process');
    socket.write(encodeAck('received'));
    socket.end(encodeAck('delivered'));
  });

  test('a keep-alive ping that never returns does not end the broker; the masks stay', async () => {
    const clock = new FakeClock();
    const w = scriptedDialog();
    const events: string[] = [];
    h = harness({
      clock,
      dialog: w.dialog,
      attributionWaitMs: 200,
      recheckMs: 20,
      log: (event, detail) => events.push(`${event} ${String(detail?.result ?? '')}`.trim()),
    });
    await h.start();
    const path = h.options.socketPath;
    const [id = ''] = await issue(path);
    await deliver(h, w, id);
    h.account.listVaults = () => new Promise(() => {});
    await clock.advance(KEEP_ALIVE_INTERVAL_MS + OPERATION_TIMEOUT_MS);
    // Past the stuck exit delay, which runs on the real clock.
    await sleep(100);
    assert.deepEqual(h.exits, [], 'the broker is still running');
    assert.ok(events.includes('ping_given_up auth_timeout'), events.join(', '));
    assert.ok(!events.includes('stuck'), events.join(', '));
    const masked = await call(path, { v, op: 'mask', session: SESSION, tickets: [id], output: `token ${TOKEN_VALUE}` });
    assert.deepEqual(masked, { ok: true, op: 'mask', known: true, changed: true, output: `token <masked ticket=${id}>`, missing: [] });
    const status = await call(path, { v, op: 'status' });
    assert.ok(status !== null && status.ok && status.op === 'status');
    assert.deepEqual(status.accounts, [], 'the hung client was forgotten');
  });

  test('a 1Password operation in flight defers the drop of the clients', async () => {
    h = harness({ idleMs: 100 });
    await h.start();
    const path = h.options.socketPath;
    const getItem = h.account.getItem.bind(h.account);
    h.account.getItem = async (vaultId, itemId) => {
      await sleep(350);
      return getItem(vaultId, itemId);
    };
    const res = await call(path, { v, op: 'fields', account: 'example.1password.test', ref: 'op://Deploy/Deploy server' });
    assert.ok(res !== null && res.ok && res.op === 'fields');
    const status = await call(path, { v, op: 'status' });
    assert.ok(status !== null && status.ok && status.op === 'status');
    assert.deepEqual(
      status.accounts.map((a) => a.account),
      ['example.1password.test'],
      'the client of the call that outlived the idle window was kept',
    );
  });
});
