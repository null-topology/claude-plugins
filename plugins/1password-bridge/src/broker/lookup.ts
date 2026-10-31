/**
 * Resolving an `op://` reference against one account: which vault, item and
 * field it names, and its value.
 *
 * A segment matches by id first, then by title in any case; when several
 * titles match in different cases, the one written exactly as the segment
 * wins. Anything else that matches more than once is ambiguous, and the error
 * lists the ids to use instead. The field segment `notes` (or `notesPlain`)
 * names the item notes unless a field of the item takes that name.
 *
 * Every function here calls the SDK through `client`, so the broker runs each
 * one as a single pool operation.
 */

import { classify } from '../classify.ts';
import type { FieldMeta } from '../protocol.ts';
import type { Attribute, FieldRef, ItemRef } from '../ref.ts';
import type { AccountClient, ItemInfo } from './onepassword.ts';

/** An attribute the value is read through; `private-key` is the field value itself. */
export type NamedAttribute = Exclude<Attribute, 'private-key'>;

export type LookupCode = 'not_found' | 'ambiguous';

export class LookupError extends Error {
  override name = 'LookupError';
  readonly code: LookupCode;

  constructor(code: LookupCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A resolved field, without its value. */
export interface FieldTarget {
  vaultId: string;
  vaultTitle: string;
  itemId: string;
  itemTitle: string;
  category: string;
  /** The field id; `notes` for the item notes. */
  fieldId: string;
  fieldTitle: string;
  sectionId: string | undefined;
  /** The section title, only when the section has one. */
  sectionTitle: string | undefined;
  /** The SDK field type; `Notes` for the item notes. */
  fieldType: string;
  /** The attribute read from the field; `private-key` is the value itself and is not kept. */
  attribute: NamedAttribute | undefined;
  notes: boolean;
}

export interface ResolvedField {
  target: FieldTarget;
  value: string;
}

export interface ItemDescription {
  vault: string;
  item: { title: string; category: string };
  fields: FieldMeta[];
}

/** 1Password item ids: 26 lower-case letters and digits. */
const ITEM_ID = /^[a-z0-9]{26}$/;

const NOTES_ID = 'notes';
const NOTES_SEGMENTS = new Set(['notes', 'notesplain']);
const NOTES_TYPE = 'Notes';

type Field = ItemInfo['fields'][number];

function quote(s: string): string {
  return JSON.stringify(s);
}

/** What `segment` names in `list`: one match, none, or the ambiguous ones. */
function matches<T extends { id: string; title: string }>(list: readonly T[], segment: string): T[] {
  const byId = list.filter((x) => x.id === segment);
  if (byId.length === 1) return byId;
  const lower = segment.toLowerCase();
  const byTitle = list.filter((x) => x.title !== '' && x.title.toLowerCase() === lower);
  if (byTitle.length <= 1) return byTitle.length === 1 ? byTitle : byId;
  const exact = byTitle.filter((x) => x.title === segment);
  return exact.length === 1 ? exact : byTitle;
}

function ids(list: readonly { id: string }[]): string {
  return list.map((x) => x.id).join(', ');
}

async function findVault(client: AccountClient, segment: string): Promise<{ id: string; title: string }> {
  const found = matches(await client.listVaults(), segment);
  const [vault] = found;
  if (vault === undefined) throw new LookupError('not_found', `No vault ${quote(segment)} in this account`);
  if (found.length > 1) {
    throw new LookupError('ambiguous', `Vault ${quote(segment)} matches ${found.length} vaults (ids ${ids(found)}); use a vault id`);
  }
  return vault;
}

async function findItem(client: AccountClient, vault: { id: string; title: string }, segment: string): Promise<ItemInfo> {
  if (ITEM_ID.test(segment)) return client.getItem(vault.id, segment);
  const found = matches(await client.listItems(vault.id), segment);
  const [item] = found;
  if (item === undefined) throw new LookupError('not_found', `No item ${quote(segment)} in vault ${quote(vault.title)}`);
  if (found.length > 1) {
    throw new LookupError(
      'ambiguous',
      `Item ${quote(segment)} matches ${found.length} items in vault ${quote(vault.title)} (ids ${ids(found)}); use an item id`,
    );
  }
  return client.getItem(vault.id, item.id);
}

/** The field `ref` names in `item`, or null for the item notes. */
function findField(item: ItemInfo, ref: FieldRef): Field | null {
  let candidates: readonly Field[] = item.fields;
  let where = `item ${quote(item.title)}`;
  if (ref.section !== undefined) {
    const sections = matches(item.sections, ref.section);
    const [section] = sections;
    if (section === undefined) throw new LookupError('not_found', `No section ${quote(ref.section)} in item ${quote(item.title)}`);
    if (sections.length > 1) {
      throw new LookupError(
        'ambiguous',
        `Section ${quote(ref.section)} matches ${sections.length} sections of item ${quote(item.title)} (ids ${ids(sections)}); use a section id`,
      );
    }
    candidates = item.fields.filter((f) => f.sectionId === section.id);
    where = `section ${quote(ref.section)} of item ${quote(item.title)}`;
  }
  const found = matches(candidates, ref.field);
  const [field] = found;
  if (field === undefined) {
    if (ref.section === undefined && NOTES_SEGMENTS.has(ref.field.toLowerCase())) return null;
    throw new LookupError('not_found', `No field ${quote(ref.field)} in ${where}`);
  }
  if (found.length > 1) {
    throw new LookupError(
      'ambiguous',
      `Field ${quote(ref.field)} matches ${found.length} fields of ${where} (ids ${ids(found)}); use a field id or name its section`,
    );
  }
  return field;
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** `details.content` of a field whose details have type `type`. */
function detailsContent(field: Field, type: string): Record<string, unknown> | undefined {
  const details = record(field.details);
  return details?.['type'] === type ? record(details['content']) : undefined;
}

/** The value `attribute` reads from `field`; a LookupError when the field has none. */
function fieldValue(item: ItemInfo, field: Field, attribute: Attribute | undefined): string {
  const what = `Field ${quote(field.title)} of item ${quote(item.title)}`;
  switch (attribute) {
    case undefined:
      return field.value;
    case 'otp': {
      const content = detailsContent(field, 'Otp');
      const code = content?.['code'];
      if (typeof code === 'string' && code !== '') return code;
      // The SDK's `errorMessage` is left out: the error reaches the model, and that text may quote the seed.
      throw new LookupError('not_found', `${what} has no one-time code`);
    }
    case 'public-key':
    case 'fingerprint': {
      const content = detailsContent(field, 'SshKey');
      const value = content?.[attribute === 'public-key' ? 'publicKey' : 'fingerprint'];
      if (typeof value === 'string' && value !== '') return value;
      throw new LookupError('not_found', `${what} has no SSH key ${attribute}`);
    }
    case 'private-key':
      if (field.fieldType === 'SshKey') return field.value;
      throw new LookupError('not_found', `${what} is not an SSH key`);
  }
}

function sectionTitle(item: ItemInfo, sectionId: string | undefined): string | undefined {
  if (sectionId === undefined) return undefined;
  const title = item.sections.find((s) => s.id === sectionId)?.title;
  return title === undefined || title === '' ? undefined : title;
}

function namedAttribute(attribute: Attribute | undefined): NamedAttribute | undefined {
  return attribute === 'private-key' ? undefined : attribute;
}

/** The field `ref` names, with its current value (to classify it before the window). */
export async function resolveField(client: AccountClient, ref: FieldRef): Promise<ResolvedField> {
  const vault = await findVault(client, ref.vault);
  const item = await findItem(client, vault, ref.item);
  const field = findField(item, ref);
  const attribute = namedAttribute(ref.attribute);
  const value = field === null ? item.notes : fieldValue(item, field, ref.attribute);
  const target: FieldTarget = {
    vaultId: vault.id,
    vaultTitle: vault.title,
    itemId: item.id,
    itemTitle: item.title,
    category: item.category,
    fieldId: field === null ? NOTES_ID : field.id,
    fieldTitle: field === null ? NOTES_ID : field.title,
    sectionId: field?.sectionId,
    sectionTitle: field === null ? undefined : sectionTitle(item, field.sectionId),
    fieldType: field === null ? NOTES_TYPE : field.fieldType,
    attribute,
    notes: field === null,
  };
  return { target, value };
}

/**
 * Whether the item `target` names is gone: its vault no longer lists it, or the vault itself is
 * gone. False when neither listing can be read, so a failing call keeps its own error.
 */
async function itemGone(client: AccountClient, target: FieldTarget): Promise<boolean> {
  try {
    const items = await client.listItems(target.vaultId);
    return !items.some((item) => item.id === target.itemId);
  } catch {
    try {
      const vaults = await client.listVaults();
      return !vaults.some((vault) => vault.id === target.vaultId);
    } catch {
      return false;
    }
  }
}

/**
 * The value of `target` now: the item is fetched again, so an OTP code is current. A deleted
 * item or a removed field is `not_found`, which a redeem reports as `field_gone`.
 */
export async function fetchValue(client: AccountClient, target: FieldTarget): Promise<string> {
  let item: ItemInfo;
  try {
    item = await client.getItem(target.vaultId, target.itemId);
  } catch (err) {
    if (await itemGone(client, target)) {
      throw new LookupError(
        'not_found',
        `Item ${quote(target.itemTitle)} is no longer in vault ${quote(target.vaultTitle)}`,
      );
    }
    throw err;
  }
  if (target.notes) return item.notes;
  const field = item.fields.find((f) => f.id === target.fieldId);
  if (field === undefined) {
    throw new LookupError('not_found', `Field ${quote(target.fieldTitle)} is no longer in item ${quote(item.title)}`);
  }
  // A private key was resolved without a kept attribute; its value is the field value either way.
  return fieldValue(item, field, target.attribute);
}

/** The fields of the item `ref` names, as the `fields` answer lists them: no values. */
export async function describeItem(client: AccountClient, ref: ItemRef): Promise<ItemDescription> {
  const vault = await findVault(client, ref.vault);
  const item = await findItem(client, vault, ref.item);
  const fields: FieldMeta[] = item.fields.map((f) => {
    const meta: FieldMeta = {
      id: f.id,
      title: f.title,
      type: f.fieldType,
      masked: classify({ fieldType: f.fieldType, value: f.value }).masked,
    };
    if (f.sectionId !== undefined) meta.sectionId = f.sectionId;
    const section = sectionTitle(item, f.sectionId);
    if (section !== undefined) meta.section = section;
    return meta;
  });
  if (item.notes !== '' && matches(item.fields, NOTES_ID).length === 0) {
    fields.push({
      id: NOTES_ID,
      title: NOTES_ID,
      type: NOTES_TYPE,
      masked: classify({ notes: true, value: item.notes }).masked,
    });
  }
  return { vault: vault.title, item: { title: item.title, category: item.category }, fields };
}
