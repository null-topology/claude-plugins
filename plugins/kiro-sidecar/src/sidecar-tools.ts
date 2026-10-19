/**
 * The plugin's own MCP tool server for Kiro, server name `sidecar`, on stdio.
 *
 * It offers `send_message` and `complete_task`. It delivers nothing itself:
 * the plugin reads the calls in the ACP stream. So the server keeps no state,
 * writes no file, opens no socket and reads nothing but its stdin; its only
 * imports are the MCP SDK's server and stdio transport, zod, the version
 * constant and the kept-length bounds it shares with the plugin.
 *
 * Any string is accepted, of any length: a refused call is not retried. A text
 * longer than what the plugin keeps of it makes the reply say so; the server
 * cuts nothing. A missing or non-string argument fails the input schema, and
 * the SDK answers that call with an error result. An extra argument is
 * ignored rather than refused, for the same reason: refusing it would lose
 * the message.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MESSAGE_KEPT_CHARS, RESULT_KEPT_CHARS } from './text/limits.ts';
import { SERVER_VERSION } from './version.ts';

/** The name Kiro lists the tools under (`@sidecar/<tool>`). */
const SIDECAR_SERVER_NAME = 'sidecar';

/** The stdin end exits once pending replies are written, or after this long at most. */
const STDIN_END_EXIT_DEADLINE_MS = 500;

const SEND_MESSAGE_DESCRIPTION =
  'Send a message to the Claude session that controls you: to report something or to ask a question. ' +
  'It is delivered when your turn ends. To ask, call it and then end your turn; the answer arrives as ' +
  'your next prompt. Do not call it after complete_task.';
const SEND_MESSAGE_REPLY =
  'Recorded; it is delivered when your turn ends. If you asked a question, end your turn now; otherwise go on.';

const COMPLETE_TASK_DESCRIPTION =
  'Declare the whole task finished and hand over its result. Call it once, at the very end, then end ' +
  'your turn. The session ends after this turn. Keep the result short; put a long report in a file and ' +
  'name the file.';
const COMPLETE_TASK_REPLY = 'Recorded. End your turn now.';

/** The reply, with a note when the plugin will keep only the start of `text`. */
function reply(base: string, text: string, keptChars: number): CallToolResult {
  const note =
    text.length > keptChars ? ` Only the first ${keptChars} characters are kept; put the rest in a file.` : '';
  return { content: [{ type: 'text', text: `${base}${note}` }] };
}

const server = new McpServer({ name: SIDECAR_SERVER_NAME, version: SERVER_VERSION });

server.registerTool(
  'send_message',
  { description: SEND_MESSAGE_DESCRIPTION, inputSchema: z.object({ text: z.string() }) },
  ({ text }) => reply(SEND_MESSAGE_REPLY, text, MESSAGE_KEPT_CHARS),
);

server.registerTool(
  'complete_task',
  { description: COMPLETE_TASK_DESCRIPTION, inputSchema: z.object({ result: z.string() }) },
  ({ result }) => reply(COMPLETE_TASK_REPLY, result, RESULT_KEPT_CHARS),
);

// A signal exits at once: Kiro ends its `server/discover` probe with SIGTERM.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => process.exit(0));
}

// The end of stdin lets replies still in flight be written; nothing else
// keeps the process alive, and the deadline covers anything that would.
let stdinEnded = false;
function onStdinEnd(): void {
  if (stdinEnded) {
    return;
  }
  stdinEnded = true;
  setTimeout(() => process.exit(0), STDIN_END_EXIT_DEADLINE_MS).unref();
}
process.stdin.on('end', onStdinEnd);
process.stdin.on('close', onStdinEnd);

await server.connect(new StdioServerTransport());
