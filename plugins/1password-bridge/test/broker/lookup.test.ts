import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { describeItem, fetchValue, LookupError, resolveField } from '../../src/broker/lookup.ts';
import { parseFieldRef, parseItemRef } from '../../src/ref.ts';
import {
  fakeAccount,
  ITEM_ID,
  loginItem,
  NOTES_VALUE,
  PASSWORD_VALUE,
  TOKEN_ID,
  TOKEN_VALUE,
  VAULT,
} from './fixtures.ts';

function field(ref: string) {
  return parseFieldRef(ref);
}

async function rejectsWith(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof LookupError, `expected a LookupError, got ${String(err)}`);
    assert.equal(err.code, code);
    if (pattern !== undefined) assert.match(err.message, pattern);
    return true;
  });
}

describe('resolveField', () => {
  test('resolves a token in the untitled default section', async () => {
    const client = fakeAccount();
    const { target, value } = await resolveField(client, field('op://Deploy/Deploy server/api token'));
    assert.equal(value, TOKEN_VALUE);
    assert.deepEqual(
      target,
      {
        vaultId: VAULT.id,
        vaultTitle: 'Deploy',
        itemId: ITEM_ID,
        itemTitle: 'Deploy server',
        category: 'Login',
        fieldId: TOKEN_ID,
        fieldTitle: 'api token',
        sectionId: 'add more',
        sectionTitle: undefined,
        fieldType: 'Concealed',
        attribute: undefined,
        notes: false,
      },
    );
    assert.ok(!JSON.stringify(target).includes(TOKEN_VALUE), 'the target carries no value');
  });

  test('matches the vault by id or by title in any case', async () => {
    const byTitle = await resolveField(fakeAccount(), field('op://deploy/Deploy server/password'));
    const byId = await resolveField(fakeAccount(), field(`op://${VAULT.id}/Deploy server/password`));
    assert.equal(byTitle.value, PASSWORD_VALUE);
    assert.equal(byId.value, PASSWORD_VALUE);
  });

  test('takes an item id straight to getItem without listing items', async () => {
    const client = fakeAccount();
    const { value } = await resolveField(client, field(`op://Deploy/${ITEM_ID}/password`));
    assert.equal(value, PASSWORD_VALUE);
    assert.deepEqual(client.calls, ['listVaults', `getItem ${VAULT.id} ${ITEM_ID}`]);
  });

  test('matches an item title in any case through listItems', async () => {
    const client = fakeAccount();
    await resolveField(client, field('op://Deploy/deploy SERVER/username'));
    assert.deepEqual(client.calls, ['listVaults', `listItems ${VAULT.id}`, `getItem ${VAULT.id} ${ITEM_ID}`]);
  });

  test('matches a field by id', async () => {
    const { value } = await resolveField(fakeAccount(), field(`op://Deploy/Deploy server/${TOKEN_ID}`));
    assert.equal(value, TOKEN_VALUE);
  });

  test('not found: vault, item, field, section', async () => {
    await rejectsWith(resolveField(fakeAccount(), field('op://Nope/Deploy server/password')), 'not_found', /vault "Nope"/);
    await rejectsWith(resolveField(fakeAccount(), field('op://Deploy/Nope/password')), 'not_found', /item "Nope"/);
    await rejectsWith(resolveField(fakeAccount(), field('op://Deploy/Deploy server/nope')), 'not_found', /field "nope"/);
    await rejectsWith(resolveField(fakeAccount(), field('op://Deploy/Services/Nope/token')), 'not_found', /section "Nope"/);
  });

  test('ambiguous: an item title two items share, a field title two sections share', async () => {
    await rejectsWith(resolveField(fakeAccount(), field('op://Deploy/Dup/password')), 'ambiguous', /gggg.*hhhh/);
    await rejectsWith(resolveField(fakeAccount(), field('op://Deploy/Services/token')), 'ambiguous', /f1.*f2/);
  });

  test('ambiguous vault titles', async () => {
    const client = fakeAccount([
      { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', title: 'Shared' },
      { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbb', title: 'shared' },
      { id: 'cccccccccccccccccccccccccc', title: 'SHARED' },
    ]);
    await rejectsWith(resolveField(client, field('op://sHaReD/x/y')), 'ambiguous', /vault/);
  });

  test('a section filter picks one of two same-titled fields, by section title or id', async () => {
    const staging = await resolveField(fakeAccount(), field('op://Deploy/Services/staging/token'));
    assert.equal(staging.value, 'synthetic-staging-token');
    assert.equal(staging.target.sectionTitle, 'Staging');
    const production = await resolveField(fakeAccount(), field('op://Deploy/Services/sec2/token'));
    assert.equal(production.value, 'synthetic-production-token');
  });

  test('an untitled section is matched by its id', async () => {
    const { value } = await resolveField(fakeAccount(), field('op://Deploy/Deploy server/add more/api token'));
    assert.equal(value, TOKEN_VALUE);
  });

  test('a field outside the named section is not found', async () => {
    await rejectsWith(resolveField(fakeAccount(), field('op://Deploy/Deploy server/add more/password')), 'not_found');
  });

  test('an exact-case title wins over other case-insensitive matches', async () => {
    const upper = await resolveField(fakeAccount(), field('op://Deploy/Services/Region'));
    const lower = await resolveField(fakeAccount(), field('op://Deploy/Services/region'));
    assert.equal(upper.value, 'synthetic-region');
    assert.equal(lower.value, 'synthetic-region-lower');
    await rejectsWith(resolveField(fakeAccount(), field('op://Deploy/Services/REGION')), 'ambiguous');
  });

  test('notes and notesPlain resolve to the item notes when no field takes the name', async () => {
    for (const segment of ['notes', 'notesPlain']) {
      const { target, value } = await resolveField(fakeAccount(), field(`op://Deploy/Recovery/${segment}`));
      assert.equal(value, NOTES_VALUE);
      assert.equal(target.notes, true);
      assert.equal(target.fieldId, 'notes');
      assert.equal(target.fieldType, 'Notes');
    }
  });

  test('a field titled notes wins over the item notes', async () => {
    const item = loginItem();
    item.fields.push({ id: 'n1', title: 'notes', fieldType: 'Text', value: 'synthetic-field-notes' });
    const client = fakeAccount(undefined, { [VAULT.id]: [item] });
    const { target, value } = await resolveField(client, field('op://Deploy/Deploy server/notes'));
    assert.equal(value, 'synthetic-field-notes');
    assert.equal(target.notes, false);
  });

  test('the notes fallback does not apply inside a section', async () => {
    await rejectsWith(resolveField(fakeAccount(), field('op://Deploy/Deploy server/add more/notes')), 'not_found');
  });

  test('otp reads the current code', async () => {
    const { target, value } = await resolveField(fakeAccount(), field('op://Deploy/Deploy server/one-time password?attribute=otp'));
    assert.equal(value, '123456');
    assert.equal(target.attribute, 'otp');
    assert.equal(target.fieldType, 'Totp');
  });

  test('the Totp field without an attribute is its seed', async () => {
    const { value, target } = await resolveField(fakeAccount(), field('op://Deploy/Deploy server/one-time password'));
    assert.match(value, /^otpauth:/);
    assert.equal(target.attribute, undefined);
  });

  test('otp on a field that has no code is not found', async () => {
    await rejectsWith(resolveField(fakeAccount(), field('op://Deploy/Deploy server/password?attribute=otp')), 'not_found', /one-time/);
    const item = loginItem();
    const totp = item.fields[2] as { details?: unknown };
    totp.details = { type: 'Otp', content: { errorMessage: 'invalid TOTP seed SYNTHETICSEEDJBSWY3DPEHPK3PXP' } };
    const client = fakeAccount(undefined, { [VAULT.id]: [item] });
    await rejectsWith(resolveField(client, field('op://Deploy/Deploy server/one-time password?attribute=otp')), 'not_found', /one-time password.*Deploy server/);
  });

  test('the SDK text of a failed one-time code stays out of the error, which may quote the seed', async () => {
    const item = loginItem();
    const totp = item.fields[2] as { details?: unknown };
    totp.details = { type: 'Otp', content: { errorMessage: 'invalid TOTP seed SYNTHETICSEEDJBSWY3DPEHPK3PXP' } };
    const client = fakeAccount(undefined, { [VAULT.id]: [item] });
    await assert.rejects(resolveField(client, field('op://Deploy/Deploy server/one-time password?attribute=otp')), (err: unknown) => {
      assert.ok(err instanceof LookupError);
      assert.ok(!err.message.includes('SYNTHETICSEED'), err.message);
      assert.ok(!err.message.includes('invalid TOTP seed'), err.message);
      return true;
    });
  });

  test('public-key and fingerprint read the SSH key details; private-key is the value', async () => {
    const pub = await resolveField(fakeAccount(), field('op://Deploy/Deploy key/private key?attribute=public-key'));
    assert.equal(pub.value, 'ssh-ed25519 SYNTHETICPUBLIC');
    assert.equal(pub.target.attribute, 'public-key');
    const fp = await resolveField(fakeAccount(), field('op://Deploy/Deploy key/private key?attribute=fingerprint'));
    assert.equal(fp.value, 'SHA256:synthetic');
    assert.equal(fp.target.attribute, 'fingerprint');
    const priv = await resolveField(fakeAccount(), field('op://Deploy/Deploy key/private key?attribute=private-key'));
    assert.equal(priv.value, 'synthetic-private-key-material');
    assert.equal(priv.target.attribute, undefined, 'private-key is the field value itself');
  });

  test('SSH attributes on a field without key details are not found', async () => {
    await rejectsWith(resolveField(fakeAccount(), field('op://Deploy/Deploy server/password?attribute=public-key')), 'not_found');
    await rejectsWith(resolveField(fakeAccount(), field('op://Deploy/Deploy server/password?attribute=private-key')), 'not_found');
  });
});

describe('fetchValue', () => {
  test('fetches the item again, so an OTP code is fresh', async () => {
    const client = fakeAccount();
    const { target } = await resolveField(client, field('op://Deploy/Deploy server/one-time password?attribute=otp'));
    client.items.set(VAULT.id, [loginItem('654321')]);
    client.calls.length = 0;
    assert.equal(await fetchValue(client, target), '654321');
    assert.deepEqual(client.calls, [`getItem ${VAULT.id} ${ITEM_ID}`]);
  });

  test('fetches notes and plain fields by their resolved ids', async () => {
    const client = fakeAccount();
    const notes = await resolveField(client, field('op://Deploy/Recovery/notes'));
    assert.equal(await fetchValue(client, notes.target), NOTES_VALUE);
    const token = await resolveField(client, field('op://Deploy/Deploy server/api token'));
    assert.equal(await fetchValue(client, token.target), TOKEN_VALUE);
  });

  test('a field removed since the lookup is not found', async () => {
    const client = fakeAccount();
    const { target } = await resolveField(client, field('op://Deploy/Deploy server/password'));
    const item = loginItem();
    item.fields = item.fields.filter((f) => f.id !== 'password');
    client.items.set(VAULT.id, [item]);
    await rejectsWith(fetchValue(client, target), 'not_found');
  });
});

describe('describeItem', () => {
  test('lists every field with its id, section and masked flag, and no value', async () => {
    const result = await describeItem(fakeAccount(), parseItemRef('op://Deploy/Deploy server'));
    assert.deepEqual(result, {
      vault: 'Deploy',
      item: { title: 'Deploy server', category: 'Login' },
      fields: [
        { id: 'username', title: 'username', type: 'Text', masked: false },
        { id: 'password', title: 'password', type: 'Concealed', masked: true },
        { id: 'TOTP_cccccccccccccccccccccccccc', title: 'one-time password', type: 'Totp', masked: true },
        { id: TOKEN_ID, title: 'api token', sectionId: 'add more', type: 'Concealed', masked: true },
        { id: 'notes', title: 'notes', type: 'Notes', masked: true },
      ],
    });
    const text = JSON.stringify(result);
    for (const secret of [TOKEN_VALUE, PASSWORD_VALUE, NOTES_VALUE, 'synthetic-user', 'SYNTHETICSEED']) {
      assert.ok(!text.includes(secret), `${secret} must not appear`);
    }
  });

  test('names titled sections, flags a short secret as not masked, omits empty notes', async () => {
    const result = await describeItem(fakeAccount(), parseItemRef('op://Deploy/Services'));
    const byId = new Map(result.fields.map((f) => [f.id, f]));
    assert.equal(byId.get('f1')?.section, 'Staging');
    assert.equal(byId.get('f3')?.masked, false);
    assert.equal(byId.has('notes'), false);
  });

  test('not found and ambiguous items', async () => {
    await rejectsWith(describeItem(fakeAccount(), parseItemRef('op://Deploy/Nope')), 'not_found');
    await rejectsWith(describeItem(fakeAccount(), parseItemRef('op://Deploy/Dup')), 'ambiguous');
  });

  test('an untitled vault, item and field are listed and resolved by id', async () => {
    const vault = { id: 'zzzzzzzzzzzzzzzzzzzzzzzzzz', title: '' };
    const item = {
      id: 'item-1',
      title: '',
      category: 'Login',
      notes: '',
      sections: [{ id: 's-1', title: '' }],
      fields: [{ id: 'f-1', title: '', sectionId: 's-1', fieldType: 'Concealed', value: 'synthetic-untitled-secret' }],
    };
    const client = fakeAccount([vault], { [vault.id]: [item] });
    const result = await describeItem(client, parseItemRef(`op://${vault.id}/item-1`));
    assert.deepEqual(result, {
      vault: '',
      item: { title: '', category: 'Login' },
      fields: [{ id: 'f-1', title: '', type: 'Concealed', masked: true, sectionId: 's-1' }],
    });
    const { target, value } = await resolveField(client, field(`op://${vault.id}/item-1/f-1`));
    assert.equal(value, 'synthetic-untitled-secret');
    assert.equal(target.vaultId, vault.id);
    assert.equal(target.itemId, 'item-1');
    assert.equal(target.fieldId, 'f-1');
    assert.equal(target.fieldTitle, '');
    assert.equal(target.sectionId, 's-1');
  });
});

describe('fetchValue of a deleted item', () => {
  test('is not_found, so a redeem reports field_gone', async () => {
    const account = fakeAccount();
    const { target } = await resolveField(account, parseFieldRef('op://Deploy/Deploy server/api token'));
    account.items.set(VAULT.id, (account.items.get(VAULT.id) ?? []).filter((item) => item.id !== ITEM_ID));
    await assert.rejects(fetchValue(account, target), (err: unknown) => err instanceof LookupError && err.code === 'not_found');
  });
});
