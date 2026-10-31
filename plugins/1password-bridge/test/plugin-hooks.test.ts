/**
 * hooks/hooks.json against the code: the PreToolUse matchers are the patterns
 * the hook itself checks (Bash for the board, then the bridge tools), and the
 * bridge matcher covers exactly the tools whose input takes the session id the
 * hook injects; PostToolUse and PostToolUseFailure match Bash only. The tool
 * names assume Claude Code's `mcp__plugin_<plugin>_<server>__<tool>` scheme
 * for plugin MCP servers.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BASH_TOOL, BRIDGE_TOOL } from '../src/hooks/pre-tool-use.ts';
import { TOOL_LIST } from '../src/mcp/tools.ts';

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')) as T;
}

interface HooksFile {
  readonly hooks: Record<string, readonly { readonly matcher?: string }[]>;
}

const MANIFEST = readJson<{ name: string }>('.claude-plugin/plugin.json');
const SERVERS = Object.keys(readJson<{ mcpServers: Record<string, unknown> }>('.mcp.json').mcpServers);
const HOOKS = readJson<HooksFile>('hooks/hooks.json').hooks;

function matchers(event: string): string[] {
  return (HOOKS[event] ?? []).map((group) => group.matcher ?? '');
}

function onlyMatcher(event: string): string {
  const all = matchers(event);
  assert.equal(all.length, 1, event);
  return all[0] ?? '';
}

describe('plugin hooks', () => {
  test('the plugin has one MCP server, op', () => {
    assert.deepEqual(SERVERS, ['op']);
  });

  test('PreToolUse matches Bash, for the board, and the pattern the hook checks', () => {
    assert.deepEqual(matchers('PreToolUse'), [BASH_TOOL.source, BRIDGE_TOOL.source]);
  });

  test('the bridge matcher covers exactly the tools whose input takes the injected session id', () => {
    const matcher = new RegExp(BRIDGE_TOOL.source);
    const prefix = `mcp__plugin_${MANIFEST.name}_${SERVERS[0] ?? ''}__`;
    for (const tool of TOOL_LIST) {
      const takesSession = Object.hasOwn(tool.inputSchema.properties ?? {}, 'session_id');
      assert.equal(matcher.test(`${prefix}${tool.name}`), takesSession, tool.name);
    }
    assert.equal(matcher.test('mcp__plugin_other_op__issue_tickets'), false);
  });

  test('Stop and SubagentStop run for every agent', () => {
    assert.equal(onlyMatcher('Stop'), '');
    assert.equal(onlyMatcher('SubagentStop'), '');
  });

  test('PostToolUse and PostToolUseFailure see Bash only', () => {
    assert.equal(onlyMatcher('PostToolUse'), BASH_TOOL.source);
    assert.equal(onlyMatcher('PostToolUseFailure'), BASH_TOOL.source);
  });
});
