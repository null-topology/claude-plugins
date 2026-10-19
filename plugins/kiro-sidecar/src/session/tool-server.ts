/**
 * The plugin's own tool server, `sidecar`: the file `sidecar-tools.js` that
 * every Kiro session the plugin opens is given as an MCP server.
 *
 * The file sits next to the server bundle. `start` checks it with the same
 * checks a mount source the plugin adds itself gets, in both modes, before
 * anything is spawned. In docker mode it is mounted read-only as
 * `/opt/kiro-sidecar/sidecar-tools.mjs` and run by the image's node; in local
 * mode it is run in place by the node that runs the plugin server, and the
 * plugin's `package.json` (`"type": "module"`) makes it an ES module there.
 * The server's environment gets an
 * empty `KIRO_API_KEY`, so the token Kiro inherited never reaches it.
 */
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@agentclientprotocol/sdk';
import type { McpServerStatus } from '../acp/client.ts';
import { resolveStateSource } from '../docker/launch.ts';
import { CONTAINER_TOOL_SERVER_FILE } from '../docker/mounts.ts';
import { SidecarError } from '../errors.ts';

/** The MCP server name Kiro is given and reports the status of. */
export const TOOL_SERVER_NAME = 'sidecar';

/** The tools the server lists; the step `tools` waits until Kiro lists both. */
export const TOOL_SERVER_TOOLS: readonly string[] = Object.freeze(['send_message', 'complete_task']);

/** The node the docker image provides. */
export const CONTAINER_NODE = '/usr/bin/node';

export const TOOL_SERVER_MISSING = "the plugin's tool server is missing; reinstall the plugin";

export const TOOL_SERVER_NOT_CONNECTED =
  "Kiro did not connect the plugin's tool server; an account policy that disables MCP servers is one cause";

/**
 * The cause of `E_STEP_TOOLS`: the hint, then the last status Kiro reported
 * for the server (`none` when it reported none), with the tools it listed
 * when that status is `connected`.
 */
export function toolServerNotConnected(last: McpServerStatus | undefined): string {
  const status =
    last === undefined
      ? 'none'
      : last.status === 'connected'
        ? `connected with tools ${last.tools.length === 0 ? '(none)' : last.tools.join(', ')}`
        : last.status;
  return `${TOOL_SERVER_NOT_CONNECTED}; last status of server ${TOOL_SERVER_NAME}: ${status}`;
}

/**
 * The tool server file next to the bundle this module is built into
 * (`dist/server.js`). Run from source it names a file that does not exist,
 * so tests from source pass the path in.
 */
export function bundledToolServerFile(): string {
  return fileURLToPath(new URL('./sidecar-tools.js', import.meta.url));
}

/**
 * Checks the tool server file: a regular file whose path passes the checks
 * of a mount source the plugin adds itself. Resolves with its real path;
 * anything else is `E_INTERNAL`, since only a broken install gets here.
 */
export async function checkToolServerFile(path: string): Promise<string> {
  try {
    return await resolveStateSource('tool server', path, 'file');
  } catch {
    throw new SidecarError('E_INTERNAL', TOOL_SERVER_MISSING);
  }
}

/**
 * The `mcpServers` of `session/new` and `session/load`: the tool server
 * alone. `file` is the checked host path; docker runs the mounted copy.
 */
export function toolServerConfig(mode: 'docker' | 'local', file: string): McpServer[] {
  const docker = mode === 'docker';
  return [
    {
      name: TOOL_SERVER_NAME,
      command: docker ? CONTAINER_NODE : process.execPath,
      args: [docker ? CONTAINER_TOOL_SERVER_FILE : file],
      env: [{ name: 'KIRO_API_KEY', value: '' }],
    },
  ];
}
