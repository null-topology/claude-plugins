import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SidecarError } from '../../src/errors.ts';
import {
  TOOL_SERVER_MISSING,
  TOOL_SERVER_NOT_CONNECTED,
  TOOL_SERVER_TOOLS,
  bundledToolServerFile,
  checkToolServerFile,
  toolServerConfig,
  toolServerNotConnected,
} from '../../src/session/tool-server.ts';
import { removeTree } from '../helpers/processes.ts';

const TOOL_SERVER_SOURCE = fileURLToPath(new URL('../../src/sidecar-tools.ts', import.meta.url));

async function tempBase(t: TestContext): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'kiro-sidecar-tool-server-')));
  t.after(() => removeTree(base));
  return base;
}

describe('tool server', () => {
  test('mcpServers: docker runs the mounted copy with the image node, local runs the file with this node', () => {
    const env = [{ name: 'KIRO_API_KEY', value: '' }];
    // In the container no package.json sits beside the file, so the `.mjs`
    // name is what makes the image's node load it as an ES module.
    assert.deepEqual(toolServerConfig('docker', '/plugin/dist/sidecar-tools.js'), [
      { name: 'sidecar', command: '/usr/bin/node', args: ['/opt/kiro-sidecar/sidecar-tools.mjs'], env },
    ]);
    assert.deepEqual(toolServerConfig('local', '/plugin/dist/sidecar-tools.js'), [
      { name: 'sidecar', command: process.execPath, args: ['/plugin/dist/sidecar-tools.js'], env },
    ]);
  });

  test('the bundled file is found next to the module that asks, which is dist/server.js once built', () => {
    // From source the module is src/session/tool-server.ts, so the file named is beside it.
    assert.equal(bundledToolServerFile(), fileURLToPath(new URL('../../src/session/sidecar-tools.js', import.meta.url)));
  });

  test('a regular file passes and resolves to its real path', async (t) => {
    const base = await tempBase(t);
    const file = join(base, 'sidecar-tools.js');
    await writeFile(file, '');
    await symlink(file, join(base, 'link.js'));
    assert.equal(await checkToolServerFile(file), file);
    assert.equal(await checkToolServerFile(join(base, 'link.js')), file);
  });

  test('missing, a directory, a dangling link or an unmountable path is E_INTERNAL', async (t) => {
    const base = await tempBase(t);
    await mkdir(join(base, 'dir.js'));
    await symlink(join(base, 'nowhere.js'), join(base, 'dangling.js'));
    await writeFile(join(base, 'a,b.js'), '');
    for (const path of ['missing.js', 'dir.js', 'dangling.js', 'a,b.js'].map((name) => join(base, name))) {
      await assert.rejects(checkToolServerFile(path), (error) => {
        assert.ok(error instanceof SidecarError, `unexpected ${String(error)}`);
        assert.equal(error.code, 'E_INTERNAL', path);
        assert.equal(error.message, TOOL_SERVER_MISSING);
        return true;
      });
    }
  });

  test('the E_STEP_TOOLS cause names the last status, and the tools of a connected one', () => {
    const named = (status: string): string => `${TOOL_SERVER_NOT_CONNECTED}; last status of server sidecar: ${status}`;
    assert.equal(toolServerNotConnected(undefined), named('none'));
    assert.equal(toolServerNotConnected({ name: 'sidecar', status: 'failed', tools: [] }), named('failed'));
    assert.equal(toolServerNotConnected({ name: 'sidecar', status: 'connected', tools: [] }), named('connected with tools (none)'));
    assert.equal(
      toolServerNotConnected({ name: 'sidecar', status: 'connected', tools: ['send_message'] }),
      named('connected with tools send_message'),
    );
  });

  test('the tools the step waits for are the ones the server source lists', { timeout: 15_000 }, async (t) => {
    // From source, not dist/: a tool renamed in src/sidecar-tools.ts fails
    // here before any rebuild. The fake agent reports TOOL_SERVER_TOOLS too.
    const transport = new StdioClientTransport({ command: process.execPath, args: [TOOL_SERVER_SOURCE], stderr: 'pipe' });
    const client = new Client({ name: 'kiro-sidecar-test', version: '0.0.0' });
    t.after(() => client.close());
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      TOOL_SERVER_TOOLS,
    );
  });
});
