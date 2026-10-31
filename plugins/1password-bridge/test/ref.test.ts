import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFieldRef, parseItemRef, RefError } from '../src/ref.ts';

describe('parseFieldRef', () => {
  test('a three-segment reference keeps spaces in titles', () => {
    assert.deepEqual(parseFieldRef('op://Shared/q7x2m4k6p3w5z5n6r4t5v2y4ab/deploy api token'), {
      vault: 'Shared',
      item: 'q7x2m4k6p3w5z5n6r4t5v2y4ab',
      field: 'deploy api token',
    });
  });

  test('a four-segment reference names the section', () => {
    assert.deepEqual(parseFieldRef('op://Private/Server/add more/password'), {
      vault: 'Private',
      item: 'Server',
      section: 'add more',
      field: 'password',
    });
  });

  test('leading and trailing spaces in a segment are kept', () => {
    assert.deepEqual(parseFieldRef('op:// Vault /Item/ field '), {
      vault: ' Vault ',
      item: 'Item',
      field: ' field ',
    });
  });

  test('the scheme is case-insensitive', () => {
    assert.deepEqual(parseFieldRef('OP://v/i/f'), { vault: 'v', item: 'i', field: 'f' });
    assert.deepEqual(parseFieldRef('Op://v/i/f'), { vault: 'v', item: 'i', field: 'f' });
  });

  test('each attribute is accepted, and totp is read as otp', () => {
    for (const attribute of ['otp', 'public-key', 'fingerprint', 'private-key'] as const) {
      assert.deepEqual(parseFieldRef(`op://v/i/f?attribute=${attribute}`), {
        vault: 'v',
        item: 'i',
        field: 'f',
        attribute,
      });
    }
    assert.deepEqual(parseFieldRef('op://v/i/one-time password?attribute=totp'), {
      vault: 'v',
      item: 'i',
      field: 'one-time password',
      attribute: 'otp',
    });
  });

  test('an attribute goes with a four-segment reference too', () => {
    assert.deepEqual(parseFieldRef('op://v/i/s/f?attribute=fingerprint'), {
      vault: 'v',
      item: 'i',
      section: 's',
      field: 'f',
      attribute: 'fingerprint',
    });
  });

  test('a reference without the op:// scheme is refused', () => {
    for (const ref of ['Shared/item/field', 'https://v/i/f', 'op:/v/i/f', '']) {
      assert.throws(() => parseFieldRef(ref), RefError, JSON.stringify(ref));
    }
  });

  test('an empty segment is refused', () => {
    for (const ref of ['op://v//f', 'op:///i/f', 'op://v/i/', 'op://v/i/s//f']) {
      assert.throws(() => parseFieldRef(ref), RefError, ref);
    }
  });

  test('two or five segments are refused for a field', () => {
    assert.throws(() => parseFieldRef('op://v/i'), RefError);
    assert.throws(() => parseFieldRef('op://v/i/s/f/x'), RefError);
  });

  test('an unknown query key or attribute is refused with the accepted forms', () => {
    for (const ref of [
      'op://v/i/f?foo=1',
      'op://v/i/f?attribute=password',
      'op://v/i/f?attribute=',
      'op://v/i/f?attribute',
      'op://v/i/f?',
      'op://v/i/f?attribute=otp&attribute=otp',
      'op://v/i/f?attribute=otp&ssh-format=openssh',
    ]) {
      assert.throws(
        () => parseFieldRef(ref),
        (error: unknown) =>
          error instanceof RefError &&
          error.message.includes('op://<vault>/<item>/[<section>/]<field>') &&
          error.message.includes('?attribute=otp|totp|public-key|fingerprint|private-key'),
        ref,
      );
    }
  });
});

describe('parseItemRef', () => {
  test('a two-segment reference names a vault and an item', () => {
    assert.deepEqual(parseItemRef('op://Shared/q7x2m4k6p3w5z5n6r4t5v2y4ab'), {
      vault: 'Shared',
      item: 'q7x2m4k6p3w5z5n6r4t5v2y4ab',
    });
    assert.deepEqual(parseItemRef('OP://My Vault/Some item'), { vault: 'My Vault', item: 'Some item' });
  });

  test('a field reference, a query, an empty segment or a missing scheme is refused', () => {
    for (const ref of ['op://v/i/f', 'op://v', 'op://v/', 'op:///i', 'v/i', 'op://v/i?attribute=otp']) {
      assert.throws(
        () => parseItemRef(ref),
        (error: unknown) => error instanceof RefError && error.message.includes('op://<vault>/<item>'),
        ref,
      );
    }
  });
});
