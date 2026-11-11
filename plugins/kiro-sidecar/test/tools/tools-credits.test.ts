/**
 * A2: every reply that carries a turn result carries its `credits`, in full
 * (`wait`, `cancel`, `send {interrupt: true}`, `stop`).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROCESS_TIMEOUT } from '../session/manager-helpers.ts';
import { assertOk, harness, replyJson } from './harness.ts';

const SHORT_CONTROL = { controlLimits: { stopGraceMs: 300, killGraceMs: 300 } };
const CREDITS = 0.06553350699834162;
const metered = (name: string, usage: number) =>
  `${name} ${JSON.stringify([{ kind: 'turn_completion', promptTurnSummaries: [{ unit: 'credit', usage }] }])}`;

describe('tools over MCP: credits in turn results (A2)', () => {
  test('wait, cancel, send {interrupt} and stop return credits unrounded', PROCESS_TIMEOUT, async (t) => {
    const h = await harness(t, 'harness', SHORT_CONTROL);
    const started = replyJson(assertOk(await h.call('start', { dir: h.workspace.dir, prompt: metered('credits', CREDITS) })));
    const launchId = started['launchId'] as string;

    const waited = replyJson(assertOk(await h.call('wait', { session: launchId })));
    assert.equal(waited['credits'], CREDITS);

    assertOk(await h.call('send', { session: launchId, text: metered('credits-then-hold', 0.5) }));
    await sleep(200);
    const cancelled = replyJson(assertOk(await h.call('cancel', { session: launchId })));
    assert.equal((cancelled['result'] as Record<string, unknown>)['credits'], 0.5);

    assertOk(await h.call('send', { session: launchId, text: metered('credits-then-hold', 1.25) }));
    await sleep(200);
    const interrupted = replyJson(
      assertOk(await h.call('send', { session: launchId, text: metered('credits-then-hold', 2), interrupt: true })),
    );
    assert.equal((interrupted['interrupted'] as Record<string, unknown>)['credits'], 1.25);

    await sleep(200);
    const stopped = replyJson(assertOk(await h.call('stop', { session: launchId })));
    const result = stopped['result'] as Record<string, unknown>;
    assert.equal(result['outcome'], 'stopped');
    assert.equal(result['credits'], 2);
  });
});
