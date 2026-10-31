import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ItemFieldType } from '@1password/sdk';
import { classify, MASKED_TYPES, MIN_MASK_LENGTH, typeLabel } from '../src/classify.ts';

/**
 * Every field type of the installed SDK. The type annotation makes the
 * typecheck fail when an SDK upgrade adds a type that is not classified here.
 */
const EXPECTED: Record<`${ItemFieldType}`, 'secret' | 'plain'> = {
  Text: 'plain',
  Concealed: 'secret',
  CreditCardType: 'plain',
  CreditCardNumber: 'secret',
  Phone: 'plain',
  Url: 'plain',
  Totp: 'secret',
  Email: 'plain',
  Reference: 'plain',
  SshKey: 'secret',
  Menu: 'plain',
  MonthYear: 'plain',
  Address: 'plain',
  Date: 'plain',
  Unsupported: 'secret',
};

const LONG = 'a-long-enough-value';

describe('classify', () => {
  test('MIN_MASK_LENGTH is 8 and MASKED_TYPES are the secret types', () => {
    assert.equal(MIN_MASK_LENGTH, 8);
    assert.deepEqual(
      [...MASKED_TYPES].sort(),
      Object.entries(EXPECTED)
        .filter(([, kind]) => kind === 'secret')
        .map(([type]) => type)
        .sort(),
    );
  });

  test('every SDK field type', () => {
    for (const [fieldType, kind] of Object.entries(EXPECTED)) {
      assert.deepEqual(
        classify({ fieldType, value: LONG }),
        kind === 'secret' ? { masked: true, short: false } : { masked: false, short: false },
        fieldType,
      );
    }
  });

  test('a missing or unknown field type is plain', () => {
    assert.deepEqual(classify({ value: LONG }), { masked: false, short: false });
    assert.deepEqual(classify({ fieldType: 'concealed', value: LONG }), { masked: false, short: false });
  });

  test('the item notes are a secret, whatever the field type says', () => {
    assert.deepEqual(classify({ notes: true, value: LONG }), { masked: true, short: false });
    assert.deepEqual(classify({ notes: true, fieldType: 'Text', value: LONG }), { masked: true, short: false });
    assert.deepEqual(classify({ notes: true, value: 'short' }), { masked: false, short: true });
  });

  test('otp, public-key and fingerprint are plain, private-key follows the field type', () => {
    for (const attribute of ['otp', 'public-key', 'fingerprint']) {
      assert.deepEqual(classify({ fieldType: 'SshKey', attribute, value: LONG }), { masked: false, short: false }, attribute);
    }
    assert.deepEqual(classify({ fieldType: 'Totp', attribute: 'otp', value: '123456' }), { masked: false, short: false });
    assert.deepEqual(classify({ fieldType: 'SshKey', attribute: 'private-key', value: LONG }), { masked: true, short: false });
  });

  test('a 7-character secret is short, an 8-character one is masked', () => {
    assert.deepEqual(classify({ fieldType: 'Concealed', value: '1234567' }), { masked: false, short: true });
    assert.deepEqual(classify({ fieldType: 'Concealed', value: '12345678' }), { masked: true, short: false });
    assert.deepEqual(classify({ fieldType: 'Concealed', value: '' }), { masked: false, short: true });
  });
});

describe('typeLabel', () => {
  test('the field type and the note of its kind', () => {
    assert.equal(typeLabel('Concealed', { masked: true, short: false }, 'en'), 'Concealed · secret, masked in Bash output');
    assert.equal(
      typeLabel('Concealed', { masked: false, short: true }, 'en'),
      'Concealed · secret shorter than 8 characters, NOT masked',
    );
    assert.equal(typeLabel('Text', { masked: false, short: false }, 'en'), 'Text · not a secret, returned in plain text');
  });

  test('the note follows the language', () => {
    assert.equal(typeLabel('Concealed', { masked: true, short: false }, 'uk'), 'Concealed · секрет, буде замасковано у виводі Bash');
    assert.equal(
      typeLabel('Concealed', { masked: false, short: true }, 'uk'),
      'Concealed · секрет коротший за 8 символів, НЕ маскується',
    );
    assert.equal(typeLabel('Url', { masked: false, short: false }, 'uk'), 'Url · не секрет, видається відкрито');
    assert.equal(typeLabel('Url', { masked: false, short: false }, 'fr'), 'Url · not a secret, returned in plain text');
  });
});
