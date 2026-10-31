import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { platformDialog, type Dialog, type Runner, type RunResult } from '../../src/broker/dialog.ts';
import { TICKET_TTL_MS } from '../../src/broker/tickets.ts';
import { boardDir, maskedMarkerPath } from '../../src/paths.ts';
import { encodeAck, MAX_LINE_BYTES, parseResponse, type Request, type Response } from '../../src/protocol.ts';
import { readMarker, writeSessionInfo } from '../../src/session-files.ts';
import { PROTOCOL_VERSION } from '../../src/version.ts';
import { FakeClock } from './clock.ts';
import { ITEM_ID, TOKEN_ID, TOKEN_VALUE, VAULT } from './fixtures.ts';
import {
  call,
  harness,
  issue,
  OTHER_SESSION,
  redeemOpen,
  redeemRequest,
  running,
  scriptedDialog,
  SESSION,
  waitFor,
  type Harness,
} from './harness.ts';
import type { BrokerOptions } from '../../src/broker/service.ts';

const v = PROTOCOL_VERSION;
let h: Harness | undefined;

afterEach(() => h?.cleanup());

async function setup(over: Partial<BrokerOptions> = {}) {
  const w = scriptedDialog();
  h = harness({ dialog: w.dialog, attributionWaitMs: 200, recheckMs: 20, ...over });
  await h.start();
  return { h, w, path: h.options.socketPath };
}

function failure(res: Response | null): string {
  return res !== null && !res.ok ? res.code : `not a failure: ${JSON.stringify(res)}`;
}

function rows(approval: { rows: [string, string, boolean?][] }): Record<string, string> {
  return Object.fromEntries(approval.rows.map(([label, value]) => [label, value]));
}

/** Holds the value fetch at approve until `open()`; install it after `issue`, which fetches the item too. */
function holdFetch(h: Harness, fails = false): { started: () => boolean; open: () => void } {
  const getItem = h.account.getItem.bind(h.account);
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let fetching = false;
  h.account.getItem = async (vaultId, itemId) => {
    fetching = true;
    await gate;
    if (fails) throw new Error('the network is down');
    return getItem(vaultId, itemId);
  };
  return { started: () => fetching, open: () => open() };
}

async function releaseResult(path: string, id: string): Promise<string | undefined> {
  const res = await call(path, { v, op: 'release', session: SESSION, tickets: [id] });
  assert.ok(res !== null && res.ok && res.op === 'release');
  return res.results[0]?.result;
}

const NO_MASKS = { ok: true, op: 'mask', known: false, changed: false, output: null, missing: [] };

const BUSY = 'The ticket is already waiting for an answer, or its value is being sent';

/** A FakeClock that also lists its one-shot timers still pending, with their due times. */
class TrackingClock extends FakeClock {
  readonly pending = new Map<unknown, { at: number; ms: number }>();

  override setTimeout(fn: () => void, ms: number): unknown {
    const handle: unknown = super.setTimeout(() => {
      this.pending.delete(handle);
      fn();
    }, ms);
    this.pending.set(handle, { at: this.now() + ms, ms });
    return handle;
  }

  override clearTimeout(handle: unknown): void {
    this.pending.delete(handle);
    super.clearTimeout(handle);
  }

  /** Timers already due that have not run yet. */
  overdue(): number {
    return [...this.pending.values()].filter((p) => p.at <= this.t).length;
  }
}

type Logged = { event: string } & Record<string, unknown>;

/** A broker log kept for the test, and a check that a redeem has ended. */
function logged(): { logs: Logged[]; log: BrokerOptions['log']; redeemEnded: () => boolean } {
  const logs: Logged[] = [];
  return {
    logs,
    log: (event, detail) => {
      logs.push({ event, ...detail });
    },
    redeemEnded: () => logs.some((l) => l.event === 'request' && l.op === 'redeem'),
  };
}

async function maskChanged(path: string, id: string): Promise<boolean> {
  const res = await call(path, { v, op: 'mask', session: SESSION, tickets: [id], output: `x ${TOKEN_VALUE}` });
  return res !== null && res.ok && res.op === 'mask' && res.changed;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Redeems each ticket in turn, approving its window, and delivers its value. */
async function deliverAll(w: ReturnType<typeof scriptedDialog>, path: string, ids: string[]): Promise<void> {
  for (const [i, id] of ids.entries()) {
    const { socket, lines } = await redeemOpen(path, id);
    await waitFor(`window ${i + 1}`, () => w.shown.length === i + 1);
    w.shown[i]?.answer('approve');
    assert.deepEqual(parseResponse((await lines.next()) ?? '', 'redeem'), { ok: true, op: 'redeem', value: TOKEN_VALUE });
    socket.write(encodeAck('received'));
    socket.end(encodeAck('delivered'));
    await once(socket, 'close');
  }
}

/** Redeems `id` through an approved window and reads its value; the ticket is left in flight for the test. */
async function approveOne(w: ReturnType<typeof scriptedDialog>, path: string, id: string, session = SESSION): Promise<Socket> {
  const before = w.shown.length;
  const { socket, lines } = await redeemOpen(path, id, session);
  await waitFor('the window', () => w.shown.length === before + 1);
  w.shown[before]?.answer('approve');
  assert.deepEqual(parseResponse((await lines.next()) ?? '', 'redeem'), { ok: true, op: 'redeem', value: TOKEN_VALUE });
  return socket;
}

/** Acknowledges a value the CLI received and delivered. */
async function acknowledge(socket: Socket): Promise<void> {
  socket.write(encodeAck('received'));
  socket.end(encodeAck('delivered'));
  await once(socket, 'close');
}

describe('redeem: approve and deliver', () => {
  test('the window shows the owner and its command; the value arrives once and is masked afterwards', async () => {
    const { h, w, path } = await setup();
    writeSessionInfo(h.stateDir, SESSION, { cwd: '/work/site' });
    const [id = ''] = await issue(path);
    const command = `T="$(op-bridge redeem ${id})" && curl`;
    running(h.stateDir, command);
    const { socket, lines } = await redeemOpen(path, id);
    await waitFor('the window', () => w.shown.length === 1);
    const shown = w.shown[0];
    assert.ok(shown !== undefined);
    assert.equal(rows(shown.approval)['Agent'], 'main');
    assert.equal(rows(shown.approval)['Started in'], '/work/site');
    assert.equal(rows(shown.approval)['Ticket'], id);
    assert.deepEqual(shown.approval.commands.map((c) => [c.full, c.cwd, c.literal]), [[command, '/work/site', true]]);
    assert.ok(!JSON.stringify(shown.approval).includes(TOKEN_VALUE));
    shown.answer('approve');
    assert.deepEqual(parseResponse((await lines.next()) ?? '', 'redeem'), { ok: true, op: 'redeem', value: TOKEN_VALUE });
    assert.deepEqual(readMarker(h.stateDir, SESSION), [id], 'the marker is written before the value leaves');
    socket.write(encodeAck('received'));
    socket.end(encodeAck('delivered'));
    await once(socket, 'close');
    assert.deepEqual(await call(path, { v, op: 'mask', session: SESSION, tickets: [id], output: `x ${TOKEN_VALUE}` }), {
      ok: true,
      op: 'mask',
      known: true,
      changed: true,
      output: `x <masked ticket=${id}>`,
      missing: [],
    });
    assert.deepEqual(
      await call(path, { v, op: 'mask', session: SESSION, tickets: [id, 'tkt_zzzzzzzzzzzzzzzz'], output: `x ${TOKEN_VALUE}` }),
      { ok: true, op: 'mask', known: false, changed: false, output: null, missing: ['tkt_zzzzzzzzzzzzzzzz'] },
      'a marker id the broker does not hold (one from before a restart) withholds the output; only that id is missing, not the held one',
    );
    assert.equal(failure(await call(path, redeemRequest(id))), 'used');
  });

  test("a subagent's own ticket shows the subagent", async () => {
    const { h, w, path } = await setup();
    const [id = ''] = await issue(path, { agent: { id: 'agent-1', type: 'general-purpose' } });
    running(h.stateDir, './deploy.sh', 'agent-1');
    const { socket } = await redeemOpen(path, id);
    await waitFor('the window', () => w.shown.length === 1);
    assert.equal(rows(w.shown[0]?.approval ?? { rows: [] })['Agent'], 'subagent · general-purpose');
    socket.destroy();
  });

  test('not_delivered gives the ticket back and keeps the mask', async () => {
    const { h, w, path } = await setup();
    const [id = ''] = await issue(path);
    running(h.stateDir, 'make deploy');
    const { socket, lines } = await redeemOpen(path, id);
    await waitFor('the window', () => w.shown.length === 1);
    w.shown[0]?.answer('approve');
    await lines.next();
    socket.write(encodeAck('received'));
    socket.end(encodeAck('not_delivered'));
    await once(socket, 'close');
    const masked = await call(path, { v, op: 'mask', session: SESSION, tickets: [id], output: TOKEN_VALUE });
    assert.ok(masked !== null && masked.ok && masked.op === 'mask' && masked.changed);
    const again = await redeemOpen(path, id);
    await waitFor('a second window', () => w.shown.length === 2);
    again.socket.destroy();
  });

  for (const stage of ['sending', 'received'] as const) {
    test(`a CLI that goes away while ${stage}: another redeem is busy meanwhile; then unused with the mask kept`, async () => {
      const l = logged();
      const { h, w, path } = await setup({ log: l.log });
      const [id = ''] = await issue(path);
      running(h.stateDir, 'make deploy');
      const { socket, lines } = await redeemOpen(path, id);
      await waitFor('the window', () => w.shown.length === 1);
      w.shown[0]?.answer('approve');
      assert.deepEqual(parseResponse((await lines.next()) ?? '', 'redeem'), { ok: true, op: 'redeem', value: TOKEN_VALUE });
      if (stage === 'received') {
        socket.write(encodeAck('received'));
        await pause(50);
      }
      const busy = await call(path, redeemRequest(id));
      socket.destroy();
      assert.deepEqual(busy, { ok: false, code: 'busy', message: BUSY });
      await waitFor('the redeem to end', l.redeemEnded);
      assert.equal(await maskChanged(path, id), true, 'the mask stays armed');
      const again = await redeemOpen(path, id);
      await waitFor('a second window', () => w.shown.length === 2);
      again.socket.destroy();
    });
  }

  test('a marker that cannot be written fails the redeem: nothing is sent and the ticket is unused again', async () => {
    const { h, w, path } = await setup();
    const [id = ''] = await issue(path);
    running(h.stateDir, 'make deploy');
    // A directory where the marker file goes: reading or replacing it fails.
    mkdirSync(maskedMarkerPath(h.stateDir, SESSION), { recursive: true });
    const answer = call(path, redeemRequest(id));
    await waitFor('the window', () => w.shown.length === 1);
    w.shown[0]?.answer('approve');
    const res = await answer;
    assert.equal(failure(res), 'internal');
    assert.ok(!JSON.stringify(res).includes(TOKEN_VALUE));
    assert.deepEqual(await call(path, { v, op: 'mask', session: SESSION, tickets: [], output: TOKEN_VALUE }), NO_MASKS);
    rmSync(maskedMarkerPath(h.stateDir, SESSION), { recursive: true, force: true });
    const again = await redeemOpen(path, id);
    await waitFor('a second window', () => w.shown.length === 2);
    again.socket.destroy();
  });

  for (const fails of [false, true]) {
    test(`a session ended while the value is fetched (${fails ? 'failing' : 'succeeding'}) gets voided: no value, no mask, no marker`, async () => {
      const { h, w, path } = await setup();
      const [id = ''] = await issue(path);
      running(h.stateDir, 'make deploy');
      const fetch = holdFetch(h, fails);
      const answer = call(path, redeemRequest(id));
      await waitFor('the window', () => w.shown.length === 1);
      w.shown[0]?.answer('approve');
      await waitFor('the fetch', fetch.started);
      assert.deepEqual(await call(path, { v, op: 'end_session', session: SESSION }), { ok: true, op: 'end_session' });
      fetch.open();
      const res = await answer;
      assert.equal(failure(res), 'voided');
      assert.ok(!JSON.stringify(res).includes(TOKEN_VALUE));
      assert.equal(existsSync(maskedMarkerPath(h.stateDir, SESSION)), false, 'no marker');
      assert.deepEqual(await call(path, { v, op: 'mask', session: SESSION, tickets: [], output: TOKEN_VALUE }), NO_MASKS);
      assert.equal(failure(await call(path, redeemRequest(id))), 'unknown');
    });
  }
});

describe('line limits', () => {
  test('only a mask request may be longer than 1 MiB', async () => {
    const { path } = await setup();
    const big = 'x'.repeat(MAX_LINE_BYTES + 1);
    assert.equal(await call(path, { v, op: 'fields', account: 'example.1password.test', ref: `op://Deploy/${big}` }), null);
    assert.deepEqual(await call(path, { v, op: 'mask', session: SESSION, tickets: [], output: big }), NO_MASKS);
  });

  test('an ack longer than 1 MiB closes the redeem connection and gives the ticket back', async () => {
    const { h, w, path } = await setup();
    const [id = ''] = await issue(path);
    running(h.stateDir, 'make deploy');
    const { socket, lines } = await redeemOpen(path, id);
    const closed = once(socket, 'close');
    await waitFor('the window', () => w.shown.length === 1);
    w.shown[0]?.answer('approve');
    assert.deepEqual(parseResponse((await lines.next()) ?? '', 'redeem'), { ok: true, op: 'redeem', value: TOKEN_VALUE });
    socket.write(`${'x'.repeat(MAX_LINE_BYTES + 1)}\n`);
    await closed;
    assert.equal(await maskChanged(path, id), true, 'the mask stays armed');
    const again = await redeemOpen(path, id);
    await waitFor('a second window', () => w.shown.length === 2);
    again.socket.destroy();
  });
});

describe('redeem: refusals', () => {
  test('deny burns the ticket', async () => {
    const { h, w, path } = await setup();
    const [id = ''] = await issue(path);
    running(h.stateDir, 'make deploy');
    const answer = call(path, redeemRequest(id));
    await waitFor('the window', () => w.shown.length === 1);
    w.shown[0]?.answer('deny');
    assert.equal(failure(await answer), 'denied');
    assert.equal(failure(await call(path, redeemRequest(id))), 'used');
  });

  test('unknown ticket, another session, another agent naming the ticket: refused without a window', async () => {
    const { h, w, path } = await setup();
    const [id = ''] = await issue(path);
    assert.equal(failure(await call(path, redeemRequest('tkt_zzzzzzzzzzzzzzzz'))), 'unknown');
    assert.equal(failure(await call(path, redeemRequest(id, OTHER_SESSION))), 'not_owner');
    running(h.stateDir, `bash -c 'op-bridge redeem ${id}'`, 'agent-1');
    assert.equal(failure(await call(path, redeemRequest(id))), 'not_owner');
    assert.equal(w.shown.length, 0);
  });

  test('a session ended or a ticket released during the attribution wait: no window', { timeout: 10000 }, async () => {
    const { h, w, path } = await setup({ attributionWaitMs: 3000 });
    const [ended = ''] = await issue(path);
    const first = call(path, redeemRequest(ended));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await call(path, { v, op: 'end_session', session: SESSION }), { ok: true, op: 'end_session' });
    running(h.stateDir, 'make deploy');
    assert.equal(failure(await first), 'unknown');
    assert.equal(w.shown.length, 0);

    const [kept = ''] = await issue(path);
    // The board still lists the command; without it the next redeem waits again.
    rmSync(boardDir(h.stateDir, SESSION), { recursive: true, force: true });
    const second = call(path, redeemRequest(kept));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await releaseResult(path, kept), 'voided');
    running(h.stateDir, 'make deploy');
    assert.equal(failure(await second), 'voided');
    assert.equal(w.shown.length, 0);
  });

  const LATER = { release: 'voided', expiry: 'expired', end_session: 'unknown' } as const;
  for (const [event, code] of Object.entries(LATER) as [keyof typeof LATER, string][]) {
    test(`${event} during an attribution wait that finds no command answers ${code}, not no_command`, async () => {
      const clock = new TrackingClock();
      const { w, path } = await setup({ clock });
      const issuedAt = clock.now();
      const [id = ''] = await issue(path);
      // Nothing of the owner runs: the wait ends without a command.
      if (event === 'expiry') clock.t = issuedAt + TICKET_TTL_MS - 50;
      const answer = call(path, redeemRequest(id));
      await waitFor('the attribution recheck', () => [...clock.pending.values()].some((p) => p.ms === 20));
      if (event === 'release') assert.equal(await releaseResult(path, id), 'voided');
      if (event === 'end_session') {
        assert.deepEqual(await call(path, { v, op: 'end_session', session: SESSION }), { ok: true, op: 'end_session' });
      }
      await clock.advance(300);
      assert.equal(failure(await answer), code);
      assert.equal(failure(await call(path, redeemRequest(id))), code);
      assert.equal(w.shown.length, 0);
    });
  }

  test('a redeem whose attribution comes after another redeem opened the window is busy', async () => {
    // The first redeem reads the board again only after 1 s; the second one opens the window before that.
    const { h, w, path } = await setup({ attributionWaitMs: 3000, recheckMs: 1000 });
    const [id = ''] = await issue(path);
    const waiting = call(path, redeemRequest(id));
    await new Promise((resolve) => setTimeout(resolve, 50));
    running(h.stateDir, 'make deploy');
    const shown = call(path, redeemRequest(id));
    assert.equal(failure(await waiting), 'busy');
    await waitFor('the window', () => w.shown.length === 1);
    w.shown[0]?.answer('deny');
    assert.equal(failure(await shown), 'denied');
  });

  test('no_command when nothing of the owner runs, other_agent while another agent does', async () => {
    const { h, w, path } = await setup();
    const [id = ''] = await issue(path);
    assert.equal(failure(await call(path, redeemRequest(id))), 'no_command');
    running(h.stateDir, 'make deploy');
    running(h.stateDir, 'npm test', 'agent-1');
    assert.equal(failure(await call(path, redeemRequest(id))), 'other_agent');
    assert.equal(w.shown.length, 0);
  });

  test('a board that cannot be read answers internal with a fixed message; the ticket stays unused', async () => {
    const { h, w, path } = await setup();
    const [id = ''] = await issue(path);
    // A file where the board directory goes: listing it fails with ENOTDIR inside attribution.
    const board = boardDir(h.stateDir, SESSION);
    mkdirSync(dirname(board), { recursive: true });
    writeFileSync(board, 'not a directory');
    const res = await call(path, redeemRequest(id));
    assert.equal(failure(res), 'internal');
    assert.ok(res !== null && !res.ok && res.message === 'The broker could not serve this redeem', 'no error text in the answer');
    assert.equal(w.shown.length, 0);
    rmSync(board);
    running(h.stateDir, 'make deploy');
    const again = await redeemOpen(path, id);
    await waitFor('a window', () => w.shown.length === 1);
    again.socket.destroy();
  });

  test('a window that throws answers internal with a fixed message; the ticket is unused again', async () => {
    const w = scriptedDialog();
    let throws = true;
    const dialog: Dialog = {
      ask: (approval, signal) => (throws ? Promise.reject(new Error('window failed at /private/tmp/x')) : w.dialog.ask(approval, signal)),
      close() {},
    };
    const { h, path } = await setup({ dialog });
    const [id = ''] = await issue(path);
    running(h.stateDir, 'make deploy');
    const res = await call(path, redeemRequest(id));
    assert.equal(failure(res), 'internal');
    assert.ok(res !== null && !res.ok && res.message === 'The broker could not serve this redeem', 'no error text in the answer');
    throws = false;
    const again = await redeemOpen(path, id);
    await waitFor('a window', () => w.shown.length === 1);
    again.socket.destroy();
  });

  test('a second redeem while the window is open is busy', async () => {
    const { h, w, path } = await setup();
    const [id = ''] = await issue(path);
    running(h.stateDir, 'make deploy');
    const { socket } = await redeemOpen(path, id);
    await waitFor('the window', () => w.shown.length === 1);
    assert.equal(failure(await call(path, redeemRequest(id))), 'busy');
    socket.destroy();
  });

  test('a field gone at approve fails with field_gone and voids the ticket', async () => {
    const { h, w, path } = await setup();
    const [id = ''] = await issue(path);
    running(h.stateDir, 'make deploy');
    const answer = call(path, redeemRequest(id));
    await waitFor('the window', () => w.shown.length === 1);
    h.account.items.set(VAULT.id, (h.account.items.get(VAULT.id) ?? []).filter((item) => item.id !== ITEM_ID));
    w.shown[0]?.answer('approve');
    assert.equal(failure(await answer), 'field_gone');
    assert.equal(failure(await call(path, redeemRequest(id))), 'voided');
  });
});

describe('redeem: the window closes', () => {
  test('when the CLI goes away; a retry opens it again', async () => {
    const { h, w, path } = await setup();
    const [id = ''] = await issue(path);
    running(h.stateDir, 'make deploy');
    const first = await redeemOpen(path, id);
    await waitFor('the window', () => w.shown.length === 1);
    first.socket.destroy();
    await waitFor('the window to close', () => w.shown[0]?.signal?.aborted === true);
    const second = await redeemOpen(path, id);
    await waitFor('the window again', () => w.shown.length === 2);
    second.socket.destroy();
  });

  test('on release: the CLI gets voided', async () => {
    const { h, w, path } = await setup();
    const [id = ''] = await issue(path);
    running(h.stateDir, 'make deploy');
    const answer = call(path, redeemRequest(id));
    await waitFor('the window', () => w.shown.length === 1);
    const released = await call(path, { v, op: 'release', session: SESSION, tickets: [id] });
    assert.ok(released !== null && released.ok && released.op === 'release');
    assert.equal(released.results[0]?.result, 'voided');
    assert.equal(failure(await answer), 'voided');
    assert.equal(w.shown[0]?.signal?.aborted, true);
  });

  test('at the TTL: the CLI gets expired', async () => {
    const clock = new FakeClock();
    const { h, w, path } = await setup({ clock });
    const [id = ''] = await issue(path);
    running(h.stateDir, 'make deploy');
    const answer = call(path, redeemRequest(id));
    await waitFor('the window', () => w.shown.length === 1);
    await clock.advance(TICKET_TTL_MS);
    assert.equal(failure(await answer), 'expired');
    assert.equal(w.shown[0]?.signal?.aborted, true);
  });

  test('a queued window whose CLI goes away is never shown; its ticket is unused again', { timeout: 10000 }, async () => {
    const windows: { resolve: (r: RunResult) => void; signal: AbortSignal | undefined }[] = [];
    const run: Runner = (_command, _args, _timeoutMs, signal) =>
      new Promise((resolve) => {
        windows.push({ resolve, signal });
        signal?.addEventListener('abort', () => resolve({ kind: 'error' }), { once: true });
      });
    const { h, path } = await setup({ dialog: platformDialog(run, 'linux', '/plugin-root') });
    const [a = '', b = ''] = await issue(path, { count: 2 });
    running(h.stateDir, 'make deploy');
    const first = call(path, redeemRequest(a));
    await waitFor('the first window', () => windows.length === 1);
    const queued = await redeemOpen(path, b);
    await pause(100);
    queued.socket.destroy();
    await pause(50);
    windows[0]?.resolve({ kind: 'exit', code: 1, stdout: '' });
    assert.equal(failure(await first), 'denied');
    await pause(50);
    assert.equal(windows.length, 1, 'the queued window never starts');
    const again = await redeemOpen(path, b);
    await waitFor('the window of the ticket given back', () => windows.length === 2);
    again.socket.destroy();
  });
});

describe('redeem: the TTL', () => {
  for (const choice of ['approve', 'deny'] as const) {
    test(`${choice} that arrives at the TTL before its timer ran expires the ticket: nothing fetched, sent or burned`, async () => {
      const clock = new TrackingClock();
      const { h, w, path } = await setup({ clock });
      const issuedAt = clock.now();
      const [id = ''] = await issue(path);
      running(h.stateDir, 'make deploy');
      let fetched = 0;
      const getItem = h.account.getItem.bind(h.account);
      h.account.getItem = async (vaultId, itemId) => {
        fetched++;
        return getItem(vaultId, itemId);
      };
      const answer = call(path, redeemRequest(id));
      await waitFor('the window', () => w.shown.length === 1);
      clock.t = issuedAt + TICKET_TTL_MS;
      assert.equal(clock.overdue(), 1, 'the expiry timer is due but has not run');
      w.shown[0]?.answer(choice);
      const res = await answer;
      assert.equal(failure(res), 'expired');
      assert.ok(!JSON.stringify(res).includes(TOKEN_VALUE));
      assert.equal(fetched, 0, 'nothing fetched');
      assert.equal(existsSync(maskedMarkerPath(h.stateDir, SESSION)), false, 'no marker');
      assert.deepEqual(await call(path, { v, op: 'mask', session: SESSION, tickets: [], output: TOKEN_VALUE }), NO_MASKS);
      assert.equal(clock.overdue(), 0, 'the expiry timer is cleared');
      assert.equal(failure(await call(path, redeemRequest(id))), 'expired', 'not burned');
    });
  }

  for (const ending of ['not_delivered', 'a close'] as const) {
    test(`a fetch approved before the TTL still delivers after it; ${ending} then expires the ticket, the mask kept`, async () => {
      const clock = new FakeClock();
      const l = logged();
      const { h, w, path } = await setup({ clock, operationTimeoutMs: 3_600_000, log: l.log });
      const [id = ''] = await issue(path);
      running(h.stateDir, 'make deploy');
      const fetch = holdFetch(h);
      const { socket, lines } = await redeemOpen(path, id);
      await waitFor('the window', () => w.shown.length === 1);
      w.shown[0]?.answer('approve');
      await waitFor('the fetch', fetch.started);
      await clock.advance(TICKET_TTL_MS + 1);
      fetch.open();
      assert.deepEqual(parseResponse((await lines.next()) ?? '', 'redeem'), { ok: true, op: 'redeem', value: TOKEN_VALUE });
      if (ending === 'not_delivered') {
        socket.write(encodeAck('received'));
        socket.end(encodeAck('not_delivered'));
      } else {
        socket.end(encodeAck('received'));
      }
      await waitFor('the redeem to end', l.redeemEnded);
      assert.equal(failure(await call(path, redeemRequest(id))), 'expired');
      assert.equal(await maskChanged(path, id), true, 'the mask stays armed');
    });
  }
});

describe('redeem: end_session', () => {
  test('while the window is open: the CLI gets voided, the window closes, the ticket is unknown', async () => {
    const { h, w, path } = await setup();
    const [id = ''] = await issue(path);
    running(h.stateDir, 'make deploy');
    const answer = call(path, redeemRequest(id));
    await waitFor('the window', () => w.shown.length === 1);
    assert.deepEqual(await call(path, { v, op: 'end_session', session: SESSION }), { ok: true, op: 'end_session' });
    assert.equal(failure(await answer), 'voided');
    assert.equal(w.shown[0]?.signal?.aborted, true);
    assert.equal(failure(await call(path, redeemRequest(id))), 'unknown');
  });

  const AFTER: [stage: 'sending' | 'received', ending: 'delivered' | 'not_delivered' | 'a close', result: string][] = [
    ['sending', 'delivered', 'session_ended'],
    ['sending', 'a close', 'not_received'],
    ['received', 'not_delivered', 'session_ended'],
    ['received', 'a close', 'session_ended'],
  ];
  for (const [stage, ending, result] of AFTER) {
    test(`after the value left, while ${stage}, then ${ending}: the redeem ends cleanly and arms no expiry`, async () => {
      const clock = new TrackingClock();
      const l = logged();
      const { h, w, path } = await setup({ clock, log: l.log });
      const [id = ''] = await issue(path);
      running(h.stateDir, 'make deploy');
      const { socket, lines } = await redeemOpen(path, id);
      await waitFor('the window', () => w.shown.length === 1);
      w.shown[0]?.answer('approve');
      assert.deepEqual(parseResponse((await lines.next()) ?? '', 'redeem'), { ok: true, op: 'redeem', value: TOKEN_VALUE });
      if (stage === 'received') {
        socket.write(encodeAck('received'));
        await pause(50);
      }
      assert.deepEqual(await call(path, { v, op: 'end_session', session: SESSION }), { ok: true, op: 'end_session' });
      assert.equal(clock.pending.size, 0, 'end_session cleared the expiry');
      if (ending === 'a close') {
        socket.destroy();
      } else {
        if (stage === 'sending') socket.write(encodeAck('received'));
        socket.end(encodeAck(ending));
      }
      await waitFor('the redeem to end', l.redeemEnded);
      assert.deepEqual(
        l.logs.filter((e) => e.op === 'redeem').map((e) => e.result),
        [result],
      );
      assert.equal(clock.pending.size, 0, 'nothing re-armed an expiry for the dropped ticket');
      assert.equal(failure(await call(path, redeemRequest(id))), 'unknown');
      await clock.advance(TICKET_TTL_MS);
      assert.equal(failure(await call(path, redeemRequest(id))), 'unknown');
    });
  }
});

describe('redeem: release while the value is in flight', () => {
  for (const fails of [false, true]) {
    test(`during the fetch (${fails ? 'failing' : 'succeeding'}): in_flight, then the CLI gets voided; no value, no mask, no marker`, async () => {
      const { h, w, path } = await setup();
      const [id = ''] = await issue(path);
      running(h.stateDir, 'make deploy');
      const fetch = holdFetch(h, fails);
      const answer = call(path, redeemRequest(id));
      await waitFor('the window', () => w.shown.length === 1);
      w.shown[0]?.answer('approve');
      await waitFor('the fetch', fetch.started);
      assert.equal(await releaseResult(path, id), 'in_flight');
      fetch.open();
      const res = await answer;
      assert.equal(failure(res), 'voided');
      assert.ok(!JSON.stringify(res).includes(TOKEN_VALUE));
      assert.equal(existsSync(maskedMarkerPath(h.stateDir, SESSION)), false, 'no marker');
      assert.deepEqual(await call(path, { v, op: 'mask', session: SESSION, tickets: [], output: TOKEN_VALUE }), NO_MASKS);
      assert.equal(failure(await call(path, redeemRequest(id))), 'voided');
    });
  }

  test('after arm, while sending: in_flight drops the mask and the marker id; delivered ends the ticket used', async () => {
    const { h, w, path } = await setup();
    const [id = ''] = await issue(path);
    running(h.stateDir, 'make deploy');
    const { socket, lines } = await redeemOpen(path, id);
    await waitFor('the window', () => w.shown.length === 1);
    w.shown[0]?.answer('approve');
    assert.deepEqual(parseResponse((await lines.next()) ?? '', 'redeem'), { ok: true, op: 'redeem', value: TOKEN_VALUE });
    assert.deepEqual(readMarker(h.stateDir, SESSION), [id], 'armed before the value left');
    assert.equal(await releaseResult(path, id), 'in_flight');
    assert.equal(existsSync(maskedMarkerPath(h.stateDir, SESSION)), false, 'the marker id is gone');
    assert.deepEqual(
      await call(path, { v, op: 'mask', session: SESSION, tickets: [], output: `x ${TOKEN_VALUE}` }),
      NO_MASKS,
      "the running command's output is no longer masked",
    );
    socket.write(encodeAck('received'));
    socket.end(encodeAck('delivered'));
    await once(socket, 'close');
    assert.equal(failure(await call(path, redeemRequest(id))), 'used');
  });

  test('during the received wait: in_flight; not_delivered then voids the ticket instead of giving it back', async () => {
    const { h, w, path } = await setup();
    const [id = ''] = await issue(path);
    running(h.stateDir, 'make deploy');
    const { socket, lines } = await redeemOpen(path, id);
    await waitFor('the window', () => w.shown.length === 1);
    w.shown[0]?.answer('approve');
    await lines.next();
    socket.write(encodeAck('received'));
    // Lets the broker read `received`; a release that lands before it (sending) answers the same and ends the same.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await releaseResult(path, id), 'in_flight');
    socket.end(encodeAck('not_delivered'));
    await once(socket, 'close');
    assert.equal(failure(await call(path, redeemRequest(id))), 'voided', 'a released ticket never returns to unused');
    assert.deepEqual(await call(path, { v, op: 'mask', session: SESSION, tickets: [], output: TOKEN_VALUE }), NO_MASKS);
  });
});

describe('redeem: the masks it arms', () => {
  test('two tickets that delivered the same value: releasing one answers mask_kept, releasing the last answers unmasked', async () => {
    const { h, w, path } = await setup();
    const [a = '', b = ''] = await issue(path, { count: 2 });
    running(h.stateDir, 'make deploy');
    for (const [i, id] of [a, b].entries()) {
      const { socket, lines } = await redeemOpen(path, id);
      await waitFor(`window ${i + 1}`, () => w.shown.length === i + 1);
      w.shown[i]?.answer('approve');
      assert.deepEqual(parseResponse((await lines.next()) ?? '', 'redeem'), { ok: true, op: 'redeem', value: TOKEN_VALUE });
      socket.write(encodeAck('received'));
      socket.end(encodeAck('delivered'));
      await once(socket, 'close');
    }
    assert.equal(await releaseResult(path, a), 'mask_kept');
    assert.equal(await maskChanged(path, b), true, 'the value stays masked under the other ticket');
    assert.equal(await releaseResult(path, b), 'unmasked');
    assert.deepEqual(await call(path, { v, op: 'mask', session: SESSION, tickets: [], output: TOKEN_VALUE }), NO_MASKS);
  });

  test('two tickets that delivered the same value, released in one call: both answer unmasked and the value is no longer masked', async () => {
    const { h, w, path } = await setup();
    const [a = '', b = ''] = await issue(path, { count: 2 });
    running(h.stateDir, 'make deploy');
    await deliverAll(w, path, [a, b]);
    const res = await call(path, { v, op: 'release', session: SESSION, tickets: [a, b] });
    assert.deepEqual(res, {
      ok: true,
      op: 'release',
      results: [
        { ticket: a, result: 'unmasked' },
        { ticket: b, result: 'unmasked' },
      ],
    });
    assert.deepEqual(await call(path, { v, op: 'mask', session: SESSION, tickets: [], output: TOKEN_VALUE }), NO_MASKS);
  });

  test('released in one call while a third ticket holds the same value: both answer mask_kept and the value stays masked', async () => {
    const { h, w, path } = await setup();
    const [a = '', b = '', c = ''] = await issue(path, { count: 3 });
    running(h.stateDir, 'make deploy');
    await deliverAll(w, path, [a, b, c]);
    const res = await call(path, { v, op: 'release', session: SESSION, tickets: [a, b] });
    assert.deepEqual(res, {
      ok: true,
      op: 'release',
      results: [
        { ticket: a, result: 'mask_kept' },
        { ticket: b, result: 'mask_kept' },
      ],
    });
    assert.equal(await maskChanged(path, c), true, 'the value stays masked under the ticket outside the call');
  });

  test('a duplicate id while another ticket holds the same value: [a, a] answers one mask_kept and the other still masks', async () => {
    const { h, w, path } = await setup();
    const [a = '', b = ''] = await issue(path, { count: 2 });
    running(h.stateDir, 'make deploy');
    await deliverAll(w, path, [a, b]);
    const res = await call(path, { v, op: 'release', session: SESSION, tickets: [a, a] });
    assert.deepEqual(res, { ok: true, op: 'release', results: [{ ticket: a, result: 'mask_kept' }] });
    assert.equal(await maskChanged(path, b), true, 'the value stays masked under b');
    assert.deepEqual(readMarker(h.stateDir, SESSION), [b]);
  });

  test('duplicate ids of both holders: [a, b, a, b] answers each ticket once unmasked and nothing masks after', async () => {
    const { h, w, path } = await setup();
    const [a = '', b = ''] = await issue(path, { count: 2 });
    running(h.stateDir, 'make deploy');
    await deliverAll(w, path, [a, b]);
    const res = await call(path, { v, op: 'release', session: SESSION, tickets: [a, b, a, b] });
    assert.deepEqual(res, {
      ok: true,
      op: 'release',
      results: [
        { ticket: a, result: 'unmasked' },
        { ticket: b, result: 'unmasked' },
      ],
    });
    assert.deepEqual(await call(path, { v, op: 'mask', session: SESSION, tickets: [], output: TOKEN_VALUE }), NO_MASKS);
    assert.equal(existsSync(maskedMarkerPath(h.stateDir, SESSION)), false, 'the marker is gone');
  });

  test("an owned ticket and another session's ticket that delivered the same value: unmasked and not_owner; the other session still masks", async () => {
    const { h, w, path } = await setup();
    const [a = ''] = await issue(path);
    const [b = ''] = await issue(path, { session: { id: OTHER_SESSION, title: 'Other' } });
    running(h.stateDir, 'make deploy');
    running(h.stateDir, 'make deploy', 'main', OTHER_SESSION);
    await acknowledge(await approveOne(w, path, a));
    await acknowledge(await approveOne(w, path, b, OTHER_SESSION));
    const res = await call(path, { v, op: 'release', session: SESSION, tickets: [a, b] });
    assert.deepEqual(res, {
      ok: true,
      op: 'release',
      results: [
        { ticket: a, result: 'unmasked' },
        { ticket: b, result: 'not_owner' },
      ],
    });
    assert.deepEqual(await call(path, { v, op: 'mask', session: SESSION, tickets: [], output: TOKEN_VALUE }), NO_MASKS);
    assert.deepEqual(
      await call(path, { v, op: 'mask', session: OTHER_SESSION, tickets: [b], output: `x ${TOKEN_VALUE}` }),
      { ok: true, op: 'mask', known: true, changed: true, output: `x <masked ticket=${b}>`, missing: [] },
      'the other session still masks the value',
    );
    assert.deepEqual(readMarker(h.stateDir, OTHER_SESSION), [b], "the other session's marker is untouched");
  });

  test('a ticket in flight released alone answers in_flight; the other holder still masks and the late delivery does not re-arm', async () => {
    const { h, w, path } = await setup();
    const [a = '', b = ''] = await issue(path, { count: 2 });
    running(h.stateDir, 'make deploy');
    await deliverAll(w, path, [a]);
    const flying = await approveOne(w, path, b);
    const res = await call(path, { v, op: 'release', session: SESSION, tickets: [b] });
    assert.deepEqual(res, { ok: true, op: 'release', results: [{ ticket: b, result: 'in_flight' }] });
    assert.equal(await maskChanged(path, a), true, 'the value stays masked under a');
    await acknowledge(flying);
    assert.deepEqual(readMarker(h.stateDir, SESSION), [a]);
    // Had the delivery armed b again, releasing a would answer mask_kept and the value would stay masked.
    const last = await call(path, { v, op: 'release', session: SESSION, tickets: [a] });
    assert.deepEqual(last, { ok: true, op: 'release', results: [{ ticket: a, result: 'unmasked' }] });
    assert.deepEqual(await call(path, { v, op: 'mask', session: SESSION, tickets: [], output: TOKEN_VALUE }), NO_MASKS);
  });

  test('a ticket in flight released with the other holder: in_flight and unmasked; nothing masks, even after the delivery', async () => {
    const { h, w, path } = await setup();
    const [a = '', b = ''] = await issue(path, { count: 2 });
    running(h.stateDir, 'make deploy');
    await deliverAll(w, path, [a]);
    const flying = await approveOne(w, path, b);
    const res = await call(path, { v, op: 'release', session: SESSION, tickets: [b, a] });
    assert.deepEqual(res, {
      ok: true,
      op: 'release',
      results: [
        { ticket: b, result: 'in_flight' },
        { ticket: a, result: 'unmasked' },
      ],
    });
    const nothing: Request = { v, op: 'mask', session: SESSION, tickets: [], output: TOKEN_VALUE };
    assert.deepEqual(await call(path, nothing), NO_MASKS);
    await acknowledge(flying);
    assert.deepEqual(await call(path, nothing), NO_MASKS, 'the late delivery armed nothing');
    assert.equal(existsSync(maskedMarkerPath(h.stateDir, SESSION)), false, 'the marker is gone');
  });

  test('an error while building the mask patterns answers internal with a fixed message', async () => {
    const { h, w, path } = await setup();
    // A lone surrogate makes the URL-encoded needle throw (URIError) when the patterns are built at the first mask.
    const value = `${TOKEN_VALUE}\u{D800}`;
    h.account.items.set(
      VAULT.id,
      (h.account.items.get(VAULT.id) ?? []).map((item) =>
        item.id === ITEM_ID ? { ...item, fields: item.fields.map((f) => (f.id === TOKEN_ID ? { ...f, value } : f)) } : item,
      ),
    );
    const [id = ''] = await issue(path);
    running(h.stateDir, 'make deploy');
    const { socket, lines } = await redeemOpen(path, id);
    await waitFor('the window', () => w.shown.length === 1);
    w.shown[0]?.answer('approve');
    assert.deepEqual(parseResponse((await lines.next()) ?? '', 'redeem'), { ok: true, op: 'redeem', value });
    socket.write(encodeAck('received'));
    socket.end(encodeAck('delivered'));
    await once(socket, 'close');
    assert.deepEqual(await call(path, { v, op: 'mask', session: SESSION, tickets: [id], output: `x ${TOKEN_VALUE}` }), {
      ok: false,
      code: 'internal',
      message: 'The broker could not apply the masks',
    });
  });
});

describe('redeem: a broker that stops', () => {
  function hangingWindows(): { run: Runner; windows: { text: string; signal: AbortSignal | undefined }[] } {
    const windows: { text: string; signal: AbortSignal | undefined }[] = [];
    const run: Runner = (_command, args, _timeoutMs, signal) =>
      new Promise((resolve) => {
        windows.push({ text: args.find((a) => a.startsWith('--text=')) ?? '', signal });
        signal?.addEventListener('abort', () => resolve({ kind: 'error' }), { once: true });
      });
    return { run, windows };
  }

  test('a displaced broker kills its open window, starts no queued one and exits', { timeout: 10000 }, async () => {
    const w = hangingWindows();
    const { h, path } = await setup({ dialog: platformDialog(w.run, 'linux', '/plugin-root') });
    const [a = '', b = ''] = await issue(path, { count: 2 });
    running(h.stateDir, 'make deploy');
    const first = call(path, redeemRequest(a));
    await waitFor('the first window', () => w.windows.length === 1);
    const second = call(path, redeemRequest(b));
    await new Promise((resolve) => setTimeout(resolve, 100));
    unlinkSync(path);
    const replacement = createServer();
    await new Promise<void>((resolve) => replacement.listen(path, resolve));
    try {
      assert.deepEqual([failure(await first), failure(await second)], ['displaced', 'displaced']);
      assert.equal(w.windows[0]?.signal?.aborted, true, 'the open window process is killed');
      assert.equal(w.windows.length, 1, 'the queued window never starts');
      await waitFor('the exit', () => h.exits.length > 0);
      assert.deepEqual(h.exits, [0]);
    } finally {
      replacement.close();
    }
  });

  test('a stuck broker kills its open window and starts no queued one', { timeout: 10000 }, async () => {
    const w = hangingWindows();
    let base: Harness | undefined;
    const { h, path } = await setup({
      dialog: platformDialog(w.run, 'linux', '/plugin-root'),
      operationTimeoutMs: 100,
      connect: (account) => (account === 'COLDACCOUNT' ? new Promise<never>(() => {}) : Promise.resolve((base as Harness).account)),
    });
    base = h;
    const [a = '', b = ''] = await issue(path, { count: 2 });
    running(h.stateDir, 'make deploy');
    const first = call(path, redeemRequest(a));
    await waitFor('the first window', () => w.windows.length === 1);
    const second = call(path, redeemRequest(b));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stuck = call(path, { v, op: 'fields', account: 'COLDACCOUNT', ref: 'op://Deploy/Deploy server' });
    assert.deepEqual([failure(await first), failure(await second), failure(await stuck)], ['auth_timeout', 'auth_timeout', 'auth_timeout']);
    assert.equal(w.windows[0]?.signal?.aborted, true);
    assert.equal(w.windows.length, 1);
    await waitFor('the exit', () => h.exits.length > 0);
    assert.deepEqual(h.exits, [1]);
  });
});
