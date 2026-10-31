/**
 * Synthetic 1Password data for the broker tests. Ids are made up; values are
 * marked `synthetic` so a test can assert none of them leaks.
 */

import type { AccountClient, ItemInfo } from '../../src/broker/onepassword.ts';

export const VAULT = { id: 'qwertyuiopasdfghjklzxcvbnm', title: 'Deploy' };
export const OTHER_VAULT = { id: 'mnbvcxzlkjhgfdsapoiuytrewq', title: 'Private' };

export const ITEM_ID = 'abcdefghijklmnopqrstuvwxyz';
export const TOKEN_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
export const TOTP_ID = 'TOTP_cccccccccccccccccccccccccc';
export const TOKEN_VALUE = 'synthetic-api-token-value';
export const PASSWORD_VALUE = 'synthetic-password-1';
export const NOTES_VALUE = 'synthetic notes of the item';

/**
 * A Login as the 1Password app creates it: username, password, a one-time
 * password, and a token in the untitled default section `add more`.
 */
export function loginItem(code = '123456'): ItemInfo {
  return {
    id: ITEM_ID,
    title: 'Deploy server',
    category: 'Login',
    notes: NOTES_VALUE,
    sections: [{ id: 'add more', title: '' }],
    fields: [
      { id: 'username', title: 'username', fieldType: 'Text', value: 'synthetic-user' },
      { id: 'password', title: 'password', fieldType: 'Concealed', value: PASSWORD_VALUE },
      {
        id: TOTP_ID,
        title: 'one-time password',
        fieldType: 'Totp',
        value: 'otpauth://totp/synthetic?secret=SYNTHETICSEED',
        details: { type: 'Otp', content: { code } },
      },
      { id: TOKEN_ID, title: 'api token', sectionId: 'add more', fieldType: 'Concealed', value: TOKEN_VALUE },
    ],
  };
}

/** Two fields titled `token` in two titled sections, and a short secret. */
export function servicesItem(): ItemInfo {
  return {
    id: 'dddddddddddddddddddddddddd',
    title: 'Services',
    category: 'ApiCredentials',
    notes: '',
    sections: [
      { id: 'sec1', title: 'Staging' },
      { id: 'sec2', title: 'Production' },
    ],
    fields: [
      { id: 'f1', title: 'token', sectionId: 'sec1', fieldType: 'Concealed', value: 'synthetic-staging-token' },
      { id: 'f2', title: 'token', sectionId: 'sec2', fieldType: 'Concealed', value: 'synthetic-production-token' },
      { id: 'f3', title: 'pin', fieldType: 'Concealed', value: 'syn' },
      { id: 'f4', title: 'Region', fieldType: 'Text', value: 'synthetic-region' },
      { id: 'f5', title: 'region', fieldType: 'Text', value: 'synthetic-region-lower' },
    ],
  };
}

export function sshItem(): ItemInfo {
  return {
    id: 'eeeeeeeeeeeeeeeeeeeeeeeeee',
    title: 'Deploy key',
    category: 'SshKey',
    notes: '',
    sections: [],
    fields: [
      {
        id: 'private_key',
        title: 'private key',
        fieldType: 'SshKey',
        value: 'synthetic-private-key-material',
        details: { type: 'SshKey', content: { publicKey: 'ssh-ed25519 SYNTHETICPUBLIC', fingerprint: 'SHA256:synthetic', keyType: 'Ed25519' } },
      },
    ],
  };
}

export function noteItem(): ItemInfo {
  return { id: 'ffffffffffffffffffffffffff', title: 'Recovery', category: 'SecureNote', notes: NOTES_VALUE, sections: [], fields: [] };
}

/** Two items share the title `Dup`. */
export function duplicateItems(): ItemInfo[] {
  return [
    { id: 'gggggggggggggggggggggggggg', title: 'Dup', category: 'Password', notes: '', sections: [], fields: [] },
    { id: 'hhhhhhhhhhhhhhhhhhhhhhhhhh', title: 'Dup', category: 'Password', notes: '', sections: [], fields: [] },
  ];
}

export interface FakeAccount extends AccountClient {
  /** Every call, as `listVaults`, `listItems <vault>` or `getItem <vault> <item>`. */
  calls: string[];
  /** The items of each vault by vault id; tests may replace them between calls. */
  items: Map<string, ItemInfo[]>;
}

export function fakeAccount(
  vaults: { id: string; title: string }[] = [VAULT, OTHER_VAULT],
  items: Record<string, ItemInfo[]> = {
    [VAULT.id]: [loginItem(), servicesItem(), sshItem(), noteItem(), ...duplicateItems()],
    [OTHER_VAULT.id]: [],
  },
): FakeAccount {
  const calls: string[] = [];
  const map = new Map(Object.entries(items));
  return {
    calls,
    items: map,
    async listVaults() {
      calls.push('listVaults');
      return vaults.map((v) => ({ ...v }));
    },
    async listItems(vaultId) {
      calls.push(`listItems ${vaultId}`);
      return (map.get(vaultId) ?? []).map((i) => ({ id: i.id, title: i.title, category: i.category }));
    },
    async getItem(vaultId, itemId) {
      calls.push(`getItem ${vaultId} ${itemId}`);
      const item = (map.get(vaultId) ?? []).find((i) => i.id === itemId);
      if (item === undefined) throw new Error('item not found');
      return structuredClone(item);
    },
  };
}
