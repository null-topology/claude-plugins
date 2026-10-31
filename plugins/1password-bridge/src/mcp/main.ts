/**
 * Entry of `dist/server.js`, the MCP server `op` that Claude Code starts once
 * per session (.mcp.json). It wires the state directory, the `accounts`
 * option, the op CLI and the broker into the tools (tools.ts) and serves them
 * on stdio. Stdout carries the MCP protocol only.
 */

import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveStateDir } from '../paths.ts';
import { listOpAccounts } from './accounts.ts';
import { startBroker } from './broker-client.ts';
import { createMcpServer } from './tools.ts';

const env = process.env;
const stateDir = resolveStateDir(env);
// The bundle lives in <plugin root>/dist/.
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));

const server = createMcpServer({
  stateDir,
  accountsSetting: env['OP_BRIDGE_ACCOUNTS'],
  listOpAccounts: () => listOpAccounts(env),
  broker: { stateDir, spawnBroker: () => startBroker(pluginRoot, stateDir, env) },
});

// Claude Code closes stdin when it ends the session; the broker lives on.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));

await server.connect(new StdioServerTransport());
