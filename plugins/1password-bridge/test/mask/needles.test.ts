import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { needlesFor } from '../../src/mask/needles.ts';
import { fakePem } from './fixtures.ts';

describe('needlesFor', () => {
  test('a value shorter than 8 characters yields no needles', () => {
    assert.deepEqual(needlesFor('1234567'), []);
    assert.deepEqual(needlesFor(''), []);
  });

  test('an 8-character value yields itself and its encodings', () => {
    const needles = needlesFor('12345678');
    assert.ok(needles.includes('12345678'));
    assert.ok(needles.includes('MTIzNDU2Nzg='));
    assert.ok(needles.includes('MTIzNDU2Nzg'));
    assert.ok(needles.includes('MTIzNDU2NzgK'), 'base64 of the value with a trailing newline');
  });

  test('the JSON-escaped and URL-encoded forms', () => {
    const value = 'say "hi" there\nand\\more';
    const needles = needlesFor(value);
    assert.ok(needles.includes('say \\"hi\\" there\\nand\\\\more'));
    assert.ok(needles.includes(encodeURIComponent(value)));
    assert.ok(needles.includes(encodeURIComponent(value).replace(/%20/g, '+')));
  });

  test('standard, unpadded and URL-safe base64 of the value and of the value with a newline', () => {
    const value = 'not-a-real-secret?>>~';
    const needles = needlesFor(value);
    for (const raw of [value, `${value}\n`]) {
      const b64 = Buffer.from(raw).toString('base64');
      assert.ok(needles.includes(b64), b64);
      assert.ok(needles.includes(b64.replace(/=+$/, '')), b64);
      assert.ok(needles.includes(Buffer.from(raw).toString('base64url')), b64);
    }
  });

  test('base64 longer than 76 columns also yields its wrapped form', () => {
    const long = 'x'.repeat(60);
    const b64 = Buffer.from(long).toString('base64');
    assert.ok(b64.length > 76);
    assert.ok(needlesFor(long).includes(`${b64.slice(0, 76)}\n${b64.slice(76)}`));
    assert.ok(!needlesFor('x'.repeat(20)).some((needle) => needle.includes('\n')), 'short base64 is not wrapped');
  });

  test('a multi-line value yields its trimmed lines, without PEM armor or short lines', () => {
    const pem = fakePem('needles', 3);
    const lines = pem.split('\n');
    const needles = needlesFor(pem);
    for (const line of lines.slice(1, 4)) {
      assert.ok(needles.includes(line), line);
    }
    assert.ok(!needles.includes('-----BEGIN EXAMPLE TEST KEY-----'));
    assert.ok(!needles.includes('-----END EXAMPLE TEST KEY-----'));
    assert.ok(!needles.includes('tail='));
    assert.ok(needlesFor('first line\r\n   second line  ').includes('second line'));
    assert.ok(needlesFor('first line\r\nsecond').includes('first line'));
  });

  test('a single-line value yields no line needles', () => {
    assert.ok(!needlesFor('  padded value  ').includes('padded value'));
  });

  test('every needle is at least 8 characters and appears once', () => {
    const needles = needlesFor(fakePem('length', 4));
    assert.equal(new Set(needles).size, needles.length);
    for (const needle of needles) {
      assert.ok(needle.length >= 8, needle);
    }
  });
});
