/**
 * Plugin settings, read from `KIRO_SIDECAR_<KEY>` environment variables
 * (the key upper-cased).
 *
 * An unset or empty variable takes the key's default, except `api_key`: the
 * Kiro token comes from `KIRO_SIDECAR_API_KEY` only, so an unset or empty
 * value is an issue. All issues are reported together in one
 * `SettingsError`; each message names its variable, and no message ever
 * contains the API key. A variable that names no current key, such as one
 * of a removed setting, is ignored.
 */

import { resolve } from 'node:path';
import { HOME_NAME_RULE, isValidHomeName } from './home-name.ts';

export type Environment = Readonly<Record<string, string | undefined>>;

export type Mode = 'local' | 'docker';

export interface Settings {
  readonly api_key: string;
  readonly presets_file: string;
  readonly home: string;
  readonly docker_image: string;
  readonly docker_user: string;
  readonly kiro_command: string;
  readonly default_mode: Mode;
  readonly retention_days: number;
  readonly debug_acp: boolean;
  readonly proxy: string;
  readonly no_proxy: string;
}

export type SettingKey = keyof Settings;

export const ENV_PREFIX = 'KIRO_SIDECAR_';

export const DEFAULTS: Settings = Object.freeze({
  api_key: '',
  presets_file: '',
  home: '',
  docker_image: 'sbx/kiro:latest',
  docker_user: 'auto',
  kiro_command: 'kiro-cli',
  default_mode: 'docker',
  retention_days: 14,
  debug_acp: false,
  proxy: '',
  no_proxy: '',
});

export const SETTING_KEYS: readonly SettingKey[] = Object.freeze(
  Object.keys(DEFAULTS) as SettingKey[],
);

/** Name of the environment variable that carries a setting. */
export function envName(key: SettingKey): string {
  return ENV_PREFIX + key.toUpperCase();
}

export interface SettingIssue {
  readonly variable: string;
  readonly message: string;
}

export class SettingsError extends Error {
  readonly issues: readonly SettingIssue[];

  constructor(issues: readonly SettingIssue[]) {
    super(
      `Invalid plugin settings:\n${issues.map((issue) => `- ${issue.message}`).join('\n')}`,
    );
    this.name = 'SettingsError';
    this.issues = Object.freeze([...issues]);
  }
}

/**
 * Reads and validates every setting. Throws `SettingsError` listing all
 * invalid variables.
 */
export function loadSettings(env: Environment = process.env): Settings {
  const secret = env[envName('api_key')] ?? '';
  const issues: SettingIssue[] = [];

  const read = <K extends SettingKey>(key: K): Settings[K] => {
    const variable = envName(key);
    const raw = env[variable];
    if (raw === undefined || raw === '') {
      return DEFAULTS[key];
    }
    const field = FIELDS[key];
    const parsed = field.parse(raw);
    if (parsed.ok) {
      return parsed.value;
    }
    const received = field.sensitive === true ? '' : `, got ${JSON.stringify(raw)}`;
    issues.push({
      variable,
      message: redact(`${variable} must be ${parsed.expected}${received}`, secret),
    });
    return DEFAULTS[key];
  };

  const apiKey = read('api_key');
  if (apiKey === '') {
    issues.push({ variable: envName('api_key'), message: missingTokenMessage(env) });
  }
  const settings: Settings = {
    api_key: apiKey,
    presets_file: read('presets_file'),
    home: read('home'),
    docker_image: read('docker_image'),
    docker_user: read('docker_user'),
    kiro_command: read('kiro_command'),
    default_mode: read('default_mode'),
    retention_days: read('retention_days'),
    debug_acp: read('debug_acp'),
    proxy: read('proxy'),
    no_proxy: read('no_proxy'),
  };

  if (issues.length > 0) {
    throw new SettingsError(issues);
  }
  return Object.freeze(settings);
}

/** The plugin id as `claude plugin list` shows it; the marketplace is not fixed here. */
const PLUGIN_ID = 'kiro-sidecar@<marketplace>';

/** Follows the plugin's MCP config path in the missing-token message. */
const MCP_CONFIG_TOKEN_WARNING =
  'Do not write the token into that file: a plugin update replaces it and it would hold the token ' +
  'in plain text; use "/plugin configure" instead.';

/**
 * Says that the Kiro token is not set and how to set it. With
 * `CLAUDE_PLUGIN_ROOT` set it names the plugin's MCP config by its absolute
 * path and warns against writing the token into that file, which a plugin
 * update replaces and which would hold the token in plain text; without it
 * the server cannot know which config started it.
 */
function missingTokenMessage(env: Environment): string {
  const variable = envName('api_key');
  const parts = [
    `The Kiro token is not set: ${variable} (the setting api_key) is unset or empty.`,
    `Set api_key with "/plugin configure ${PLUGIN_ID}" in Claude Code, or with ` +
      `"claude plugin configure ${PLUGIN_ID} --values-stdin", then restart Claude Code ` +
      `(<marketplace> as in the plugin id that "claude plugin list" shows).`,
  ];
  const pluginRoot = env['CLAUDE_PLUGIN_ROOT'];
  if (pluginRoot !== undefined && pluginRoot !== '') {
    parts.push(
      `For a server registered by hand, set ${variable} in the "env" of its entry in the MCP config.`,
      `This server's MCP config: ${resolve(pluginRoot, '.mcp.json')}`,
      MCP_CONFIG_TOKEN_WARNING,
    );
  } else {
    parts.push(
      `For a server registered by hand, set ${variable} in the "env" of the entry that starts this server in its MCP config.`,
    );
  }
  return parts.join(' ');
}

export const PROXY_VARIABLES = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const);

export type ProxyVariable = (typeof PROXY_VARIABLES)[number];

export type ProxyEnvironment = Readonly<Partial<Record<ProxyVariable, string>>>;

/**
 * Returns the proxy variables present in the environment with their values
 * unchanged. A variable that is present with an empty value counts as set.
 * The values may hold credentials: never log them.
 */
export function readProxyEnvironment(env: Environment = process.env): ProxyEnvironment {
  const found: Partial<Record<ProxyVariable, string>> = {};
  for (const name of PROXY_VARIABLES) {
    const value = env[name];
    if (value !== undefined) {
      found[name] = value;
    }
  }
  return Object.freeze(found);
}

/** The proxy variables the `proxy` setting sets. */
export const PROXY_URL_VARIABLES = Object.freeze(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const);

/** The proxy variables the `no_proxy` setting sets. */
export const NO_PROXY_VARIABLES = Object.freeze(['NO_PROXY', 'no_proxy'] as const);

/**
 * The proxy variables the `proxy` and `no_proxy` settings set: `proxy` sets
 * the four URL variables and `no_proxy` the two exclusion lists, each to the
 * setting's value. An empty setting sets none of its variables. The URL
 * values may hold credentials: never log them.
 */
export function proxySettingsEnvironment(settings: Pick<Settings, 'proxy' | 'no_proxy'>): ProxyEnvironment {
  const found: Partial<Record<ProxyVariable, string>> = {};
  if (settings.proxy !== '') {
    for (const name of PROXY_URL_VARIABLES) {
      found[name] = settings.proxy;
    }
  }
  if (settings.no_proxy !== '') {
    for (const name of NO_PROXY_VARIABLES) {
      found[name] = settings.no_proxy;
    }
  }
  return Object.freeze(found);
}

const LOOPBACK_IPV4_PATTERN = /^127\.[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * True when a proxy URL names a loopback host: `localhost` or a name below
 * it, an IPv4 address in 127.0.0.0/8, or `::1`. A value without a scheme is
 * read as `http://`. A value that does not parse as a URL is not loopback.
 */
export function isLoopbackProxy(proxy: string): boolean {
  if (proxy === '') {
    return false;
  }
  let host: string;
  try {
    host = new URL(proxy.includes('://') ? proxy : `http://${proxy}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || LOOPBACK_IPV4_PATTERN.test(host);
}

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly expected: string };

interface FieldSpec<T> {
  readonly parse: (raw: string) => ParseResult<T>;
  /** A sensitive value is never echoed in an error message. */
  readonly sensitive?: boolean;
}

const DOCKER_USER_PATTERN = /^(?:auto|[0-9]+:[0-9]+)$/;
const INTEGER_PATTERN = /^[0-9]+$/;

function anyString(raw: string): ParseResult<string> {
  return { ok: true, value: raw };
}

function accepting(
  isValid: (raw: string) => boolean,
  expected: string,
): (raw: string) => ParseResult<string> {
  return (raw) => (isValid(raw) ? { ok: true, value: raw } : { ok: false, expected });
}

function matching(pattern: RegExp, expected: string): (raw: string) => ParseResult<string> {
  return accepting((raw) => pattern.test(raw), expected);
}

function oneOf<T extends string>(allowed: readonly T[]): (raw: string) => ParseResult<T> {
  const expected = `one of ${allowed.map((value) => `"${value}"`).join(', ')}`;
  return (raw) => {
    const match = allowed.find((value) => value === raw);
    return match === undefined ? { ok: false, expected } : { ok: true, value: match };
  };
}

function boolean(raw: string): ParseResult<boolean> {
  if (raw === 'true') {
    return { ok: true, value: true };
  }
  if (raw === 'false') {
    return { ok: true, value: false };
  }
  return { ok: false, expected: '"true" or "false"' };
}

function integerInRange(min: number, max: number): (raw: string) => ParseResult<number> {
  const expected = `an integer from ${min} to ${max}`;
  return (raw) => {
    if (!INTEGER_PATTERN.test(raw)) {
      return { ok: false, expected };
    }
    const value = Number(raw);
    return value >= min && value <= max ? { ok: true, value } : { ok: false, expected };
  };
}

function redact(message: string, secret: string): string {
  return secret === '' ? message : message.split(secret).join('[redacted]');
}

const FIELDS: { readonly [K in SettingKey]: FieldSpec<Settings[K]> } = {
  api_key: { parse: anyString, sensitive: true },
  presets_file: { parse: anyString },
  home: { parse: accepting(isValidHomeName, HOME_NAME_RULE) },
  docker_image: { parse: anyString },
  docker_user: {
    parse: matching(DOCKER_USER_PATTERN, '"auto" or "<uid>:<gid>" in decimal digits'),
  },
  kiro_command: { parse: anyString },
  default_mode: { parse: oneOf<Mode>(['local', 'docker']) },
  retention_days: { parse: integerInRange(1, 365) },
  debug_acp: { parse: boolean },
  // A proxy URL can carry credentials.
  proxy: { parse: anyString, sensitive: true },
  no_proxy: { parse: anyString },
};
