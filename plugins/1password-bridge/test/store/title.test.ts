import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionTitle } from '../../src/store/title.ts';

const root = mkdtempSync(join(tmpdir(), 'op-bridge-title-'));
after(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
function transcript(...records: unknown[]): string {
  count += 1;
  const path = join(root, `t${count}.jsonl`);
  writeFileSync(path, records.map((record) => (typeof record === 'string' ? record : JSON.stringify(record))).join('\n'));
  return path;
}

const SESSION = '0b6f3c1e-8f0a-4a57-9d43-2f1f0c9a7e11';
const ai = (aiTitle: string) => ({ type: 'ai-title', aiTitle, sessionId: SESSION });
const custom = (customTitle: string) => ({ type: 'custom-title', customTitle, sessionId: SESSION });
const message = { type: 'user', message: { role: 'user', content: 'mentions "custom-title" in text' }, sessionId: SESSION };

describe('sessionTitle', () => {
  test('the last custom title wins, even over a later AI title', () => {
    assert.equal(
      sessionTitle(transcript(ai('First AI title'), custom('Mine'), message, custom('Mine, renamed'), ai('Later AI title'))),
      'Mine, renamed',
    );
  });

  test('without a custom title, the last AI title', () => {
    assert.equal(sessionTitle(transcript(message, ai('First AI title'), message, ai('Second AI title'))), 'Second AI title');
  });

  test('no title record gives undefined', () => {
    assert.equal(sessionTitle(transcript(message)), undefined);
    assert.equal(sessionTitle(transcript()), undefined);
  });

  test('corrupt lines and records of the wrong shape are skipped', () => {
    assert.equal(
      sessionTitle(
        transcript(
          ai('Kept AI title'),
          '{"type":"custom-title","customTitle":',
          { type: 'custom-title', customTitle: 42 },
          { type: 'custom-title', customTitle: '' },
          { type: 'ai-title' },
        ),
      ),
      'Kept AI title',
    );
  });

  test('never throws: a missing file, a directory or no path give undefined', () => {
    assert.equal(sessionTitle(join(root, 'missing.jsonl')), undefined);
    assert.equal(sessionTitle(root), undefined);
    assert.equal(sessionTitle(''), undefined);
    assert.equal(sessionTitle(undefined), undefined);
  });
});
