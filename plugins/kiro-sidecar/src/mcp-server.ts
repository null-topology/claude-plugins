/**
 * The MCP server: lists the eight tools and runs their calls.
 *
 * The low-level `Server` is used instead of `McpServer` because `McpServer`
 * answers a call whose arguments fail the input schema with its own text;
 * here every argument problem is reported as `E_INVALID <field> ...`.
 *
 * A tool reply is text. An error is an MCP result with `isError: true` and
 * the text `<code> <message>`; anything that is not a `SidecarError` is
 * `E_INTERNAL` with a one-line message, and its stack goes to stderr. Every
 * reply and every diagnostic line is redacted with the server's secrets, and
 * marker-like lines in an error message are neutralised.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { SidecarError } from './errors.ts';
import { describeError } from './session/outcome.ts';
import { isValidToolUseId } from './store/paths.ts';
import { neutraliseKiroText } from './text/neutralise.ts';
import { inputJsonSchema } from './tools/args.ts';
import { Runtime } from './tools/runtime.ts';
import type { RuntimeOptions } from './tools/runtime.ts';
import { TOOLS } from './tools/tools.ts';
import type { ToolCall, ToolDefinition } from './tools/tools.ts';
import { SERVER_NAME, SERVER_VERSION } from './version.ts';

export { SERVER_NAME, SERVER_VERSION };

/** The `_meta` key that carries Claude Code's tool use id. */
export const TOOL_USE_ID_META = 'claudecode/toolUseId';

export interface KiroServer {
  readonly server: Server;
  readonly runtime: Runtime;
}

const LINE_BREAKS = /\s*(?:\r\n|\r|\n|\u{2028}|\u{2029})\s*/gu;

/**
 * Builds the MCP server. Construction does no I/O, so the server can answer
 * the handshake and `tools/list` as soon as a transport is connected. The
 * startup sweep starts once the client reports the handshake complete
 * (`notifications/initialized`) and runs beside the calls; it never throws.
 */
export function createServer(options: RuntimeOptions = {}): KiroServer {
  const runtime = new Runtime(options);
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  server.oninitialized = () => {
    void runtime.sweep();
  };
  const tools = new Map(TOOLS.map((tool) => [tool.name, tool]));
  const listed: Tool[] = TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: inputJsonSchema(tool.schema),
    ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
  }));

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const tool = tools.get(request.params.name);
    if (tool === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${JSON.stringify(request.params.name)}`);
    }
    const meta = request.params._meta;
    const toolUseId = meta?.[TOOL_USE_ID_META];
    const progressToken = meta?.progressToken;
    const call: ToolCall = {
      args: request.params.arguments,
      toolUseId: typeof toolUseId === 'string' && isValidToolUseId(toolUseId) ? toolUseId : undefined,
      signal: extra.signal,
      progress:
        progressToken === undefined
          ? undefined
          : (progress, message) =>
              extra.sendNotification({
                method: 'notifications/progress',
                params: { progressToken, progress, message },
              }),
    };
    return runTool(runtime, tool, call);
  });

  return { server, runtime };
}

async function runTool(runtime: Runtime, tool: ToolDefinition, call: ToolCall): Promise<CallToolResult> {
  try {
    const text = await tool.run(runtime, call);
    return { content: [{ type: 'text', text: runtime.secrets.redact(text) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: errorText(runtime, tool.name, error) }], isError: true };
  }
}

/** `<code> <message>`, redacted, with marker-like lines neutralised. */
export function errorText(runtime: Runtime, toolName: string, error: unknown): string {
  let code: string;
  let message: string;
  if (error instanceof SidecarError) {
    code = error.code;
    message = error.message;
  } else {
    code = 'E_INTERNAL';
    message = describeError(error).replace(LINE_BREAKS, ' ').trim();
    const stack = error instanceof Error && error.stack !== undefined ? error.stack : message;
    runtime.log(`${toolName} failed: ${stack}`);
  }
  return `${code} ${neutraliseKiroText(runtime.secrets.redact(message))}`;
}
