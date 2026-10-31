import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SDK_INTEGRATION_SETTING, STRINGS, strings } from '../src/strings.ts';

describe('strings', () => {
  test('both tables have the same keys and no empty value', () => {
    assert.deepEqual(Object.keys(STRINGS.uk).sort(), Object.keys(STRINGS.en).sort());
    for (const [lang, table] of Object.entries(STRINGS)) {
      for (const [key, value] of Object.entries(table)) {
        assert.ok(typeof value === 'string' && value.trim() !== '', `${lang}.${key} is empty`);
      }
    }
  });

  test('the uk table is the approved one', () => {
    assert.deepEqual(STRINGS.uk, {
      windowTitle: 'Claude Code запитує секрет',
      session: 'Сесія',
      sessionId: 'ID сесії',
      agent: 'Агент',
      startDir: 'Стартова тека',
      account: 'Акаунт',
      vault: 'Сховище',
      item: 'Айтем',
      section: 'Секція',
      field: 'Поле',
      type: 'Тип',
      ticket: 'Квиток',
      command: 'Команда',
      commandLiteral: 'Команда з цим квитком',
      expand: 'Показати повністю',
      approve: 'Погодити',
      deny: 'Відхилити',
      notePlain: 'не секрет, видається відкрито',
      noteShort: 'секрет коротший за 8 символів, НЕ маскується',
      noteMasked: 'секрет, буде замасковано у виводі Bash',
    });
  });

  test('the en table', () => {
    assert.deepEqual(STRINGS.en, {
      windowTitle: 'Claude Code requests a secret',
      session: 'Session',
      sessionId: 'Session ID',
      agent: 'Agent',
      startDir: 'Started in',
      account: 'Account',
      vault: 'Vault',
      item: 'Item',
      section: 'Section',
      field: 'Field',
      type: 'Type',
      ticket: 'Ticket',
      command: 'Command',
      commandLiteral: 'Command naming this ticket',
      expand: 'Show all',
      approve: 'Approve',
      deny: 'Deny',
      notePlain: 'not a secret, returned in plain text',
      noteShort: 'secret shorter than 8 characters, NOT masked',
      noteMasked: 'secret, masked in Bash output',
    });
  });

  test('a known language picks its table, anything else falls back to en', () => {
    assert.equal(strings('uk'), STRINGS.uk);
    assert.equal(strings('en'), STRINGS.en);
    for (const lang of [undefined, '', 'fr', 'ru', 'english']) {
      assert.equal(strings(lang), STRINGS.en, String(lang));
    }
  });

  test('the SDK integration setting is the 1Password app label, untranslated', () => {
    assert.equal(SDK_INTEGRATION_SETTING, 'Settings > Developer > Integrate with 1Password SDKs');
  });
});
