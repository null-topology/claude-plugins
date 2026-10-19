import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { inspect } from 'node:util';
import {
  DEFAULTS,
  PROXY_VARIABLES,
  SETTING_KEYS,
  SettingsError,
  envName,
  isLoopbackProxy,
  loadSettings,
  proxySettingsEnvironment,
  readProxyEnvironment,
} from '../src/settings.ts';
import type { SettingKey } from '../src/settings.ts';

const EXPECTED_DEFAULTS = {
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
};

/** The token every environment below needs, since an unset token is an issue of its own. */
const TOKEN = 'sk-test-0123456789abcdef';
const WITH_TOKEN = Object.freeze({ [envName('api_key')]: TOKEN });
const EXPECTED_WITH_TOKEN = { ...EXPECTED_DEFAULTS, api_key: TOKEN };

const MISSING_TOKEN =
  'The Kiro token is not set: KIRO_SIDECAR_API_KEY (the setting api_key) is unset or empty. ' +
  'Set api_key with "/plugin configure kiro-sidecar@<marketplace>" in Claude Code, or with ' +
  '"claude plugin configure kiro-sidecar@<marketplace> --values-stdin", then restart Claude Code ' +
  '(<marketplace> as in the plugin id that "claude plugin list" shows).';
const BY_HAND_WITHOUT_PATH =
  'For a server registered by hand, set KIRO_SIDECAR_API_KEY in the "env" of the entry that starts this server in its MCP config.';
const BY_HAND_WITH_PATH =
  'For a server registered by hand, set KIRO_SIDECAR_API_KEY in the "env" of its entry in the MCP config.';
const PATH_WARNING =
  'Do not write the token into that file: a plugin update replaces it and it would hold the token in plain text; ' +
  'use "/plugin configure" instead.';

function captureError(run: () => unknown): SettingsError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof SettingsError, `expected SettingsError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected loadSettings to throw');
}

describe('settings', () => {
  test('variable names are the prefix plus the upper-cased key', () => {
    assert.equal(envName('api_key'), 'KIRO_SIDECAR_API_KEY');
    assert.equal(envName('retention_days'), 'KIRO_SIDECAR_RETENTION_DAYS');
    assert.deepEqual([...SETTING_KEYS].sort(), Object.keys(EXPECTED_DEFAULTS).sort());
  });

  test('with only the token set, every other setting takes its default', () => {
    assert.deepEqual(loadSettings(WITH_TOKEN), EXPECTED_WITH_TOKEN);
    assert.deepEqual(DEFAULTS, EXPECTED_DEFAULTS);
  });

  test('an empty variable means the default', () => {
    const env = { ...Object.fromEntries(SETTING_KEYS.map((key) => [envName(key), ''])), ...WITH_TOKEN };
    assert.deepEqual(loadSettings(env), EXPECTED_WITH_TOKEN);
  });

  test('the result is frozen', () => {
    assert.ok(Object.isFrozen(loadSettings(WITH_TOKEN)));
  });

  test('variables outside the prefix are ignored', () => {
    assert.deepEqual(
      loadSettings({ ...WITH_TOKEN, RETENTION_DAYS: 'x', kiro_sidecar_retention_days: 'x' }),
      EXPECTED_WITH_TOKEN,
    );
  });

  const validCases: ReadonlyArray<readonly [SettingKey, string, unknown]> = [
    ['api_key', 'sk-test-0123456789', 'sk-test-0123456789'],
    ['api_key', 'any value: spaces / slashes and "quotes"', 'any value: spaces / slashes and "quotes"'],
    ['presets_file', '/opt/presets/team.json', '/opt/presets/team.json'],
    ['home', 'work', 'work'],
    ['home', 'A', 'A'],
    ['home', 'team.alpha_1-b', 'team.alpha_1-b'],
    ['home', 'x'.repeat(64), 'x'.repeat(64)],
    ['home', '...', '...'],
    ['home', '.hidden', '.hidden'],
    ['docker_image', 'example/kiro-image:1.2.3', 'example/kiro-image:1.2.3'],
    ['docker_user', 'auto', 'auto'],
    ['docker_user', '1000:1000', '1000:1000'],
    ['docker_user', '0:0', '0:0'],
    ['kiro_command', '/usr/local/bin/kiro-cli', '/usr/local/bin/kiro-cli'],
    ['default_mode', 'local', 'local'],
    ['default_mode', 'docker', 'docker'],
    ['retention_days', '1', 1],
    ['retention_days', '30', 30],
    ['retention_days', '365', 365],
    ['debug_acp', 'true', true],
    ['debug_acp', 'false', false],
    ['proxy', 'http://user:pass@proxy.example:3128', 'http://user:pass@proxy.example:3128'],
    ['proxy', 'http://127.0.0.1:10817', 'http://127.0.0.1:10817'],
    ['no_proxy', 'localhost,.internal.example', 'localhost,.internal.example'],
  ];

  for (const [key, raw, expected] of validCases) {
    test(`${envName(key)}=${JSON.stringify(raw)} is accepted`, () => {
      const settings = loadSettings({ ...WITH_TOKEN, [envName(key)]: raw });
      assert.deepEqual(settings[key], expected);
      assert.deepEqual({ ...settings, [key]: EXPECTED_WITH_TOKEN[key] }, EXPECTED_WITH_TOKEN);
    });
  }

  const invalidCases: ReadonlyArray<readonly [SettingKey, string]> = [
    ['home', 'x'.repeat(65)],
    ['home', 'has space'],
    ['home', 'a/b'],
    ['home', 'a:b'],
    ['home', '.'],
    ['home', '..'],
    ['docker_user', 'root'],
    ['docker_user', '1000'],
    ['docker_user', '1000:'],
    ['docker_user', ':1000'],
    ['docker_user', 'a:b'],
    ['docker_user', '1:2:3'],
    ['docker_user', 'Auto'],
    ['default_mode', 'remote'],
    ['default_mode', 'Local'],
    ['default_mode', 'docker '],
    ['retention_days', '0'],
    ['retention_days', '366'],
    ['retention_days', '-1'],
    ['retention_days', '1.5'],
    ['retention_days', '1e1'],
    ['retention_days', '+5'],
    ['retention_days', ' 14'],
    ['retention_days', 'fourteen'],
    ['debug_acp', 'on'],
    ['debug_acp', '0'],
  ];

  for (const [key, raw] of invalidCases) {
    test(`${envName(key)}=${JSON.stringify(raw)} is rejected with the variable named`, () => {
      const error = captureError(() => loadSettings({ ...WITH_TOKEN, [envName(key)]: raw }));
      assert.equal(error.issues.length, 1);
      const [issue] = error.issues;
      assert.ok(issue);
      assert.equal(issue.variable, envName(key));
      assert.ok(issue.message.startsWith(`${envName(key)} must be `), issue.message);
      assert.ok(issue.message.includes(JSON.stringify(raw)), issue.message);
      assert.ok(error.message.includes(issue.message), error.message);
    });
  }

  test('the removed setting protocol_steering is no key, and its variable still set changes nothing', () => {
    assert.equal((SETTING_KEYS as readonly string[]).includes('protocol_steering'), false);
    for (const raw of ['true', 'false', 'yes', '']) {
      const settings = loadSettings({ ...WITH_TOKEN, KIRO_SIDECAR_PROTOCOL_STEERING: raw });
      assert.deepEqual(settings, EXPECTED_WITH_TOKEN);
      assert.equal('protocol_steering' in settings, false);
    }
  });

  test('every invalid variable is reported in one error', () => {
    const error = captureError(() =>
      loadSettings({
        ...WITH_TOKEN,
        [envName('home')]: 'a/b',
        [envName('retention_days')]: '0',
        [envName('debug_acp')]: 'yes',
      }),
    );
    assert.deepEqual(
      error.issues.map((issue) => issue.variable),
      [envName('home'), envName('retention_days'), envName('debug_acp')],
    );
  });

  test('the api key never appears in an error', () => {
    const apiKey = 'sk-test-SECRET-4f9a2c';
    const error = captureError(() =>
      loadSettings({
        [envName('api_key')]: apiKey,
        [envName('home')]: `${apiKey}/nested`,
        [envName('docker_user')]: apiKey,
        [envName('default_mode')]: apiKey,
        [envName('retention_days')]: apiKey,
        [envName('debug_acp')]: `prefix-${apiKey}-suffix`,
      }),
    );
    assert.equal(error.issues.length, 5);
    const surfaces = [
      error.message,
      String(error.stack),
      String(error),
      inspect(error, { depth: null }),
      JSON.stringify(error.issues),
    ];
    for (const surface of surfaces) {
      assert.ok(!surface.includes(apiKey), `api key leaked into: ${surface}`);
    }
    assert.ok(error.issues.every((issue) => issue.message.includes('[redacted]')));
  });
});

describe('the token setting', () => {
  for (const [name, env] of [
    ['unset', {}],
    ['empty', { [envName('api_key')]: '' }],
    ['unset with an empty CLAUDE_PLUGIN_ROOT', { CLAUDE_PLUGIN_ROOT: '' }],
  ] as const) {
    test(`${name}: one issue that says how to set it and names no config path`, () => {
      const error = captureError(() => loadSettings(env));
      assert.equal(error.issues.length, 1);
      assert.deepEqual(error.issues[0], {
        variable: 'KIRO_SIDECAR_API_KEY',
        message: `${MISSING_TOKEN} ${BY_HAND_WITHOUT_PATH}`,
      });
      assert.equal(error.message, `Invalid plugin settings:\n- ${MISSING_TOKEN} ${BY_HAND_WITHOUT_PATH}`);
      assert.equal(error.message.includes('.mcp.json'), false);
    });
  }

  test("the server's own KIRO_API_KEY is no token", () => {
    const error = captureError(() => loadSettings({ KIRO_API_KEY: 'server_inherited_key_0123456789' }));
    assert.deepEqual(error.issues.map((issue) => issue.variable), ['KIRO_SIDECAR_API_KEY']);
  });

  for (const [name, pluginRoot] of [
    ['absolute', '/opt/claude/plugins/kiro-sidecar'],
    ['relative', 'plugins/kiro-sidecar'],
  ] as const) {
    test(`with a ${name} CLAUDE_PLUGIN_ROOT the message names the absolute .mcp.json path, then warns against writing the token into it`, () => {
      for (const value of [undefined, '']) {
        const env = { CLAUDE_PLUGIN_ROOT: pluginRoot, ...(value === undefined ? {} : { [envName('api_key')]: value }) };
        const error = captureError(() => loadSettings(env));
        const path = resolve(pluginRoot, '.mcp.json');
        assert.ok(path.startsWith('/'), path);
        assert.deepEqual(error.issues[0], {
          variable: 'KIRO_SIDECAR_API_KEY',
          message: `${MISSING_TOKEN} ${BY_HAND_WITH_PATH} This server's MCP config: ${path} ${PATH_WARNING}`,
        });
      }
    });
  }

  test('a set token makes no issue, whatever CLAUDE_PLUGIN_ROOT', () => {
    assert.deepEqual(loadSettings({ ...WITH_TOKEN, CLAUDE_PLUGIN_ROOT: '/opt/claude/plugins/kiro-sidecar' }), EXPECTED_WITH_TOKEN);
  });

  test('the missing token is reported first, together with the other issues', () => {
    const error = captureError(() => loadSettings({ [envName('home')]: 'a/b', [envName('debug_acp')]: 'yes' }));
    assert.deepEqual(
      error.issues.map((issue) => issue.variable),
      [envName('api_key'), envName('home'), envName('debug_acp')],
    );
  });
});

describe('proxy environment', () => {
  test('the six proxy variables are recognised', () => {
    assert.deepEqual(
      [...PROXY_VARIABLES],
      ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'],
    );
  });

  test('nothing is reported when no proxy variable is set', () => {
    assert.deepEqual(readProxyEnvironment({ PATH: '/usr/bin', ALL_PROXY: 'socks5://proxy.example:1080' }), {});
  });

  test('set variables are reported with their values unchanged', () => {
    const env = {
      HTTP_PROXY: 'http://user:pass@proxy.example:3128',
      HTTPS_PROXY: 'http://proxy.example:3129',
      NO_PROXY: 'localhost,127.0.0.1,.internal.example',
      http_proxy: 'http://lower.example:8080',
      https_proxy: 'http://lower.example:8443',
      no_proxy: '*',
      FTP_PROXY: 'ftp://proxy.example:21',
      KIRO_SIDECAR_API_KEY: 'sk-test-0123456789',
    };
    assert.deepEqual(readProxyEnvironment(env), {
      HTTP_PROXY: 'http://user:pass@proxy.example:3128',
      HTTPS_PROXY: 'http://proxy.example:3129',
      NO_PROXY: 'localhost,127.0.0.1,.internal.example',
      http_proxy: 'http://lower.example:8080',
      https_proxy: 'http://lower.example:8443',
      no_proxy: '*',
    });
  });

  test('only the variables that are set are reported', () => {
    assert.deepEqual(readProxyEnvironment({ https_proxy: 'http://proxy.example:3128' }), {
      https_proxy: 'http://proxy.example:3128',
    });
  });

  test('a variable set to an empty value counts as set', () => {
    assert.deepEqual(readProxyEnvironment({ NO_PROXY: '' }), { NO_PROXY: '' });
  });
});

describe('proxy settings', () => {
  test('empty settings set no variable', () => {
    assert.deepEqual(proxySettingsEnvironment({ proxy: '', no_proxy: '' }), {});
  });

  test('proxy sets the four URL variables', () => {
    assert.deepEqual(proxySettingsEnvironment({ proxy: 'http://proxy.example:3128', no_proxy: '' }), {
      HTTP_PROXY: 'http://proxy.example:3128',
      HTTPS_PROXY: 'http://proxy.example:3128',
      http_proxy: 'http://proxy.example:3128',
      https_proxy: 'http://proxy.example:3128',
    });
  });

  test('no_proxy sets both no-proxy variables', () => {
    assert.deepEqual(proxySettingsEnvironment({ proxy: '', no_proxy: 'localhost,.internal.example' }), {
      NO_PROXY: 'localhost,.internal.example',
      no_proxy: 'localhost,.internal.example',
    });
  });

  const loopback = [
    'http://127.0.0.1:10817',
    'http://127.1.2.3:3128',
    'http://localhost:3128',
    'http://LOCALHOST:3128',
    'http://proxy.localhost:3128',
    'http://[::1]:3128',
    'http://user:pass@127.0.0.1:3128',
    'socks5://127.0.0.1:1080',
    '127.0.0.1:10817',
    'localhost:3128',
  ];
  for (const proxy of loopback) {
    test(`${proxy} is a loopback proxy`, () => {
      assert.equal(isLoopbackProxy(proxy), true);
    });
  }

  const notLoopback = [
    '',
    'http://host.docker.internal:10817',
    'http://proxy.example:3128',
    'http://10.0.0.1:3128',
    'http://128.0.0.1:3128',
    'http://localhost.example:3128',
    'not a url',
  ];
  for (const proxy of notLoopback) {
    test(`${JSON.stringify(proxy)} is not a loopback proxy`, () => {
      assert.equal(isLoopbackProxy(proxy), false);
    });
  }
});
