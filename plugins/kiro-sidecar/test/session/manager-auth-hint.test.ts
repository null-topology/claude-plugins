/**
 * A1: when Kiro refuses a request because it is not signed in (ACP -32000
 * with authentication, sign-in or login wording), the error keeps its code
 * and gains one sentence saying what to check; any other -32000 reads as
 * before, and the sentence holds no part of the token.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnProcess } from '../../src/acp/process.ts';
import { SidecarError } from '../../src/errors.ts';
import { notSignedInHint } from '../../src/session/manager.ts';
import { PROCESS_TIMEOUT, TEST_TOKEN, endedTurn, managerFixture, testEnvironment } from './manager-helpers.ts';
import type { ManagerFixture } from './manager-helpers.ts';
import type { TestContext } from 'node:test';

const INTERRUPTED = 'Your connection was interrupted. Please try again in a moment.';

async function startError(fixture: ManagerFixture, mode?: 'docker'): Promise<SidecarError> {
  try {
    await fixture.manager.start({ dir: fixture.workspace.dir, ...(mode === undefined ? {} : { mode, image: 'kiro-test:1' }) });
  } catch (error) {
    assert.ok(error instanceof SidecarError, String(error));
    return error;
  }
  assert.fail('the start succeeded');
}

/** A docker-mode fixture whose `docker run` runs the fake agent in place. */
async function dockerFixture(t: TestContext, scenario: string): Promise<ManagerFixture> {
  let command = '';
  const fixture = await managerFixture(t, scenario, {
    settings: { api_key: TEST_TOKEN },
    deps: {
      resolveDockerUser: async () => '0:0',
      checkImage: async () => {},
      spawn: (spec, options) =>
        spawnProcess({ argv: [command, 'acp', '--agent-engine', 'v3'], env: testEnvironment() as Record<string, string>, cwd: spec.cwd }, options),
      removeContainers: () => {},
    },
  });
  command = fixture.workspace.command;
  return fixture;
}

/** True when `text` holds any 8 characters in a row of the token. */
function holdsTokenPart(text: string): boolean {
  for (let start = 0; start + 8 <= TEST_TOKEN.length; start += 1) {
    if (text.includes(TEST_TOKEN.slice(start, start + 8))) {
      return true;
    }
  }
  return false;
}

describe('SessionManager: Kiro not signed in (A1)', () => {
  test('local: session/new refused for authentication keeps E_STEP_SESSION_NEW and gains the hint', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'auth-session-new');
    const error = await startError(fixture);
    assert.equal(error.code, 'E_STEP_SESSION_NEW');
    assert.equal(
      error.message,
      `start step session_new failed: Authentication required (code -32000). ${notSignedInHint('local')}`,
    );
  });

  test('docker: the hint names the setting api_key as the container gets it', PROCESS_TIMEOUT, async (t) => {
    const fixture = await dockerFixture(t, 'auth-session-new');
    const error = await startError(fixture, 'docker');
    assert.equal(error.code, 'E_STEP_SESSION_NEW');
    assert.ok(error.message.endsWith(`(code -32000). ${notSignedInHint('docker')}`), error.message);
    assert.notEqual(notSignedInHint('docker'), notSignedInHint('local'));
  });

  test('a -32000 for a dropped connection reads exactly as before', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'interrupted-session-new');
    const error = await startError(fixture);
    assert.equal(error.code, 'E_STEP_SESSION_NEW');
    assert.equal(error.message, `start step session_new failed: ${INTERRUPTED} (code -32000)`);
  });

  test('a prompt refused for authentication: an error turn with the hint and no part of the token', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'rpc-error');
    const prompt = JSON.stringify({ code: -32000, message: 'Authentication token is invalid: $TOKEN' });
    const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir, prompt });
    const turn = await endedTurn(fixture, launchId, 1);
    assert.equal(turn.outcome, 'error');
    assert.equal(turn.error, `Authentication token is invalid: [REDACTED] (code -32000). ${notSignedInHint('local')}`);
    assert.equal(holdsTokenPart(notSignedInHint('local')), false);
    assert.equal(holdsTokenPart(notSignedInHint('docker')), false);
    assert.equal(holdsTokenPart(JSON.stringify(turn)), false);
  });

  test('a prompt that fails with a -32000 for a dropped connection reads exactly as before', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'rpc-error');
    const { launchId } = await fixture.manager.start({
      dir: fixture.workspace.dir,
      prompt: JSON.stringify({ code: -32000, message: INTERRUPTED }),
    });
    const turn = await endedTurn(fixture, launchId, 1);
    assert.equal(turn.outcome, 'error');
    assert.equal(turn.error, `${INTERRUPTED} (code -32000)`);
  });
});
