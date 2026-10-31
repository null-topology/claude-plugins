import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { maskedMarkerPath } from '../../src/paths.ts';
import { TICKET_ID_PATTERN, type Response } from '../../src/protocol.ts';
import { markTicket } from '../../src/session-files.ts';
import { PROTOCOL_VERSION } from '../../src/version.ts';
import { TOKEN_VALUE } from './fixtures.ts';
import { call, harness, issue, issueRequest, OTHER_SESSION, SESSION, type Harness } from './harness.ts';

const v = PROTOCOL_VERSION;
let h: Harness;

beforeEach(async () => {
  h = harness();
  await h.start();
});

afterEach(() => h.cleanup());

function failure(res: Response | null): string {
  return res !== null && !res.ok ? res.code : `not a failure: ${JSON.stringify(res)}`;
}

describe('issue_tickets', () => {
  test('returns ids, the expiry and a field summary; no value, no window', async () => {
    const res = await call(h.options.socketPath, issueRequest({ count: 3 }));
    assert.ok(res !== null && res.ok && res.op === 'issue_tickets');
    assert.equal(res.tickets.length, 3);
    for (const id of res.tickets) assert.match(id, TICKET_ID_PATTERN);
    assert.ok(Date.parse(res.expiresAt) > Date.now() + 9 * 60 * 1000);
    assert.equal(res.field.vault, 'Deploy');
    assert.equal(res.field.item, 'Deploy server');
    assert.equal(res.field.field, 'api token');
    assert.equal(res.field.type, 'Concealed');
    assert.equal(res.field.masked, true);
    assert.equal(res.field.short, false);
    assert.ok(!JSON.stringify(res).includes(TOKEN_VALUE));
  });

  test('a short secret is summarised as short and unmasked', async () => {
    const res = await call(h.options.socketPath, issueRequest({ ref: 'op://Deploy/Services/pin' }));
    assert.ok(res !== null && res.ok && res.op === 'issue_tickets');
    assert.equal(res.field.item, 'Services');
    assert.equal(res.field.field, 'pin');
    assert.equal(res.field.type, 'Concealed');
    assert.equal(res.field.short, true);
    assert.equal(res.field.masked, false);
  });

  test('a one-time password names the attribute in its type and is unmasked', async () => {
    const res = await call(h.options.socketPath, issueRequest({ ref: 'op://Deploy/Deploy server/one-time password?attribute=otp' }));
    assert.ok(res !== null && res.ok && res.op === 'issue_tickets');
    assert.equal(res.field.field, 'one-time password');
    assert.equal(res.field.type, 'Totp (otp)');
    assert.equal(res.field.masked, false);
    assert.ok(!JSON.stringify(res).includes('otpauth://'));
  });

  test('fails when the field does not resolve or the reference is malformed', async () => {
    assert.equal(failure(await call(h.options.socketPath, issueRequest({ ref: 'op://Deploy/Deploy server/no such field' }))), 'not_found');
    assert.equal(failure(await call(h.options.socketPath, issueRequest({ ref: 'not a reference' }))), 'bad_ref');
  });
});

describe('release', () => {
  test('voids an unused ticket, refuses another session\'s, reports an unknown one', async () => {
    const [mine] = await issue(h.options.socketPath);
    const [theirs] = await issue(h.options.socketPath, { session: { id: OTHER_SESSION } });
    const res = await call(h.options.socketPath, {
      v,
      op: 'release',
      session: SESSION,
      tickets: [mine ?? '', theirs ?? '', 'tkt_zzzzzzzzzzzzzzzz'],
    });
    assert.deepEqual(res, {
      ok: true,
      op: 'release',
      results: [
        { ticket: mine, result: 'voided' },
        { ticket: theirs, result: 'not_owner' },
        { ticket: 'tkt_zzzzzzzzzzzzzzzz', result: 'unknown' },
      ],
    });
  });

  test('removes the ids from the marker also when the broker does not know them', async () => {
    markTicket(h.stateDir, SESSION, 'tkt_zzzzzzzzzzzzzzzz');
    await call(h.options.socketPath, { v, op: 'release', session: SESSION, tickets: ['tkt_zzzzzzzzzzzzzzzz'] });
    assert.equal(existsSync(maskedMarkerPath(h.stateDir, SESSION)), false);
  });
});

describe('mask and end_session', () => {
  test('mask of a session without masks answers known: false, with or without marker ids; missing names every marker id', async () => {
    for (const tickets of [[], ['tkt_zzzzzzzzzzzzzzzz'], ['tkt_yyyyyyyyyyyyyyyy', 'tkt_zzzzzzzzzzzzzzzz', 'tkt_yyyyyyyyyyyyyyyy']]) {
      assert.deepEqual(await call(h.options.socketPath, { v, op: 'mask', session: SESSION, tickets, output: 'hello' }), {
        ok: true,
        op: 'mask',
        known: false,
        changed: false,
        output: null,
        missing: [...new Set(tickets)],
      });
    }
  });

  test('end_session forgets the session\'s tickets', async () => {
    const [id] = await issue(h.options.socketPath);
    assert.deepEqual(await call(h.options.socketPath, { v, op: 'end_session', session: SESSION }), { ok: true, op: 'end_session' });
    const res = await call(h.options.socketPath, { v, op: 'release', session: SESSION, tickets: [id ?? ''] });
    assert.ok(res !== null && res.ok && res.op === 'release');
    assert.equal(res.results[0]?.result, 'unknown');
  });
});
