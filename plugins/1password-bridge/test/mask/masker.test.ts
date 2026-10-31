import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildMasker, maskDeep, withholdDeep, type MaskEntry } from '../../src/mask/masker.ts';
import { needlesFor } from '../../src/mask/needles.ts';
import { fakePem } from './fixtures.ts';

const NAME = 'TEST_TOKEN';
const VALUE = 'not-a-real-secret 0123456789';

function entry(name: string, value: string): MaskEntry {
  return { replacement: `<masked:${name}>`, needles: needlesFor(value) };
}

function masker(...entries: MaskEntry[]): (s: string) => string {
  const mask = buildMasker(entries);
  assert.ok(mask !== null);
  return mask;
}

/** What `script` prints when run by sh with the value in `$X`. */
function shell(script: string, value: string): string {
  return execFileSync('/bin/sh', ['-c', script], { env: { ...process.env, X: value }, encoding: 'utf8' });
}

describe('buildMasker', () => {
  test('no entries, or entries without needles, give no masker', () => {
    assert.equal(buildMasker([]), null);
    assert.equal(buildMasker([entry(NAME, 'short')]), null);
  });

  test('the raw value', () => {
    assert.equal(masker(entry(NAME, VALUE))(`token: ${VALUE}.`), `token: <masked:${NAME}>.`);
  });

  test('a multi-line value escaped in JSON', () => {
    const value = 'line one of it\nline "two" of it';
    const output = JSON.stringify({ secret: value });
    assert.equal(masker(entry(NAME, value))(output), `{"secret":"<masked:${NAME}>"}`);
  });

  test('the URL-encoded value, with %20 or + for spaces', () => {
    const mask = masker(entry(NAME, VALUE));
    assert.equal(mask(`https://x.test/?t=${encodeURIComponent(VALUE)}`), `https://x.test/?t=<masked:${NAME}>`);
    assert.equal(mask(`t=${encodeURIComponent(VALUE).replace(/%20/g, '+')}&a=1`), `t=<masked:${NAME}>&a=1`);
  });

  test('printf %s "$X" | base64', () => {
    const output = shell('printf %s "$X" | base64', VALUE);
    assert.equal(masker(entry(NAME, VALUE))(output), `<masked:${NAME}>\n`);
  });

  test('echo "$X" | base64', () => {
    const output = shell('echo "$X" | base64', VALUE);
    assert.equal(masker(entry(NAME, VALUE))(output), `<masked:${NAME}>\n`);
  });

  test('base64 wrapped at 76 columns', () => {
    const value = `${VALUE} ${'z'.repeat(40)}`;
    for (const script of ['printf %s "$X" | base64 | fold -w 76', 'echo "$X" | base64 | fold -w 76']) {
      const output = shell(script, value);
      assert.ok(output.trimEnd().includes('\n'), 'the output is wrapped');
      assert.equal(masker(entry(NAME, value))(output), `<masked:${NAME}>\n`, script);
    }
  });

  test('a PEM key printed with head -3: body lines masked, armor kept', () => {
    const pem = fakePem('masker', 4);
    const output = shell('printf %s "$X" | head -3', pem);
    assert.equal(
      masker(entry(NAME, pem))(output),
      `-----BEGIN EXAMPLE TEST KEY-----\n<masked:${NAME}>\n<masked:${NAME}>\n`,
    );
  });

  test('the longest needle wins over a line needle', () => {
    const value = 'first line of the value\nsecond line of the value';
    assert.equal(masker(entry(NAME, value))(`>${value}<`), `><masked:${NAME}><`);
    const other = 'OTHER_NAME';
    const mask = masker(entry(other, 'second line of the value'), entry(NAME, value));
    assert.equal(mask(value), `<masked:${NAME}>`);
    assert.equal(mask('second line of the value'), `<masked:${other}>`);
  });

  test('two values are each masked with their own name', () => {
    const second = 'another-fake-value-987654';
    const mask = masker(entry('FIRST', VALUE), entry('SECOND', second));
    assert.equal(mask(`${second} and ${VALUE}`), '<masked:SECOND> and <masked:FIRST>');
  });

  test('regex metacharacters and $ in a value are matched literally', () => {
    const value = 'a.b*c$&d(e)[f]';
    assert.equal(masker(entry(NAME, value))(`x a.b*c$&d(e)[f] y aXb*c$&d(e)[f]`), `x <masked:${NAME}> y aXb*c$&d(e)[f]`);
  });
});

describe('maskDeep', () => {
  const mask = masker(entry(NAME, VALUE));

  test('the Bash tool shape keeps its keys and booleans', () => {
    const response = {
      stdout: `token ${VALUE}\n`,
      stderr: `warn ${VALUE}`,
      interrupted: false,
      isImage: false,
      noOutputExpected: true,
    };
    assert.deepEqual(maskDeep(response, mask), {
      changed: true,
      value: {
        stdout: `token <masked:${NAME}>\n`,
        stderr: `warn <masked:${NAME}>`,
        interrupted: false,
        isImage: false,
        noOutputExpected: true,
      },
    });
    assert.equal(response.stdout, `token ${VALUE}\n`, 'the input is not modified');
  });

  test('a top-level string is masked; numbers, null and keys are kept even when they hold a needle', () => {
    assert.deepEqual(maskDeep(VALUE, mask), { changed: true, value: `<masked:${NAME}>` });
    const DIGITS = '20261031';
    const withDigits = masker(entry(NAME, VALUE), entry('PIN', DIGITS));
    assert.deepEqual(maskDeep({ text: `pin ${DIGITS}`, total: 20261031, [VALUE]: 1, n: null }, withDigits), {
      changed: true,
      value: { text: 'pin <masked:PIN>', total: 20261031, [VALUE]: 1, n: null },
    });
    const unchanged = { [DIGITS]: 20261031, list: [20261031, 7], n: null };
    assert.deepEqual(maskDeep(unchanged, withDigits), { changed: false, value: unchanged });
    assert.equal(maskDeep(unchanged, withDigits).value, unchanged, 'nothing changed: the same reference');
    assert.deepEqual(maskDeep(20261031, withDigits), { changed: false, value: 20261031 });
  });

  test('nothing to mask returns the same value unchanged', () => {
    const response = { stdout: 'clean', list: ['a', { b: 'c' }] };
    const result = maskDeep(response, mask);
    assert.equal(result.changed, false);
    assert.equal(result.value, response);
  });
});

describe('withholdDeep', () => {
  const NOTE = '[withheld]';

  /** The keys of every object in `v`, depth first, as `path:key` lines. */
  function keyPaths(v: unknown, path = ''): string[] {
    if (Array.isArray(v)) return v.flatMap((item: unknown, i) => keyPaths(item, `${path}[${i}]`));
    if (v !== null && typeof v === 'object') {
      return Object.entries(v).flatMap(([key, item]) => [`${path}.${key}`, ...keyPaths(item, `${path}.${key}`)]);
    }
    return [];
  }

  test('the Bash shape: every string withheld, booleans, numbers and null kept', () => {
    const response = { stdout: `a ${VALUE}`, stderr: '', interrupted: false, isImage: false, n: 3, z: null };
    assert.deepEqual(withholdDeep(response, NOTE), {
      stdout: NOTE,
      stderr: NOTE,
      interrupted: false,
      isImage: false,
      n: 3,
      z: null,
    });
    assert.equal(withholdDeep('x', NOTE), NOTE);
  });

  test('numbers and keys are kept even when they hold a value (a known limit of withhold mode)', () => {
    const response = { [VALUE]: 20261031, count: 20261031, stdout: VALUE };
    assert.deepEqual(withholdDeep(response, NOTE), { [VALUE]: 20261031, count: 20261031, stdout: NOTE });
  });

  test('strings under type and mode stay verbatim at any depth, every key stays, and a top-level array is mapped per item', () => {
    const response = {
      type: 'text',
      stdout: `a ${VALUE}`,
      nested: { mode: 'content', lines: [`b ${VALUE}`, 2], block: { type: 'image', data: 'iVBORw0KGgo=' } },
    };
    const withheld = withholdDeep(response, NOTE);
    assert.deepEqual(withheld, {
      type: 'text',
      stdout: NOTE,
      nested: { mode: 'content', lines: [NOTE, 2], block: { type: 'image', data: NOTE } },
    });
    assert.deepEqual(keyPaths(withheld), keyPaths(response));
    assert.deepEqual(withholdDeep([VALUE, { type: 'text', text: VALUE }, 1], NOTE), [NOTE, { type: 'text', text: NOTE }, 1]);
  });
});
