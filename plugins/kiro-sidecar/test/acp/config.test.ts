import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { checkConfigValue, offeredValues } from '../../src/acp/config.ts';
import { AcpClientError } from '../../src/acp/errors.ts';

const MODEL: SessionConfigOption = {
  type: 'select',
  id: 'model',
  name: 'Model',
  currentValue: 'auto',
  options: [
    { value: 'auto', name: 'Auto' },
    { value: 'claude-haiku-4.5', name: 'Haiku' },
  ],
};

const GROUPED: SessionConfigOption = {
  type: 'select',
  id: 'mode',
  name: 'Mode',
  currentValue: 'a',
  options: [
    { group: 'first', name: 'First', options: [{ value: 'a', name: 'A' }] },
    { group: 'second', name: 'Second', options: [{ value: 'b', name: 'B' }] },
  ],
};

const SWITCH: SessionConfigOption = { type: 'boolean', id: 'autopilot', name: 'Autopilot', currentValue: false };

function rejects(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AcpClientError);
    assert.equal(error.code, 'invalid_config');
    assert.match(error.message, pattern);
    return true;
  });
}

describe('offeredValues', () => {
  test('lists plain and grouped select values', () => {
    assert.deepEqual(offeredValues(MODEL), ['auto', 'claude-haiku-4.5']);
    assert.deepEqual(offeredValues(GROUPED), ['a', 'b']);
    assert.deepEqual(offeredValues(SWITCH), []);
  });
});

describe('checkConfigValue', () => {
  test('accepts an offered value', () => {
    assert.equal(checkConfigValue([MODEL], 'model', 'claude-haiku-4.5'), MODEL);
    assert.equal(checkConfigValue([GROUPED], 'mode', 'b'), GROUPED);
    assert.equal(checkConfigValue([SWITCH], 'autopilot', true), SWITCH);
  });

  test('rejects an unoffered value, naming the offered values', () => {
    rejects(() => checkConfigValue([MODEL], 'model', 'gpt-9'), /does not offer "gpt-9"; offered values: auto, claude-haiku-4\.5$/);
    rejects(() => checkConfigValue([SWITCH], 'autopilot', 'yes'), /takes true or false/);
    rejects(() => checkConfigValue([MODEL], 'model', true), /offered values: auto, claude-haiku-4\.5$/);
  });

  test('rejects an unknown option, naming the offered options', () => {
    rejects(() => checkConfigValue([MODEL, SWITCH], 'effortLevel', 'high'), /No config option "effortLevel"; offered options: model, autopilot$/);
    rejects(() => checkConfigValue(undefined, 'model', 'auto'), /offered options: \(none\)$/);
  });
});
