/**
 * The broker's view of one 1Password account, and its implementation on the
 * 1Password SDK with desktop authentication.
 *
 * Every call here may make the 1Password app ask the user to authorize, so
 * nothing calls an AccountClient except through the pool (pool.ts), which
 * runs one SDK operation at a time.
 *
 * The SDK is loaded on the first connect, not at import time: tests and the
 * lookup code use these types without loading it.
 */

import type { DesktopAuth, ItemListFilter } from '@1password/sdk';
import { VERSION } from '../version.ts';

export const INTEGRATION_NAME = '1Password Bridge';

export interface ItemInfo {
  id: string;
  title: string;
  category: string;
  notes: string;
  sections: { id: string; title: string }[];
  fields: { id: string; title: string; sectionId?: string; fieldType: string; value: string; details?: unknown }[];
}

export interface AccountClient {
  listVaults(): Promise<{ id: string; title: string }[]>;
  listItems(vaultId: string): Promise<{ id: string; title: string; category: string }[]>;
  getItem(vaultId: string, itemId: string): Promise<ItemInfo>;
}

/**
 * The part of the SDK client the adapter reads; `Client` from `@1password/sdk` fits it.
 * The SDK types declare an unset optional field as absent, but its JSON carries null
 * (seen for `sectionId` of a field outside any section), so these types admit null and
 * `accountClient` removes it.
 */
export interface SdkClient {
  vaults: { list(): Promise<readonly { id: string; title: string }[]> };
  items: {
    list(vaultId: string, ...filters: ItemListFilter[]): Promise<readonly { id: string; title: string; category: string }[]>;
    get(
      vaultId: string,
      itemId: string,
    ): Promise<{
      id: string;
      title: string;
      category: string;
      notes: string | null;
      sections: readonly { id: string; title: string | null }[];
      fields: readonly {
        id: string;
        title: string;
        sectionId?: string | null;
        fieldType: string;
        value: string;
        details?: unknown;
      }[];
    }>;
  };
}

/** The part of the `@1password/sdk` module `connectDesktop` uses. */
export interface SdkModule {
  DesktopAuth: new (accountName: string) => DesktopAuth;
  createClient(config: { auth: DesktopAuth; integrationName: string; integrationVersion: string }): Promise<SdkClient>;
}

const ACTIVE_ITEMS: ItemListFilter = { type: 'ByState', content: { active: true, archived: false } };

/**
 * An AccountClient over an SDK client; it copies only the fields the broker reads.
 * A null section id or details becomes absent, a null note or section title empty:
 * the broker protocol accepts an optional field only as absent.
 */
export function accountClient(client: SdkClient): AccountClient {
  return {
    async listVaults() {
      const vaults = await client.vaults.list();
      return vaults.map((v) => ({ id: v.id, title: v.title }));
    },
    async listItems(vaultId) {
      const items = await client.items.list(vaultId, ACTIVE_ITEMS);
      return items.map((i) => ({ id: i.id, title: i.title, category: i.category }));
    },
    async getItem(vaultId, itemId) {
      const item = await client.items.get(vaultId, itemId);
      return {
        id: item.id,
        title: item.title,
        category: item.category,
        notes: item.notes ?? '',
        sections: item.sections.map((s) => ({ id: s.id, title: s.title ?? '' })),
        fields: item.fields.map((f) => {
          const field: ItemInfo['fields'][number] = { id: f.id, title: f.title, fieldType: f.fieldType, value: f.value };
          if (f.sectionId !== undefined && f.sectionId !== null) field.sectionId = f.sectionId;
          if (f.details !== undefined && f.details !== null) field.details = f.details;
          return field;
        }),
      };
    },
  };
}

async function loadSdk(): Promise<SdkModule> {
  const sdk = await import('@1password/sdk');
  return { DesktopAuth: sdk.DesktopAuth, createClient: sdk.createClient };
}

/**
 * A client for `account` (a sidebar name or an account UUID) authorized by
 * the 1Password app. The app asks the user to authorize this process unless
 * it already has.
 */
export async function connectDesktop(account: string, load: () => Promise<SdkModule> = loadSdk): Promise<AccountClient> {
  const sdk = await load();
  const client = await sdk.createClient({
    auth: new sdk.DesktopAuth(account),
    integrationName: INTEGRATION_NAME,
    integrationVersion: VERSION,
  });
  return accountClient(client);
}
