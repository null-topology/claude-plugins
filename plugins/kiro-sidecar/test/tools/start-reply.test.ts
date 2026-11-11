/**
 * The start tool's reply carries what SessionManager.start returns: the image
 * refresh line reaches the caller, and a start without one adds no key. The
 * manager is a stub, since the refresh happens only in docker mode; the
 * manager side is covered by test/session/manager-start-image.test.ts.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../../src/tools/tools.ts';
import type { Runtime, ToolContext } from '../../src/tools/runtime.ts';
import type { StartResult } from '../../src/session/manager.ts';

const START = TOOLS.find((tool) => tool.name === 'start');

function startResult(extra: Partial<StartResult>): StartResult {
  return {
    launchId: 'ks_0123456789ab',
    sessionId: 'sess_fixture',
    label: null,
    mode: 'docker',
    dir: '/work/app',
    home: 'default',
    model: null,
    effort: null,
    kiroMode: null,
    skills: [],
    steering: [],
    permissions: 'allow',
    turn: 1,
    trailer: 'kiro-turn: ks_0123456789ab#1',
    ...extra,
  } as StartResult;
}

/** Runs the real start tool against a manager whose start answers `result`. */
async function reply(result: StartResult): Promise<string> {
  assert.ok(START !== undefined);
  const manager = { start: async () => result };
  const runtime = { context: async () => ({ manager }) as unknown as ToolContext } as unknown as Runtime;
  return START.run(runtime, {
    args: { dir: '/work/app', prompt: 'Review the parser.' },
    toolUseId: undefined,
    signal: new AbortController().signal,
    progress: undefined,
  });
}

describe('start reply: the image refresh', () => {
  test('a refresh line from the manager is in the reply as imageRefresh, before the trailer', async () => {
    const line = 'The image kiro-sidecar:latest was replaced: sha256:aaa -> sha256:bbb.';
    const text = await reply(startResult({ imageRefresh: line }));
    const lines = text.split('\n');
    assert.equal(lines.at(-1), 'kiro-turn: ks_0123456789ab#1');
    const fields = JSON.parse(lines.slice(0, -1).join('\n')) as Record<string, unknown>;
    assert.equal(fields['imageRefresh'], line);
    assert.equal(Object.hasOwn(fields, 'trailer'), false);
  });

  test('no refresh line, no imageRefresh key', async () => {
    const lines = (await reply(startResult({}))).split('\n');
    const fields = JSON.parse(lines.slice(0, -1).join('\n')) as Record<string, unknown>;
    assert.equal(Object.hasOwn(fields, 'imageRefresh'), false);
    assert.equal(fields['launchId'], 'ks_0123456789ab');
  });
});
