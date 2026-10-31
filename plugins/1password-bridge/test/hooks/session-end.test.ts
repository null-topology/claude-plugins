import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { AskBroker } from '../../src/hooks/broker.ts';
import { hookLogPath } from '../../src/hooks/log.ts';
import { sessionEnd } from '../../src/hooks/session-end.ts';
import { BrokerError, type BrokerErrorCode } from '../../src/mcp/broker-client.ts';
import { sessionDir } from '../../src/paths.ts';
import { markTicket, touchLastSeen } from '../../src/session-files.ts';
import { PROTOCOL_VERSION } from '../../src/version.ts';
import { context, OTHER_SESSION_ID, sandbox, SECRET, SESSION_ID, type Sandbox } from './helpers.ts';

let box: Sandbox;

beforeEach(() => {
  box = sandbox();
});

afterEach(() => {
  box.cleanup();
});

function input(sessionId: unknown = SESSION_ID) {
  return { hook_event_name: 'SessionEnd', session_id: sessionId, transcript_path: '/t.jsonl', cwd: '/work', reason: 'clear' };
}

const ended: AskBroker = async () => ({ ok: true, op: 'end_session' });

describe('sessionEnd', () => {
  test('removes the session directory, and only that one', async () => {
    touchLastSeen(box.stateDir, SESSION_ID, Date.now());
    touchLastSeen(box.stateDir, OTHER_SESSION_ID, Date.now());
    const dir = sessionDir(box.stateDir, SESSION_ID);
    const other = sessionDir(box.stateDir, OTHER_SESSION_ID);
    assert.equal(await sessionEnd(context(box.stateDir, input()), ended), undefined);
    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(other), true);
  });

  test('removes an empty session directory too', async () => {
    const dir = sessionDir(box.stateDir, SESSION_ID);
    mkdirSync(dir, { recursive: true });
    assert.equal(await sessionEnd(context(box.stateDir, input()), ended), undefined);
    assert.equal(existsSync(dir), false);
  });

  test('a missing directory or an invalid session id is not an error', async () => {
    const sent: unknown[] = [];
    const ask: AskBroker = async (req) => {
      sent.push(req);
      return { ok: true, op: 'end_session' };
    };
    assert.equal(await sessionEnd(context(box.stateDir, input()), ask), undefined);
    assert.equal(await sessionEnd(context(box.stateDir, input('../..')), ask), undefined);
    assert.equal(await sessionEnd(context(box.stateDir, { hook_event_name: 'SessionEnd' }), ask), undefined);
    assert.equal(existsSync(box.root), true);
    // Only the valid session id reaches the broker.
    assert.equal(sent.length, 1);
  });

  test('tells the broker to forget the session, then removes the directory; a broker down only costs the call', async () => {
    touchLastSeen(box.stateDir, SESSION_ID, Date.now());
    const sent: unknown[] = [];
    await sessionEnd(context(box.stateDir, { hook_event_name: 'SessionEnd', session_id: SESSION_ID }), async (req) => {
      sent.push(req);
      throw new Error('down');
    });
    assert.deepEqual(sent, [{ v: PROTOCOL_VERSION, op: 'end_session', session: SESSION_ID }]);
    assert.equal(existsSync(sessionDir(box.stateDir, SESSION_ID)), false);
  });

  test('every broker error and a failure answer leave only the file cleanup', async () => {
    const codes: readonly BrokerErrorCode[] = ['unavailable', 'untrusted', 'closed', 'timeout', 'protocol'];
    const asks: AskBroker[] = codes.map((code) => async () => {
      throw new BrokerError(code, code);
    });
    asks.push(async () => ({ ok: false, code: 'displaced', message: 'another broker took the socket' }));
    for (const ask of asks) {
      markTicket(box.stateDir, SESSION_ID, 'tkt_aaaaaaaaaaaaaaaa');
      assert.equal(await sessionEnd(context(box.stateDir, input()), ask), undefined);
      assert.equal(existsSync(sessionDir(box.stateDir, SESSION_ID)), false);
    }
  });

  test('a broker failure is logged at step end-session with its code, never its message, and the files still go', async () => {
    const asks: AskBroker[] = (['untrusted', 'closed', 'timeout', 'protocol'] as const).map((code) => async () => {
      throw new BrokerError(code, `broker ${code} near ${SECRET}`);
    });
    asks.push(async () => ({ ok: false, code: 'displaced', message: `another broker took the socket near ${SECRET}` }));
    asks.push(async () => {
      throw new Error(`down near ${SECRET}`);
    });
    for (const ask of asks) {
      markTicket(box.stateDir, SESSION_ID, 'tkt_aaaaaaaaaaaaaaaa');
      assert.equal(await sessionEnd(context(box.stateDir, input()), ask), undefined);
      assert.equal(existsSync(sessionDir(box.stateDir, SESSION_ID)), false);
    }
    const log = readFileSync(hookLogPath(box.stateDir), 'utf8');
    assert.ok(!log.includes(SECRET));
    const lines = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const line of lines) assert.deepEqual(Object.keys(line).sort(), ['at', 'code', 'event', 'step']);
    assert.deepEqual(
      lines.map(({ event, step, code }) => ({ event, step, code })),
      ['UNTRUSTED', 'CLOSED', 'TIMEOUT', 'PROTOCOL', 'DISPLACED', 'Error'].map((code) => ({ event: 'SessionEnd', step: 'end-session', code })),
    );
  });

  test('a broker that is not running, or one that forgets the session, logs nothing', async () => {
    const down: AskBroker = async () => {
      throw new BrokerError('unavailable', 'The 1password-bridge broker is not running.');
    };
    for (const ask of [down, ended]) {
      markTicket(box.stateDir, SESSION_ID, 'tkt_aaaaaaaaaaaaaaaa');
      assert.equal(await sessionEnd(context(box.stateDir, input()), ask), undefined);
      assert.equal(existsSync(sessionDir(box.stateDir, SESSION_ID)), false);
    }
    assert.equal(existsSync(hookLogPath(box.stateDir)), false);
  });
});
