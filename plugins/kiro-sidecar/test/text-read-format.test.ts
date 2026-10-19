import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidInputError } from '../src/text/errors.ts';
import {
  LABEL_PATTERN,
  LAUNCH_ID_PATTERN,
  assertLabel,
  formatResultLine,
  formatTurnTrailer,
  isValidLabel,
} from '../src/text/format.ts';
import { PAGE_LIMIT_DEFAULT, PAGE_LIMIT_MAX } from '../src/text/limits.ts';
import { type Page, readPage, stderrTail } from '../src/text/read.ts';

let root = '';
let counter = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'kiro-sidecar-read-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function file(content: string | Buffer): string {
  counter += 1;
  const path = join(root, `file-${counter}`);
  writeFileSync(path, content);
  return path;
}

function readAll(path: string, limit: number, offset = 0): Page[] {
  const pages: Page[] = [];
  let next: number | null = offset;
  while (next !== null) {
    const page = readPage(path, next, limit);
    pages.push(page);
    next = page.nextOffset;
  }
  return pages;
}

describe('paging', () => {
  /** Non-Latin on purpose: surrogate pairs, accents and CJK at page edges. */
  const text = 'Line one\r\n\u{1F600}\u{1F680} cafe\u{301} \u{4E2D}\u{6587}\r\n\u{1F600}x\u{1F600}\u{1F600}\r\nend\r\n\u{1F680}';

  test('pages of every size round-trip a text with surrogate pairs and CRLF exactly', () => {
    const path = file(text);
    for (let limit = 1; limit <= text.length + 1; limit += 1) {
      const pages = readAll(path, limit);
      assert.equal(pages.map((page) => page.text).join(''), text, `limit ${limit}`);
      for (const page of pages) {
        assert.ok(page.text.length <= limit + 1, `limit ${limit}`);
        assert.ok(page.text.length > 0, `limit ${limit}`);
        assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(page.text), `limit ${limit} splits a pair`);
        assert.equal(page.totalChars, text.length);
      }
      assert.equal(pages.at(-1)?.nextOffset, null);
    }
  });

  test('a page end inside a pair moves back, or past the pair for a one-unit page', () => {
    const path = file('ab\u{1F600}cd');
    assert.deepEqual(readPage(path, 0, 3), { text: 'ab', offset: 0, nextOffset: 2, totalChars: 6 });
    assert.deepEqual(readPage(path, 2, 1), { text: '\u{1F600}', offset: 2, nextOffset: 4, totalChars: 6 });
  });

  test('an offset inside a pair moves back to the start of the pair', () => {
    const path = file('ab\u{1F600}cd');
    assert.deepEqual(readPage(path, 3, 10), { text: '\u{1F600}cd', offset: 2, nextOffset: null, totalChars: 6 });
  });

  test('the default limit is 20 000 and the last page has a null nextOffset', () => {
    const big = 'a'.repeat(PAGE_LIMIT_DEFAULT + 5);
    const path = file(big);
    assert.deepEqual(readPage(path), { text: 'a'.repeat(PAGE_LIMIT_DEFAULT), offset: 0, nextOffset: PAGE_LIMIT_DEFAULT, totalChars: big.length });
    assert.deepEqual(readPage(path, PAGE_LIMIT_DEFAULT), { text: 'aaaaa', offset: PAGE_LIMIT_DEFAULT, nextOffset: null, totalChars: big.length });
    assert.equal(readPage(path, 0, PAGE_LIMIT_MAX).nextOffset, null);
  });

  test('offset at the end gives an empty last page, and an empty file one empty page', () => {
    const path = file('abc');
    assert.deepEqual(readPage(path, 3), { text: '', offset: 3, nextOffset: null, totalChars: 3 });
    assert.deepEqual(readPage(file('')), { text: '', offset: 0, nextOffset: null, totalChars: 0 });
  });

  test('offsets and limits are counted in UTF-16 units, not bytes', () => {
    const path = file('\u{4E2D}\u{6587}abc');
    assert.equal(readPage(path, 2, 2).text, 'ab');
  });

  test('a bad offset or limit is E_INVALID naming the field', () => {
    const path = file('abc');
    const cases: ReadonlyArray<readonly [number, number, string]> = [
      [-1, 10, 'offset'],
      [1.5, 10, 'offset'],
      [4, 10, 'offset'],
      [0, 0, 'limit'],
      [0, PAGE_LIMIT_MAX + 1, 'limit'],
      [0, 2.5, 'limit'],
      [0, Number.NaN, 'limit'],
    ];
    for (const [offset, limit, field] of cases) {
      assert.throws(
        () => readPage(path, offset, limit),
        (error: unknown) =>
          error instanceof InvalidInputError && error.code === 'E_INVALID' && error.field === field,
        `${offset}/${limit}`,
      );
    }
    assert.equal(readPage(path, 0, PAGE_LIMIT_MAX).text, 'abc');
  });
});

describe('stderr tail', () => {
  test('it is the last 20 lines, without the final newline', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `warning ${i}`);
    assert.equal(stderrTail(file(`${lines.join('\n')}\n`)), lines.slice(-20).join('\n'));
    assert.equal(stderrTail(file('only line')), 'only line');
    assert.equal(stderrTail(file('a\nb\n'), 1), 'b');
  });

  test('a missing or empty file gives null', () => {
    assert.equal(stderrTail(join(root, 'missing.log')), null);
    assert.equal(stderrTail(file('')), null);
    assert.equal(stderrTail(file('\n')), null);
  });

  test('only the last bytes are read and a line cut by the window is dropped', () => {
    const content = `${'first line that is long\n'.repeat(4)}tail one\ntail two\n`;
    assert.equal(stderrTail(file(content), 20, 20), 'tail one\ntail two');
  });

  test('a single line longer than the window is kept in part, at a character boundary', () => {
    // A 12-byte window starts on the second byte of a two-byte character.
    const tail = stderrTail(file(`${'\u{e9}'.repeat(50)}\n`), 20, 12);
    assert.equal(tail, 'é'.repeat(5));
  });
});

describe('trailer and result line', () => {
  const launch = 'ks_0123456789ab';

  test('they are kiro-turn and kiro-result followed by <launchId>#<n>', () => {
    assert.equal(formatTurnTrailer(launch, 1), 'kiro-turn: ks_0123456789ab#1');
    assert.equal(formatResultLine(launch, 42), 'kiro-result: ks_0123456789ab#42');
    assert.ok(LAUNCH_ID_PATTERN.test(launch));
  });

  test('a bad launch id or turn number is a RangeError', () => {
    for (const bad of ['ks_0123456789AB', 'ks_0123456789a', 'ks_0123456789abc', 'xx_0123456789ab', '', `${launch}\n`]) {
      assert.throws(() => formatTurnTrailer(bad, 1), RangeError, JSON.stringify(bad));
      assert.throws(() => formatResultLine(bad, 1), RangeError, JSON.stringify(bad));
    }
    for (const turn of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => formatTurnTrailer(launch, turn), RangeError, String(turn));
      assert.throws(() => formatResultLine(launch, turn), RangeError, String(turn));
    }
  });
});

describe('labels', () => {
  test('1 to 40 characters from A-Z, a-z, 0-9, ".", "_" and "-" are valid', () => {
    for (const label of ['a', 'Z', '0', 'review-1', 'api_v2.tests', '...', '-', 'x'.repeat(40), 'A-Za-z0-9._-']) {
      assert.equal(isValidLabel(label), true, label);
      assert.doesNotThrow(() => assertLabel(label));
    }
    assert.ok(LABEL_PATTERN.test('ok'));
  });

  test('anything else is rejected as E_INVALID for label without echoing it', () => {
    const invalid: unknown[] = ['', 'x'.repeat(41), 'has space', 'tab\t', 'line\n', 'ok\n', 'slash/name', 'colon:x', 'café', '\u{1F600}', 'a#1', 7, null, undefined, ['a']];
    for (const label of invalid) {
      assert.equal(isValidLabel(label), false, String(label));
      assert.throws(
        () => assertLabel(label),
        (error: unknown) =>
          error instanceof InvalidInputError &&
          error.code === 'E_INVALID' &&
          error.field === 'label' &&
          (typeof label !== 'string' || label === '' || !error.message.includes(label)),
        String(label),
      );
    }
  });
});
