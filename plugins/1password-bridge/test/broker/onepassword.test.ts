import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { describeItem } from '../../src/broker/lookup.ts';
import { accountClient, connectDesktop, INTEGRATION_NAME, type SdkClient, type SdkModule } from '../../src/broker/onepassword.ts';
import { encodeLine, parseResponse, type Response } from '../../src/protocol.ts';
import { parseItemRef } from '../../src/ref.ts';
import * as stub from '../../src/sdk-core-stub.ts';
import { VERSION } from '../../src/version.ts';

function fakeSdkClient(calls: unknown[][]): SdkClient {
  return {
    vaults: {
      async list() {
        calls.push(['vaults.list']);
        return [{ id: 'v1', title: 'Vault', description: 'ignored' } as { id: string; title: string }];
      },
    },
    items: {
      async list(vaultId, ...filters) {
        calls.push(['items.list', vaultId, ...filters]);
        return [{ id: 'i1', title: 'Item', category: 'Login', vaultId, websites: [] } as { id: string; title: string; category: string }];
      },
      async get(vaultId, itemId) {
        calls.push(['items.get', vaultId, itemId]);
        return {
          id: itemId,
          title: 'Item',
          category: 'Login',
          vaultId,
          notes: 'synthetic notes',
          tags: ['ignored'],
          sections: [{ id: 's1', title: 'Section' }],
          fields: [
            { id: 'f1', title: 'token', sectionId: 's1', fieldType: 'Concealed', value: 'synthetic-value' },
            { id: 'f2', title: 'otp', fieldType: 'Totp', value: 'otpauth://synthetic', details: { type: 'Otp', content: { code: '000000' } } },
          ],
        };
      },
    },
  };
}

describe('accountClient', () => {
  test('lists vaults as id and title', async () => {
    const calls: unknown[][] = [];
    assert.deepEqual(await accountClient(fakeSdkClient(calls)).listVaults(), [{ id: 'v1', title: 'Vault' }]);
    assert.deepEqual(calls, [['vaults.list']]);
  });

  test('lists only active items, as id, title and category', async () => {
    const calls: unknown[][] = [];
    assert.deepEqual(await accountClient(fakeSdkClient(calls)).listItems('v1'), [{ id: 'i1', title: 'Item', category: 'Login' }]);
    assert.deepEqual(calls, [['items.list', 'v1', { type: 'ByState', content: { active: true, archived: false } }]]);
  });

  test('gets an item with its notes, sections and fields', async () => {
    const calls: unknown[][] = [];
    const item = await accountClient(fakeSdkClient(calls)).getItem('v1', 'i1');
    assert.deepEqual(item, {
      id: 'i1',
      title: 'Item',
      category: 'Login',
      notes: 'synthetic notes',
      sections: [{ id: 's1', title: 'Section' }],
      fields: [
        { id: 'f1', title: 'token', sectionId: 's1', fieldType: 'Concealed', value: 'synthetic-value' },
        { id: 'f2', title: 'otp', fieldType: 'Totp', value: 'otpauth://synthetic', details: { type: 'Otp', content: { code: '000000' } } },
      ],
    });
    assert.deepEqual(calls, [['items.get', 'v1', 'i1']]);
  });
});

const LOGIN_ID = 'kkkkkkkkkkkkkkkkkkkkkkkkkk';

/** An SDK client whose one item comes back with nulls where its JSON leaves an optional field unset. */
function nullishSdkClient(): SdkClient {
  return {
    vaults: {
      async list() {
        return [{ id: 'v1', title: 'Vault' }];
      },
    },
    items: {
      async list() {
        return [{ id: LOGIN_ID, title: 'Login', category: 'Login' }];
      },
      async get(_vaultId, itemId) {
        return {
          id: itemId,
          title: 'Login',
          category: 'Login',
          notes: null,
          sections: [
            { id: 's1', title: 'Extra' },
            { id: 's2', title: null },
          ],
          fields: [
            { id: 'username', title: 'username', sectionId: null, fieldType: 'Text', value: 'synthetic-user', details: null },
            { id: 'password', title: 'password', sectionId: null, fieldType: 'Concealed', value: 'synthetic-password' },
            { id: 'f3', title: 'token', sectionId: 's1', fieldType: 'Concealed', value: 'synthetic-token-value' },
          ],
        };
      },
    },
  };
}

describe('SDK nulls', () => {
  test('a field outside any section, sent with sectionId null, lists without sectionId and the answer parses', async () => {
    const description = await describeItem(accountClient(nullishSdkClient()), parseItemRef('op://Vault/Login'));
    const [username, password, token] = description.fields;
    assert.equal(username !== undefined && 'sectionId' in username, false);
    assert.equal(password !== undefined && 'sectionId' in password, false);
    assert.equal(token?.sectionId, 's1');
    assert.equal(token?.section, 'Extra');
    const answer: Response = { ok: true, op: 'fields', ...description };
    assert.deepEqual(parseResponse(encodeLine(answer).trimEnd(), 'fields'), answer);
  });

  test('getItem drops null section ids and details, and reads null notes and section titles as empty', async () => {
    const item = await accountClient(nullishSdkClient()).getItem('v1', LOGIN_ID);
    assert.deepEqual(item, {
      id: LOGIN_ID,
      title: 'Login',
      category: 'Login',
      notes: '',
      sections: [
        { id: 's1', title: 'Extra' },
        { id: 's2', title: '' },
      ],
      fields: [
        { id: 'username', title: 'username', fieldType: 'Text', value: 'synthetic-user' },
        { id: 'password', title: 'password', fieldType: 'Concealed', value: 'synthetic-password' },
        { id: 'f3', title: 'token', sectionId: 's1', fieldType: 'Concealed', value: 'synthetic-token-value' },
      ],
    });
  });
});

describe('connectDesktop', () => {
  test('creates a desktop-authenticated client for the account under the plugin name and version', async () => {
    const configs: unknown[] = [];
    class FakeDesktopAuth {
      accountName: string;
      constructor(accountName: string) {
        this.accountName = accountName;
      }
    }
    const sdk: SdkModule = {
      DesktopAuth: FakeDesktopAuth,
      async createClient(config) {
        configs.push(config);
        return fakeSdkClient([]);
      },
    };
    const client = await connectDesktop('ACCOUNTUUID', async () => sdk);
    assert.equal(configs.length, 1);
    const config = configs[0] as { auth: unknown; integrationName: string; integrationVersion: string };
    assert.ok(config.auth instanceof FakeDesktopAuth);
    assert.equal((config.auth as FakeDesktopAuth).accountName, 'ACCOUNTUUID');
    assert.equal(config.integrationName, INTEGRATION_NAME);
    assert.equal(INTEGRATION_NAME, '1Password Bridge');
    assert.equal(config.integrationVersion, VERSION);
    assert.deepEqual(await client.listVaults(), [{ id: 'v1', title: 'Vault' }]);
  });

  test('a failed connect rejects with the SDK error', async () => {
    const sdk: SdkModule = {
      DesktopAuth: class {
        accountName: string;
        constructor(accountName: string) {
          this.accountName = accountName;
        }
      },
      async createClient() {
        throw new Error('IPC operation failed: -3');
      },
    };
    await assert.rejects(connectDesktop('ACCOUNTUUID', async () => sdk), /IPC operation failed: -3/);
  });
});

describe('sdk-core stub', () => {
  test('every wasm core entry point refuses', async () => {
    const message = /1password-bridge ships desktop authentication only/;
    await assert.rejects(async () => stub.init_client('{}'), message);
    await assert.rejects(async () => stub.init_client_oidc('{}', async () => ''), message);
    await assert.rejects(async () => stub.invoke('{}'), message);
    assert.throws(() => stub.invoke_sync('{}'), message);
    assert.throws(() => stub.release_client('id'), message);
  });
});
