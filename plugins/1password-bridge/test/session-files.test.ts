import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { lastSeenPath, maskedMarkerPath, sessionInfoPath } from '../src/paths.ts';
import { markTicket, readMarker, readSessionInfo, touchLastSeen, unmarkTickets, writeSessionInfo } from '../src/session-files.ts';
import { sandbox, SESSION_ID } from './hooks/helpers.ts';

describe('session files', () => {
  test('touchLastSeen creates the file and moves its mtime', () => {
    const box = sandbox();
    try {
      touchLastSeen(box.stateDir, SESSION_ID, 1_000_000);
      assert.equal(statSync(lastSeenPath(box.stateDir, SESSION_ID)).mtimeMs, 1_000_000);
      touchLastSeen(box.stateDir, SESSION_ID, 2_000_000);
      assert.equal(statSync(lastSeenPath(box.stateDir, SESSION_ID)).mtimeMs, 2_000_000);
    } finally {
      box.cleanup();
    }
  });

  test('session.json keeps the start directory; a missing or broken file reads as empty', () => {
    const box = sandbox();
    try {
      assert.deepEqual(readSessionInfo(box.stateDir, SESSION_ID), {});
      writeSessionInfo(box.stateDir, SESSION_ID, { cwd: '/work/repo' });
      assert.deepEqual(readSessionInfo(box.stateDir, SESSION_ID), { cwd: '/work/repo' });
      for (const broken of ['{"cwd":', '', 'null', '{"cwd":5}']) {
        writeFileSync(sessionInfoPath(box.stateDir, SESSION_ID), broken);
        assert.deepEqual(readSessionInfo(box.stateDir, SESSION_ID), {}, JSON.stringify(broken));
      }
    } finally {
      box.cleanup();
    }
  });

  test('the marker lists ticket ids and disappears with the last one', () => {
    const box = sandbox();
    try {
      assert.equal(readMarker(box.stateDir, SESSION_ID), undefined);
      markTicket(box.stateDir, SESSION_ID, 'tkt_aaaaaaaaaaaaaaaa');
      markTicket(box.stateDir, SESSION_ID, 'tkt_bbbbbbbbbbbbbbbb');
      markTicket(box.stateDir, SESSION_ID, 'tkt_aaaaaaaaaaaaaaaa');
      assert.deepEqual(readMarker(box.stateDir, SESSION_ID), ['tkt_aaaaaaaaaaaaaaaa', 'tkt_bbbbbbbbbbbbbbbb']);
      assert.equal(statSync(maskedMarkerPath(box.stateDir, SESSION_ID)).mode & 0o777, 0o600);
      unmarkTickets(box.stateDir, SESSION_ID, ['tkt_aaaaaaaaaaaaaaaa']);
      assert.equal(readFileSync(maskedMarkerPath(box.stateDir, SESSION_ID), 'utf8'), 'tkt_bbbbbbbbbbbbbbbb\n');
      unmarkTickets(box.stateDir, SESSION_ID, ['tkt_bbbbbbbbbbbbbbbb']);
      assert.equal(existsSync(maskedMarkerPath(box.stateDir, SESSION_ID)), false);
    } finally {
      box.cleanup();
    }
  });
});
