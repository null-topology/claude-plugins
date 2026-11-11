/**
 * Telling Kiro's "not signed in" answers from its other ACP -32000 answers
 * (A1): only the code and authentication, sign-in or login wording count.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestError } from '@agentclientprotocol/sdk';
import { AUTH_REQUIRED_CODE, isAuthenticationError } from '../../src/acp/errors.ts';
import { notSignedInHint } from '../../src/session/manager.ts';

describe('isAuthenticationError', () => {
  test('-32000 with authentication, sign-in or login wording in the message, any case', () => {
    // Messages of Kiro CLI 3.2.0 (its bundled engine) and the ACP default.
    for (const message of [
      'Authentication required',
      'Authentication token has expired',
      'Authentication token is invalid: bad signature',
      'Sign in to Kiro to send a prompt.',
      'Kiro could not load the available models because you are not signed in. Please sign in and retry.',
      'Sign-in credential records no provider',
      'LOGIN REQUIRED',
      'please log in first',
      'You are not logged-in',
    ]) {
      assert.equal(isAuthenticationError(new RequestError(AUTH_REQUIRED_CODE, message)), true, message);
    }
    assert.equal(isAuthenticationError(RequestError.authRequired()), true);
  });

  test('-32000 with the wording in its data only', () => {
    assert.equal(isAuthenticationError(new RequestError(-32000, 'Request failed', { reason: 'not signed in' })), true);
    assert.equal(isAuthenticationError(new RequestError(-32000, 'Request failed', 'authentication expired')), true);
  });

  test('a dropped connection and other -32000 answers are not', () => {
    for (const message of [
      'Your connection was interrupted. Please try again in a moment.',
      "Session 'sess_1' not found",
      'Kiro could not load the available models. Please try again.',
      'Required MCP server sidecar did not become ready in time.',
      'Designing in progress',
      'Session assigned in workflow run',
      'The catalog is logging in background',
    ]) {
      assert.equal(isAuthenticationError(new RequestError(-32000, message, { errorType: 'X' })), false, message);
    }
  });

  test('the wording with another code, or no code, is not', () => {
    assert.equal(isAuthenticationError(new RequestError(-32603, 'Authentication required')), false);
    assert.equal(isAuthenticationError(new Error('Authentication required')), false);
    assert.equal(isAuthenticationError({ code: '-32000', message: 'Authentication required' }), false);
    assert.equal(isAuthenticationError(null), false);
    assert.equal(isAuthenticationError('Authentication required'), false);
  });

  test('data that cannot be serialised is no match and no throw', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    assert.equal(isAuthenticationError(new RequestError(-32000, 'Request failed', cyclic)), false);
  });
});

describe('notSignedInHint', () => {
  test('one sentence naming the setting api_key in both modes, the mode in its tail', () => {
    for (const mode of ['docker', 'local'] as const) {
      const hint = notSignedInHint(mode);
      assert.ok(hint.startsWith('Kiro is not signed in: check that the plugin setting api_key'), hint);
      assert.equal(hint.split('. ').length, 1, 'one sentence');
      assert.ok(hint.endsWith('.'), hint);
    }
    assert.match(notSignedInHint('docker'), /container/);
    assert.match(notSignedInHint('local'), /local mode passes to Kiro CLI as KIRO_API_KEY/);
  });
});
