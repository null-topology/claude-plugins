import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnProcess } from '../../src/acp/process.ts';
import type { ManagerDeps } from '../../src/session/manager.ts';
import { PROCESS_TIMEOUT, TEST_TOKEN, endedTurn, managerFixture } from './manager-helpers.ts';

/** The stderr line the `stderr-secret` scenario writes for `filler`, as it must land in stderr.log. */
function redactedLine(filler: number): string {
  return `${'x'.repeat(filler)}[REDACTED] ✓\n`;
}

/** Fails when any 8 consecutive characters of the token are in `text`. */
function assertNoTokenPart(text: string): void {
  for (let at = 0; at + 8 <= TEST_TOKEN.length; at += 1) {
    const part = TEST_TOKEN.slice(at, at + 8);
    assert.equal(text.includes(part), false, `stderr.log holds ${JSON.stringify(part)} of the token`);
  }
}

/**
 * Runs one turn per filler length in one session, stops it and returns its
 * stderr.log.
 */
async function stderrLogOf(t: TestContext, fillers: readonly number[], deps?: Partial<ManagerDeps>): Promise<string> {
  const fixture = await managerFixture(t, 'stderr-secret', {
    settings: { api_key: TEST_TOKEN },
    ...(deps === undefined ? {} : { deps }),
  });
  const [first, ...rest] = fillers;
  const { launchId } = await fixture.manager.start({ dir: fixture.workspace.dir, prompt: String(first) });
  assert.equal((await endedTurn(fixture, launchId, 1)).outcome, 'end_turn');
  for (const [index, filler] of rest.entries()) {
    await fixture.manager.send({ launchId, text: String(filler) });
    assert.equal((await endedTurn(fixture, launchId, index + 2)).outcome, 'end_turn');
  }
  await fixture.manager.stop({ launchId });
  return readFile(join(fixture.stateDir, 'runs', launchId, 'stderr.log'), 'utf8');
}

describe('SessionManager: Kiro stderr reaches stderr.log only redacted', () => {
  test('a stderr line longer than 8192 characters keeps no part of the token, at the 8192nd character or past it', PROCESS_TIMEOUT, async (t) => {
    const fillers = [8_182, 8_192 - TEST_TOKEN.length, 8_191, 8_192, 20_000];
    const log = await stderrLogOf(t, fillers);
    assertNoTokenPart(log);
    assert.ok(log.includes(fillers.map(redactedLine).join('')), `stderr.log ends with ${JSON.stringify(log.slice(-120))}`);
  });

  test('a token split across stderr chunks at every byte is redacted', PROCESS_TIMEOUT, async (t) => {
    const fillers = [10, 8_182];
    const log = await stderrLogOf(t, fillers, {
      // Hands the manager every stderr byte as a chunk of its own.
      spawn: (spec, options) =>
        spawnProcess(spec, {
          ...options,
          onStderr: (chunk) => {
            for (let at = 0; at < chunk.length; at += 1) {
              options.onStderr?.(chunk.subarray(at, at + 1));
            }
          },
        }),
    });
    assertNoTokenPart(log);
    assert.ok(log.includes(fillers.map(redactedLine).join('')), `stderr.log ends with ${JSON.stringify(log.slice(-120))}`);
  });
});
