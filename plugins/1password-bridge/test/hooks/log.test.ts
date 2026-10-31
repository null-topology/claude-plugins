import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCode } from '../../src/hooks/log.ts';
import { BrokerError, type BrokerErrorCode } from '../../src/mcp/broker-client.ts';
import { FAILURE_CODES } from '../../src/protocol.ts';
import { SECRET } from './helpers.ts';

/** What the hook log accepts as a code (ERROR_CODE in src/hooks/log.ts). */
const LOGGED_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;
const BROKER_ERRORS: readonly BrokerErrorCode[] = ['unavailable', 'untrusted', 'closed', 'timeout', 'protocol'];

describe('errorCode', () => {
  test('a Node.js error code is logged as it is', () => {
    assert.equal(errorCode(Object.assign(new Error(SECRET), { code: 'ENOENT' })), 'ENOENT');
  });

  test('every BrokerError code is logged upper-cased', () => {
    for (const code of BROKER_ERRORS) {
      const logged = errorCode(new BrokerError(code, `broker ${code} near ${SECRET}`));
      assert.equal(logged, code.toUpperCase());
      assert.match(logged, LOGGED_CODE, code);
    }
  });

  test('every broker failure code is logged upper-cased', () => {
    for (const code of FAILURE_CODES) {
      const logged = errorCode(Object.assign(new Error(SECRET), { code }));
      assert.equal(logged, code.toUpperCase());
      assert.match(logged, LOGGED_CODE, code);
    }
  });

  test('any other lower-case code falls back to the class name, never the code', () => {
    for (const code of [SECRET, 'enoent', 'Timeout', 'timeout ', 'displaced\n', 'toString']) {
      assert.equal(errorCode(Object.assign(new TypeError(SECRET), { code })), 'TypeError', JSON.stringify(code));
    }
    assert.equal(errorCode({ code: SECRET }), 'unknown');
  });
});
