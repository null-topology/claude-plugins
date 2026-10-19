/**
 * Session config options as the agent reports them, and the check that a
 * value is offered before it is sent.
 *
 * `session/new`, `session/load`, every `config_option_update` and every
 * `session/set_config_option` result carry the full list, so the latest list
 * replaces the previous one. Options can appear later: Kiro adds
 * `effortLevel` after a model that has effort levels is set.
 */
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { AcpClientError } from './errors.ts';

export type ConfigValue = string | boolean;

/** The values a select option offers, flattened across groups. */
export function offeredValues(option: SessionConfigOption): readonly string[] {
  if (option.type !== 'select') {
    return [];
  }
  const values: string[] = [];
  for (const entry of option.options) {
    if ('group' in entry) {
      for (const item of entry.options) {
        values.push(item.value);
      }
    } else {
      values.push(entry.value);
    }
  }
  return values;
}

/**
 * Returns the option `configId` if `value` is one it offers; throws an
 * `invalid_config` error naming what is offered otherwise.
 */
export function checkConfigValue(
  options: readonly SessionConfigOption[] | undefined,
  configId: string,
  value: ConfigValue,
): SessionConfigOption {
  const option = options?.find((candidate) => candidate.id === configId);
  if (option === undefined) {
    throw missingOptionError(options, configId);
  }
  if (option.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new AcpClientError('invalid_config', `Config option "${configId}" takes true or false`);
    }
    return option;
  }
  const values = offeredValues(option);
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new AcpClientError(
      'invalid_config',
      `Config option "${configId}" does not offer ${JSON.stringify(value)}; offered values: ${listOrNone(values)}`,
    );
  }
  return option;
}

/** The `invalid_config` error for an option the agent does not offer, naming the ones it does. */
export function missingOptionError(
  options: readonly SessionConfigOption[] | undefined,
  configId: string,
): AcpClientError {
  const offered = (options ?? []).map((option) => option.id);
  return new AcpClientError('invalid_config', `No config option "${configId}"; offered options: ${listOrNone(offered)}`);
}

function listOrNone(items: readonly string[]): string {
  return items.length === 0 ? '(none)' : items.join(', ');
}
