import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SERVER_NAME, SERVER_VERSION } from '../src/mcp-server.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')) as T;
}

interface PackageJson {
  name: string;
  version: string;
  engines: { node: string };
  devEngines?: { runtime?: { name?: string; version?: string } };
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface LsNode {
  version?: string;
  dependencies?: Record<string, LsNode>;
}

function collectVersions(node: LsNode, name: string, found: Set<string>): Set<string> {
  for (const [dependency, child] of Object.entries(node.dependencies ?? {})) {
    if (dependency === name && child.version !== undefined) {
      found.add(child.version);
    }
    collectVersions(child, name, found);
  }
  return found;
}

const PACKAGE = readJson<PackageJson>('package.json');

describe('package', () => {
  test('the bundle runs on Node 22, and development asks for a Node that runs .ts files', () => {
    assert.equal(PACKAGE.engines.node, '>=22');
    // The tests run .ts files directly, which needs type stripping (Node 22.18.0 and later).
    assert.deepEqual(PACKAGE.devEngines, { runtime: { name: 'node', version: '>=22.18.0' } });
  });

  test('every dependency is pinned to an exact version', () => {
    const all = { ...PACKAGE.dependencies, ...PACKAGE.devDependencies };
    for (const [name, range] of Object.entries(all)) {
      assert.match(range, /^\d+\.\d+\.\d+$/, `${name} is not pinned exactly: ${range}`);
    }
  });

  test('npm ls shows exactly one zod version', () => {
    const output = execFileSync('npm', ['ls', 'zod', '--all', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const versions = collectVersions(JSON.parse(output) as LsNode, 'zod', new Set());
    assert.deepEqual([...versions], [PACKAGE.dependencies.zod]);
  });

  test('the lockfile installs zod in a single place', () => {
    const lock = readJson<{ packages: Record<string, unknown> }>('package-lock.json');
    const zodPaths = Object.keys(lock.packages).filter(
      (path) => path === 'node_modules/zod' || path.endsWith('/node_modules/zod'),
    );
    assert.deepEqual(zodPaths, ['node_modules/zod']);
  });
});

describe('plugin files', () => {
  test('the manifest names the plugin and matches the package version', () => {
    const manifest = readJson<Record<string, unknown>>('.claude-plugin/plugin.json');
    assert.equal(manifest.name, 'kiro-sidecar');
    assert.equal(manifest.version, PACKAGE.version);
    assert.equal(typeof manifest.description, 'string');
    assert.ok(!String(manifest.description).includes('\n'));
    assert.deepEqual(manifest.author, { name: 'null-topology' });
    assert.equal(manifest.license, 'MIT');
  });

  test('the manifest declares the Kiro token as a sensitive, optional api_key', () => {
    const manifest = readJson<{ userConfig: Record<string, Record<string, unknown>> }>('.claude-plugin/plugin.json');
    assert.deepEqual(Object.keys(manifest.userConfig), ['api_key', 'proxy', 'no_proxy']);
    const option = manifest.userConfig['api_key'];
    assert.ok(option !== undefined);
    assert.equal(option.type, 'string');
    assert.equal(option.sensitive, true);
    assert.ok(!('required' in option), 'api_key is not required');
    assert.ok(!('default' in option), 'api_key has no default');
    assert.equal(typeof option.title, 'string');
    assert.match(String(option.description), /Kiro API token/);
  });

  test('the manifest declares proxy as sensitive and no_proxy as plain, both optional', () => {
    const manifest = readJson<{ userConfig: Record<string, Record<string, unknown>> }>('.claude-plugin/plugin.json');
    for (const [key, sensitive] of [['proxy', true], ['no_proxy', undefined]] as const) {
      const option = manifest.userConfig[key];
      assert.ok(option !== undefined, key);
      assert.equal(option.type, 'string', key);
      assert.equal(option.sensitive, sensitive, key);
      assert.ok(!('required' in option), `${key} is not required`);
      assert.ok(!('default' in option), `${key} has no default`);
      assert.match(String(option.description), /^Optional\./, key);
    }
  });

  test('the MCP config starts the bundled server with node and maps the user options', () => {
    assert.deepEqual(readJson('.mcp.json'), {
      mcpServers: {
        kiro: {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/dist/server.js'],
          env: {
            KIRO_SIDECAR_API_KEY: '${user_config.api_key}',
            KIRO_SIDECAR_PROXY: '${user_config.proxy}',
            KIRO_SIDECAR_NO_PROXY: '${user_config.no_proxy}',
          },
        },
      },
    });
  });

  test('the server reports the package version under its config name', () => {
    assert.equal(SERVER_NAME, 'kiro');
    assert.equal(SERVER_VERSION, PACKAGE.version);
  });
});
