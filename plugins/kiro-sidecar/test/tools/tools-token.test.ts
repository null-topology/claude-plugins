import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PROCESS_TIMEOUT } from '../session/manager-helpers.ts';
import { assertError, harness } from './harness.ts';
import type { Harness } from './harness.ts';
import type { Environment } from '../../src/settings.ts';

const MISSING_TOKEN =
  'Invalid plugin settings:\n- The Kiro token is not set: KIRO_SIDECAR_API_KEY (the setting api_key) is unset or empty. ' +
  'Set api_key with "/plugin configure kiro-sidecar@<marketplace>" in Claude Code, or with ' +
  '"claude plugin configure kiro-sidecar@<marketplace> --values-stdin", then restart Claude Code ' +
  '(<marketplace> as in the plugin id that "claude plugin list" shows).';
const WITHOUT_PATH =
  `${MISSING_TOKEN} For a server registered by hand, set KIRO_SIDECAR_API_KEY in the "env" of the entry that starts ` +
  'this server in its MCP config.';
const PATH_WARNING =
  'Do not write the token into that file: a plugin update replaces it and it would hold the token in plain text; ' +
  'use "/plugin configure" instead.';

function withPath(path: string): string {
  return (
    `${MISSING_TOKEN} For a server registered by hand, set KIRO_SIDECAR_API_KEY in the "env" of its entry in the MCP ` +
    `config. This server's MCP config: ${path} ${PATH_WARNING}`
  );
}

const SERVER_KEY = 'server_inherited_key_0123456789';

/** Each of the eight tools with arguments its own validation accepts. */
function calls(h: Harness): ReadonlyArray<readonly [string, Record<string, unknown>]> {
  return [
    ['start', { dir: h.workspace.dir, mode: 'local', prompt: 'hello' }],
    ['start', { dir: h.workspace.dir, mode: 'docker' }],
    ['resume', { session: 'ks_000000000000' }],
    ['send', { session: 'ks_000000000000', text: 'hello' }],
    ['wait', { session: 'ks_000000000000', timeout_s: 1 }],
    ['status', {}],
    ['cancel', { session: 'ks_000000000000' }],
    ['stop', { session: 'ks_000000000000' }],
    ['list', {}],
  ];
}

async function assertEveryToolRefuses(h: Harness, expected: string): Promise<void> {
  const called = new Set<string>();
  for (const [name, args] of calls(h)) {
    const message = assertError(await h.call(name, args), 'E_INVALID');
    assert.equal(message, expected, name);
    called.add(name);
  }
  assert.deepEqual([...called].sort(), ['cancel', 'list', 'resume', 'send', 'start', 'status', 'stop', 'wait']);
  const runs = await readdir(join(h.stateDir, 'runs')).catch(() => []);
  assert.deepEqual(runs, [], 'no run was created');
  await assert.rejects(h.workspace.started(), 'Kiro was never started');
  assert.equal((await h.workspace.received()).length, 0, 'Kiro received nothing');
}

describe('tools over MCP: the Kiro token', () => {
  const cases: ReadonlyArray<readonly [string, Environment]> = [
    ['unset', { KIRO_SIDECAR_API_KEY: undefined }],
    ['empty', { KIRO_SIDECAR_API_KEY: '' }],
    ['unset, with only the server KIRO_API_KEY', { KIRO_SIDECAR_API_KEY: undefined, KIRO_API_KEY: SERVER_KEY }],
  ];
  for (const [name, env] of cases) {
    test(`${name}: every tool answers E_INVALID saying how to set it, with no config path`, PROCESS_TIMEOUT, async (t) => {
      const h = await harness(t, 'default', { env });
      await assertEveryToolRefuses(h, WITHOUT_PATH);
      t.diagnostic(`refusal: E_INVALID ${WITHOUT_PATH}`);
    });
  }

  for (const [name, env] of cases.slice(0, 2)) {
    test(`${name}, under CLAUDE_PLUGIN_ROOT: every tool names the absolute .mcp.json path and warns against writing the token into it`, PROCESS_TIMEOUT, async (t) => {
      const root = '/opt/claude/plugins/kiro-sidecar';
      const h = await harness(t, 'default', { env: { ...env, CLAUDE_PLUGIN_ROOT: root } });
      await assertEveryToolRefuses(h, withPath(`${root}/.mcp.json`));
      t.diagnostic(`refusal: E_INVALID ${withPath(`${root}/.mcp.json`)}`);
    });
  }

  test('the server KIRO_API_KEY stays redacted in the refusal', PROCESS_TIMEOUT, async (t) => {
    const h = await harness(t, 'default', {
      env: { KIRO_SIDECAR_API_KEY: '', KIRO_API_KEY: SERVER_KEY, CLAUDE_PLUGIN_ROOT: `/opt/${SERVER_KEY}/kiro-sidecar` },
    });
    await assertEveryToolRefuses(h, withPath('/opt/[REDACTED]/kiro-sidecar/.mcp.json'));
  });

  test('a set token lets the tools run', PROCESS_TIMEOUT, async (t) => {
    const h = await harness(t, 'default', { env: { KIRO_API_KEY: SERVER_KEY } });
    const listed = await h.call('list', {});
    assert.equal(listed.isError, false, listed.text);
  });
});
