import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { VERSION } from '../src/version.ts';

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')) as T;
}

interface PackageJson {
  name: string;
  version: string;
  description: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface CommandHook {
  readonly type: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeout: number;
}

interface HooksFile {
  readonly hooks: Record<string, readonly { readonly matcher?: string; readonly hooks: readonly CommandHook[] }[]>;
}

const PACKAGE = readJson<PackageJson>('package.json');
const DIST = '${CLAUDE_PLUGIN_ROOT}/dist/';

describe('package', () => {
  test('package.json, the manifest and src/version.ts carry the same version', () => {
    const manifest = readJson<{ name: string; version: string }>('.claude-plugin/plugin.json');
    assert.equal(PACKAGE.name, '1password-bridge');
    assert.equal(manifest.name, '1password-bridge');
    assert.equal(manifest.version, PACKAGE.version);
    assert.equal(VERSION, PACKAGE.version);
  });

  test('every dependency is pinned to an exact version', () => {
    const all = { ...PACKAGE.dependencies, ...PACKAGE.devDependencies };
    assert.ok(Object.keys(all).length > 0);
    for (const [name, range] of Object.entries(all)) {
      assert.match(range, /^\d+\.\d+\.\d+$/, `${name} is not pinned exactly: ${range}`);
    }
  });

  test('the runtime dependencies are the 1Password SDK, the MCP SDK and zod', () => {
    assert.deepEqual(Object.keys(PACKAGE.dependencies).sort(), [
      '@1password/sdk',
      '@modelcontextprotocol/sdk',
      'zod',
    ]);
  });
});

describe('plugin files', () => {
  test('the MCP config starts the bundled server from dist/ and maps the user options', () => {
    const config = readJson<{ mcpServers: Record<string, { args: string[] }> }>('.mcp.json');
    assert.deepEqual(config, {
      mcpServers: {
        op: {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/dist/server.js'],
          env: {
            OP_BRIDGE_IDLE_MINUTES: '${user_config.idle_window_minutes}',
            OP_BRIDGE_ACCOUNTS: '${user_config.accounts}',
            OP_BRIDGE_LANGUAGE: '${user_config.language}',
          },
        },
      },
    });
    for (const server of Object.values(config.mcpServers)) {
      for (const arg of server.args) {
        assert.ok(arg.startsWith(DIST), `${arg} does not point into dist/`);
      }
    }
  });

  test('every hook runs the bundled hook from dist/ with a timeout', () => {
    const { hooks } = readJson<HooksFile>('hooks/hooks.json');
    assert.deepEqual(Object.keys(hooks), [
      'SessionStart',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'Stop',
      'SubagentStop',
      'SessionEnd',
    ]);
    for (const [event, groups] of Object.entries(hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          assert.equal(hook.type, 'command', event);
          assert.equal(hook.command, 'node', event);
          assert.deepEqual(hook.args, [`${DIST}hook.js`], event);
          assert.ok(hook.timeout > 0 && hook.timeout <= 15, `${event} timeout`);
        }
      }
    }
  });
});

describe('0.1.0 leftovers', () => {
  test('the grants store and variable naming are gone', () => {
    for (const path of ['src/store/grants.ts', 'src/naming.ts', 'test/store/grants.test.ts', 'test/naming.test.ts']) {
      assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, path);
    }
  });
});

describe('release 0.2.0', () => {
  test('the version is 0.2.0 everywhere, the marketplace entry included', () => {
    const manifest = readJson<{ version: string; description: string }>('.claude-plugin/plugin.json');
    const market = readJson<{ plugins: { name: string; version: string; description: string }[] }>('../../.claude-plugin/marketplace.json');
    const entry = market.plugins.find((p) => p.name === '1password-bridge');
    const lock = readJson<{ version: string; packages: Record<string, { version?: string }> }>('package-lock.json');
    assert.equal(VERSION, '0.2.0');
    assert.equal(PACKAGE.version, '0.2.0');
    assert.equal(manifest.version, '0.2.0');
    assert.equal(entry?.version, '0.2.0');
    assert.equal(lock.version, '0.2.0');
    assert.equal(lock.packages['']?.version, '0.2.0');
    for (const text of [manifest.description, PACKAGE.description, entry?.description ?? '']) {
      assert.match(text, /ticket/, text);
      assert.doesNotMatch(text, /environment variable/, text);
    }
  });

  test('the README describes tickets and nothing of 0.1.0', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const needle of ['issue_tickets', 'op-bridge redeem', '<masked ticket=', '[exit N]', 'release']) assert.ok(readme.includes(needle), needle);
    assert.doesNotMatch(readme, /<masked:|ONE_PASSWORD_|`get`|\$NAME/);
  });

  test('the README states the limits settled in the phase 3 review', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const needle of ['`trap … EXIT`', '`exec`', 'normally ends with', '`mask_kept`', 'until all of them are released', 'MCP tool', 'keys', '7 days and 1 hour', 'can still be issued']) {
      assert.ok(readme.includes(needle), needle);
    }
    assert.doesNotMatch(readme, /not seen for 7 days,|cannot be issued/);
  });
});
