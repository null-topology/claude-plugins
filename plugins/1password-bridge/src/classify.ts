/**
 * Whether a granted value is a secret, and whether it is long enough to mask.
 *
 * A secret shorter than MIN_MASK_LENGTH is not masked: masking every
 * occurrence of a short string would garble ordinary output and still leave
 * the value guessable. The approval window tells the user so before they
 * approve it.
 */

import { strings } from './strings.ts';

export const MIN_MASK_LENGTH = 8;

/** The SDK field types whose values are secrets. */
export const MASKED_TYPES: ReadonlySet<string> = new Set([
  'Concealed',
  'CreditCardNumber',
  'SshKey',
  'Totp',
  'Unsupported',
]);

/** Attributes that read a non-secret part of a field: a current code, a public key, a fingerprint. */
const PLAIN_ATTRIBUTES: ReadonlySet<string> = new Set(['otp', 'public-key', 'fingerprint']);

export type Kind = { masked: boolean; short: boolean };

export function classify(p: { fieldType?: string; attribute?: string; notes?: boolean; value: string }): Kind {
  let secret: boolean;
  if (p.notes === true) {
    secret = true;
  } else if (p.attribute !== undefined && PLAIN_ATTRIBUTES.has(p.attribute)) {
    secret = false;
  } else {
    secret = p.fieldType !== undefined && MASKED_TYPES.has(p.fieldType);
  }
  const masked = secret && p.value.length >= MIN_MASK_LENGTH;
  return { masked, short: secret && !masked };
}

/** The window's type row: `<fieldType> · <note>`, with the note in `lang`. */
export function typeLabel(fieldType: string, kind: Kind, lang: string | undefined): string {
  const table = strings(lang);
  const note = kind.masked ? table.noteMasked : kind.short ? table.noteShort : table.notePlain;
  return `${fieldType} · ${note}`;
}
