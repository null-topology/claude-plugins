import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PermissionOption } from '@agentclientprotocol/sdk';
import { CANCELLED_RESPONSE, choosePermission } from '../../src/acp/permissions.ts';

const option = (optionId: string, kind: PermissionOption['kind']): PermissionOption => ({ optionId, name: optionId, kind });

/** The four kinds v3 offers, with the ids it uses. */
const KIRO_OPTIONS = [
  option('accept', 'allow_once'),
  option('always-accept', 'allow_always'),
  option('reject', 'reject_once'),
  option('always-reject', 'reject_always'),
];

function chosenId(options: readonly PermissionOption[], decision: 'allow' | 'deny'): string | undefined {
  const { outcome } = choosePermission(options, decision).response;
  return outcome.outcome === 'selected' ? outcome.optionId : undefined;
}

describe('choosePermission', () => {
  test('allow picks allow_once and deny picks reject_once when all kinds are offered', () => {
    assert.equal(chosenId(KIRO_OPTIONS, 'allow'), 'accept');
    assert.equal(chosenId(KIRO_OPTIONS, 'deny'), 'reject');
    assert.equal(choosePermission(KIRO_OPTIONS, 'allow').via, 'policy');
  });

  test('falls back to the always kinds', () => {
    const options = [option('a2', 'allow_always'), option('r2', 'reject_always')];
    assert.equal(chosenId(options, 'allow'), 'a2');
    assert.equal(chosenId(options, 'deny'), 'r2');
    assert.equal(choosePermission(options, 'deny').via, 'policy');
  });

  test('reads option ids from the request, whatever their order', () => {
    const options = [option('x-reject', 'reject_once'), option('x-allow', 'allow_once')];
    assert.equal(chosenId(options, 'allow'), 'x-allow');
    assert.equal(chosenId(options, 'deny'), 'x-reject');
  });

  test('allow with no allow kind falls back to a reject kind', () => {
    const choice = choosePermission([option('never', 'reject_always')], 'allow');
    assert.deepEqual(choice.response, { outcome: { outcome: 'selected', optionId: 'never' } });
    assert.equal(choice.via, 'fallback');
    assert.equal(choice.option?.kind, 'reject_always');
  });

  test('a request with neither wanted nor reject kinds is answered cancelled', () => {
    for (const [options, decision] of [
      [[option('ok', 'allow_once')], 'deny'],
      [[], 'allow'],
      [[], 'deny'],
    ] as const) {
      const choice = choosePermission(options, decision);
      assert.deepEqual(choice.response, CANCELLED_RESPONSE);
      assert.equal(choice.option, undefined);
      assert.equal(choice.via, 'fallback');
    }
  });

  test('prefers reject_once over reject_always in the fallback', () => {
    const options = [option('r2', 'reject_always'), option('r1', 'reject_once')];
    assert.equal(chosenId(options, 'allow'), 'r1');
  });
});
