/**
 * A3.3: when Kiro's `_kiro/mcp/status` names the plugin's tool server among
 * the servers organization MCP settings filtered out
 * (`accessModeFilteredServers`, a list of server names in Kiro CLI 3.2.0),
 * the step `tools` fails at once and says so instead of timing out.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SidecarError } from '../../src/errors.ts';
import { TOOL_SERVER_NOT_CONNECTED, TOOL_SERVER_TOOLS, toolServerFiltered } from '../../src/session/tool-server.ts';
import { PROCESS_TIMEOUT, managerFixture } from './manager-helpers.ts';

const TOOLS = TOOL_SERVER_TOOLS.map((name) => ({ name }));

describe('SessionManager.start: a filtered tool server (A3)', () => {
  test('E_STEP_TOOLS names the organization MCP settings, without waiting out the step', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default', { startLimits: { toolsMs: 8_000 } });
    await writeFile(join(fixture.workspace.dir, 'fake-mcp-status'), 'script');
    await writeFile(
      join(fixture.workspace.dir, 'fake-mcp-script.json'),
      JSON.stringify([
        { sessionId: '$SESSION', servers: [{ name: 'sidecar', status: 'connecting' }] },
        { sessionId: '$SESSION', servers: [], accessMode: 'registry', accessModeFilteredServers: ['sidecar'] },
      ]),
    );
    const began = performance.now();
    await assert.rejects(fixture.manager.start({ dir: fixture.workspace.dir }), (error: unknown) => {
      assert.ok(error instanceof SidecarError, String(error));
      assert.equal(error.code, 'E_STEP_TOOLS');
      assert.ok(error.message.startsWith(`start step tools failed: ${toolServerFiltered('registry')}`), error.message);
      assert.match(error.message, /organization MCP settings filtered out the plugin's tool server/);
      assert.equal(error.message.includes(TOOL_SERVER_NOT_CONNECTED), false, error.message);
      return true;
    });
    assert.ok(performance.now() - began < 5_000, 'the step did not wait for its cap');
  });

  test('a filter that names other servers only leaves the step alone', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    await writeFile(join(fixture.workspace.dir, 'fake-mcp-status'), 'script');
    await writeFile(
      join(fixture.workspace.dir, 'fake-mcp-script.json'),
      JSON.stringify([
        {
          sessionId: '$SESSION',
          servers: [{ name: 'sidecar', status: 'connected', tools: TOOLS }],
          accessMode: 'registry',
          accessModeFilteredServers: ['github'],
        },
      ]),
    );
    const result = await fixture.manager.start({ dir: fixture.workspace.dir });
    assert.equal(fixture.manager.get(result.launchId)?.state, 'idle');
  });
});
