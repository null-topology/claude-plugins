import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountError,
  knownAccounts,
  listOpAccounts,
  parseConfigured,
  parseOpAccounts,
  resolveAccount,
  type OpAccount,
} from '../../src/mcp/accounts.ts';

/** Synthetic accounts; none of them exists. */
const PERSONAL: OpAccount = { uuid: 'AAAAAAAAAAAAAAAAAAAAAAAAAA', url: 'my.1password.test', email: 'someone@example.test' };
const WORK: OpAccount = { uuid: 'BBBBBBBBBBBBBBBBBBBBBBBBBB', url: 'https://work.1password.test', email: 'someone@work.example.test' };
const SECOND_PERSONAL: OpAccount = { uuid: 'CCCCCCCCCCCCCCCCCCCCCCCCCC', url: 'my.1password.test', email: 'other@example.test' };

const OP_JSON = JSON.stringify([
  { url: PERSONAL.url, email: PERSONAL.email, user_uuid: 'U1', account_uuid: PERSONAL.uuid },
  { url: WORK.url, email: WORK.email, user_uuid: 'U2', account_uuid: WORK.uuid },
]);

describe('parseOpAccounts', () => {
  test('reads the account UUID, URL and email of each entry of `op account list --format json`', () => {
    assert.deepEqual(parseOpAccounts(OP_JSON), [PERSONAL, WORK]);
  });

  test('skips entries without an account UUID and treats empty output as no accounts', () => {
    assert.deepEqual(parseOpAccounts(JSON.stringify([{ url: 'x.test' }, { account_uuid: 'D1', email: 7 }])), [{ uuid: 'D1' }]);
    assert.deepEqual(parseOpAccounts(''), []);
    assert.deepEqual(parseOpAccounts('  \n'), []);
  });

  test('rejects output that is not a JSON array', () => {
    assert.throws(() => parseOpAccounts('{}'));
    assert.throws(() => parseOpAccounts('not json'));
  });
});

describe('parseConfigured', () => {
  test('splits on commas, trims, drops empty and repeated entries', () => {
    assert.deepEqual(parseConfigured(' Work , ,my.1password.test,work,'), ['Work', 'my.1password.test']);
    assert.deepEqual(parseConfigured(undefined), []);
    assert.deepEqual(parseConfigured(''), []);
  });

  test('ignores an unsubstituted ${user_config...} placeholder', () => {
    assert.deepEqual(parseConfigured('${user_config.accounts}'), []);
  });
});

describe('knownAccounts', () => {
  test('an op account goes to the broker by UUID and is labelled `<url> · <email>`', () => {
    const [account] = knownAccounts([PERSONAL], []);
    assert.equal(account?.id, PERSONAL.uuid);
    assert.equal(account?.label, 'my.1password.test · someone@example.test');
    assert.equal(account?.source, 'op');
  });

  test('the label drops the scheme of the URL and falls back to the UUID', () => {
    const [work, bare] = knownAccounts([WORK, { uuid: 'D1' }], []);
    assert.equal(work?.label, 'work.1password.test · someone@work.example.test');
    assert.equal(bare?.label, 'D1');
  });

  test('a configured entry goes to the broker verbatim and is labelled with itself', () => {
    const [account] = knownAccounts([], ['My Team']);
    assert.deepEqual(account, { id: 'My Team', label: 'My Team', aliases: [], source: 'configured' });
  });

  test('a configured entry equal to a discovered UUID or URL host merges into that account', () => {
    const accounts = knownAccounts([PERSONAL, WORK], [PERSONAL.uuid.toLowerCase(), 'WORK.1password.test', 'Elsewhere']);
    assert.equal(accounts.length, 3);
    assert.deepEqual(accounts[0]?.aliases, [PERSONAL.uuid.toLowerCase()]);
    assert.deepEqual(accounts[1]?.aliases, ['WORK.1password.test']);
    assert.equal(accounts[2]?.id, 'Elsewhere');
  });
});

describe('resolveAccount', () => {
  const accounts = knownAccounts([PERSONAL, WORK], ['My Team', 'work.1password.test']);

  test('matches a UUID, a URL with or without https://, an email or a configured entry, ignoring case', () => {
    assert.equal(resolveAccount(accounts, PERSONAL.uuid.toLowerCase()).id, PERSONAL.uuid);
    assert.equal(resolveAccount(accounts, 'my.1password.test').id, PERSONAL.uuid);
    assert.equal(resolveAccount(accounts, 'https://MY.1password.test/').id, PERSONAL.uuid);
    assert.equal(resolveAccount(accounts, 'work.1password.test').id, WORK.uuid);
    assert.equal(resolveAccount(accounts, 'SOMEONE@work.example.test').id, WORK.uuid);
    assert.equal(resolveAccount(accounts, 'my team').id, 'My Team');
  });

  test('a merged configured entry resolves to the discovered account', () => {
    const merged = knownAccounts([PERSONAL], ['Personal Alias', PERSONAL.uuid]);
    assert.equal(merged.length, 2);
    assert.equal(resolveAccount(merged, PERSONAL.uuid).id, PERSONAL.uuid);
  });

  test('a value matching several accounts is an error that lists them', () => {
    const twins = knownAccounts([PERSONAL, SECOND_PERSONAL], []);
    assert.throws(
      () => resolveAccount(twins, 'my.1password.test'),
      (err: unknown) =>
        err instanceof AccountError &&
        err.message.includes('matches 2 accounts') &&
        err.message.includes(PERSONAL.uuid) &&
        err.message.includes(SECOND_PERSONAL.uuid),
    );
    assert.equal(resolveAccount(twins, 'other@example.test').id, SECOND_PERSONAL.uuid);
  });

  test('a value matching nothing is an error that lists the known accounts', () => {
    assert.throws(
      () => resolveAccount(accounts, 'nowhere.test'),
      (err: unknown) => err instanceof AccountError && err.message.includes('nowhere.test') && err.message.includes(WORK.uuid),
    );
  });

  test('no argument picks the only account and refuses when there are several or none', () => {
    const single = knownAccounts([WORK], []);
    assert.equal(resolveAccount(single, undefined).id, WORK.uuid);
    assert.equal(resolveAccount(single, '').id, WORK.uuid);
    assert.throws(
      () => resolveAccount(accounts, undefined),
      (err: unknown) => err instanceof AccountError && err.message.includes(PERSONAL.uuid) && err.message.includes('My Team'),
    );
    assert.throws(
      () => resolveAccount([], undefined),
      (err: unknown) => err instanceof AccountError && /op CLI/.test(err.message) && /accounts/.test(err.message),
    );
  });
});

describe('listOpAccounts', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-accounts-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A fake `op` on a PATH that holds nothing else. */
  function fakeOp(script: string): Record<string, string> {
    writeFileSync(join(dir, 'op'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return { PATH: dir };
  }

  test('runs `op account list --format json` and parses its output', async () => {
    const env = fakeOp(`[ "$*" = "account list --format json" ] || exit 3\nprintf '%s' '${OP_JSON}'`);
    assert.deepEqual(await listOpAccounts(env), { ok: true, accounts: [PERSONAL, WORK] });
  });

  test('a missing op is reported as missing, not as an error', async () => {
    assert.deepEqual(await listOpAccounts({ PATH: dir }), { ok: false, reason: 'missing' });
  });

  test('a failing op, unparsable output and a timeout are reported as failed', async () => {
    assert.deepEqual(await listOpAccounts(fakeOp('exit 1')), { ok: false, reason: 'failed' });
    assert.deepEqual(await listOpAccounts(fakeOp("printf 'garbage'")), { ok: false, reason: 'failed' });
    const started = Date.now();
    assert.deepEqual(await listOpAccounts(fakeOp('exec /bin/sleep 5'), 200), { ok: false, reason: 'failed' });
    assert.ok(Date.now() - started < 3000, 'the timeout ended the run');
  });
});
