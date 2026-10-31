/**
 * 1Password secret references: `op://<vault>/<item>/[<section>/]<field>` for a
 * field, with an optional `?attribute=`, and `op://<vault>/<item>` for an item.
 *
 * A segment is a title or an id and is kept exactly as written: titles may hold
 * spaces, so nothing is trimmed or decoded. Resolving a segment against the
 * vault is the broker's job, not this parser's.
 */

export type Attribute = 'otp' | 'public-key' | 'fingerprint' | 'private-key';

export interface FieldRef {
  vault: string;
  item: string;
  section?: string;
  field: string;
  attribute?: Attribute;
}

export interface ItemRef {
  vault: string;
  item: string;
}

export class RefError extends Error {
  override name = 'RefError';
}

const SCHEME = /^op:\/\//i;

const FIELD_FORMS =
  'expected op://<vault>/<item>/[<section>/]<field>, optionally followed by ' +
  '?attribute=otp|totp|public-key|fingerprint|private-key';

const ITEM_FORMS = 'expected op://<vault>/<item>';

/** Attribute spellings, lower-cased, mapped to the attribute they name. */
const ATTRIBUTES: ReadonlyMap<string, Attribute> = new Map([
  ['otp', 'otp'],
  ['totp', 'otp'],
  ['public-key', 'public-key'],
  ['fingerprint', 'fingerprint'],
  ['private-key', 'private-key'],
]);

function refused(ref: string, problem: string, forms: string): RefError {
  return new RefError(`Invalid secret reference ${JSON.stringify(ref)}: ${problem}; ${forms}`);
}

/** The non-empty segments after the scheme, or a RefError naming `forms`. */
function segments(ref: string, path: string, forms: string): string[] {
  const parts = path.split('/');
  if (parts.some((part) => part === '')) {
    throw refused(ref, 'a segment is empty', forms);
  }
  return parts;
}

function parseAttribute(ref: string, query: string): Attribute {
  const params = query.split('&');
  if (params.length !== 1) {
    throw refused(ref, 'only one query parameter is accepted', FIELD_FORMS);
  }
  const [param] = params as [string];
  const equals = param.indexOf('=');
  const key = equals === -1 ? param : param.slice(0, equals);
  if (key.toLowerCase() !== 'attribute') {
    throw refused(ref, `unknown query parameter ${JSON.stringify(key)}`, FIELD_FORMS);
  }
  const value = equals === -1 ? '' : param.slice(equals + 1);
  const attribute = ATTRIBUTES.get(value.toLowerCase());
  if (attribute === undefined) {
    throw refused(ref, `unknown attribute ${JSON.stringify(value)}`, FIELD_FORMS);
  }
  return attribute;
}

export function parseFieldRef(ref: string): FieldRef {
  if (!SCHEME.test(ref)) {
    throw refused(ref, 'the op:// scheme is missing', FIELD_FORMS);
  }
  const rest = ref.replace(SCHEME, '');
  const question = rest.indexOf('?');
  const path = question === -1 ? rest : rest.slice(0, question);
  const parts = segments(ref, path, FIELD_FORMS);
  const attribute = question === -1 ? undefined : parseAttribute(ref, rest.slice(question + 1));

  let result: FieldRef;
  if (parts.length === 3) {
    const [vault, item, field] = parts as [string, string, string];
    result = { vault, item, field };
  } else if (parts.length === 4) {
    const [vault, item, section, field] = parts as [string, string, string, string];
    result = { vault, item, section, field };
  } else {
    throw refused(ref, `${parts.length} segments, a field takes 3 or 4`, FIELD_FORMS);
  }
  if (attribute !== undefined) {
    result.attribute = attribute;
  }
  return result;
}

export function parseItemRef(ref: string): ItemRef {
  if (!SCHEME.test(ref)) {
    throw refused(ref, 'the op:// scheme is missing', ITEM_FORMS);
  }
  const rest = ref.replace(SCHEME, '');
  if (rest.includes('?')) {
    throw refused(ref, 'an item reference takes no query', ITEM_FORMS);
  }
  const parts = segments(ref, rest, ITEM_FORMS);
  if (parts.length !== 2) {
    throw refused(ref, `${parts.length} segments, an item takes 2`, ITEM_FORMS);
  }
  const [vault, item] = parts as [string, string];
  return { vault, item };
}
