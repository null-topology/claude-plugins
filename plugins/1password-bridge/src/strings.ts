/**
 * Every user-facing string of the plugin, in each supported language. The
 * `uk` table is the approved wording; `en` is the default for any other
 * language setting.
 */

export type Language = 'en' | 'uk';

/**
 * The 1Password desktop app setting that lets SDK clients talk to it. It is
 * the app's own English label, so it is not translated.
 */
export const SDK_INTEGRATION_SETTING = 'Settings > Developer > Integrate with 1Password SDKs';

export interface Strings {
  windowTitle: string;
  session: string;
  sessionId: string;
  account: string;
  vault: string;
  item: string;
  section: string;
  field: string;
  type: string;
  agent: string;
  startDir: string;
  ticket: string;
  command: string;
  /** The heading of a command that names the ticket id. */
  commandLiteral: string;
  expand: string;
  approve: string;
  deny: string;
  /** The type note of a field returned in plain text. */
  notePlain: string;
  /** The type note of a secret too short to mask. */
  noteShort: string;
  /** The type note of a secret masked in Bash output. */
  noteMasked: string;
}

export const STRINGS: Readonly<Record<Language, Readonly<Strings>>> = {
  en: {
    windowTitle: 'Claude Code requests a secret',
    session: 'Session',
    sessionId: 'Session ID',
    account: 'Account',
    vault: 'Vault',
    item: 'Item',
    section: 'Section',
    field: 'Field',
    type: 'Type',
    agent: 'Agent',
    startDir: 'Started in',
    ticket: 'Ticket',
    command: 'Command',
    commandLiteral: 'Command naming this ticket',
    expand: 'Show all',
    approve: 'Approve',
    deny: 'Deny',
    notePlain: 'not a secret, returned in plain text',
    noteShort: 'secret shorter than 8 characters, NOT masked',
    noteMasked: 'secret, masked in Bash output',
  },
  uk: {
    windowTitle: 'Claude Code запитує секрет',
    session: 'Сесія',
    sessionId: 'ID сесії',
    account: 'Акаунт',
    vault: 'Сховище',
    item: 'Айтем',
    section: 'Секція',
    field: 'Поле',
    type: 'Тип',
    agent: 'Агент',
    startDir: 'Стартова тека',
    ticket: 'Квиток',
    command: 'Команда',
    commandLiteral: 'Команда з цим квитком',
    expand: 'Показати повністю',
    approve: 'Погодити',
    deny: 'Відхилити',
    notePlain: 'не секрет, видається відкрито',
    noteShort: 'секрет коротший за 8 символів, НЕ маскується',
    noteMasked: 'секрет, буде замасковано у виводі Bash',
  },
};

/** The table for `lang`; an unknown or missing language gets `en`. */
export function strings(lang: string | undefined): Readonly<Strings> {
  return lang === 'uk' ? STRINGS.uk : STRINGS.en;
}
