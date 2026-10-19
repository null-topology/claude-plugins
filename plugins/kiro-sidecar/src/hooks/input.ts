/**
 * The hook input: JSON on stdin, read with a size cap, then the fields of a
 * PostToolUse event the waiter uses.
 *
 * For an MCP tool `tool_response` is an array of content blocks
 * (`[{type: "text", text}]`); the text of the last `text` block is the reply.
 * A plain string is accepted as the reply too. A subagent's call carries the
 * parent's `session_id` plus `agent_id` and `agent_type`.
 */

import type { Readable } from 'node:stream';

/** The most bytes of hook input read; more is refused, not truncated. */
export const HOOK_INPUT_MAX_BYTES = 8 * 1024 * 1024;

/** Session and agent ids: they go into state files and log lines as they are. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Agent types such as `general-purpose` or `plugin-name:agent-name`. */
const AGENT_TYPE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type InputSkipReason = 'input-too-large' | 'input-unreadable' | 'input-not-json' | 'input-invalid';

export type InputRead =
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly kind: 'skip'; readonly reason: InputSkipReason; readonly error?: unknown };

/**
 * Reads `stream` to its end and parses it as JSON. Past `maxBytes` it stops
 * reading at once, destroys the stream and skips; it never throws.
 */
export async function readHookInput(
  stream: Readable,
  maxBytes: number = HOOK_INPUT_MAX_BYTES,
): Promise<InputRead> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buffer.length;
      if (size > maxBytes) {
        // Leaving the loop early destroys the stream.
        return { kind: 'skip', reason: 'input-too-large' };
      }
      chunks.push(buffer);
    }
  } catch (error) {
    return { kind: 'skip', reason: 'input-unreadable', error };
  }
  try {
    return { kind: 'json', value: JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown };
  } catch {
    return { kind: 'skip', reason: 'input-not-json' };
  }
}

export interface PostToolUseInput {
  readonly sessionId: string;
  readonly toolName: string | null;
  /** As given; checked by whoever builds a path from it. */
  readonly toolUseId: string | null;
  readonly agentId: string | null;
  readonly agentType: string | null;
  /** True when an `agent_type` was given but dropped for not matching its pattern. */
  readonly agentTypeDropped: boolean;
  /** The reply text of the tool, or null when the response holds none. */
  readonly responseText: string | null;
}

export type ParsedInput =
  | { readonly kind: 'input'; readonly input: PostToolUseInput }
  | { readonly kind: 'skip'; readonly reason: 'input-invalid' };

/** The text of a tool response: a string as is, or the text of the last `text` block. */
export function responseText(toolResponse: unknown): string | null {
  if (typeof toolResponse === 'string') {
    return toolResponse;
  }
  if (!Array.isArray(toolResponse)) {
    return null;
  }
  for (let index = toolResponse.length - 1; index >= 0; index -= 1) {
    const block: unknown = toolResponse[index];
    if (typeof block === 'object' && block !== null) {
      const { type, text } = block as Record<string, unknown>;
      if (type === 'text' && typeof text === 'string') {
        return text;
      }
    }
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * The fields of a parsed PostToolUse input. Skips unless it is an object with
 * a `session_id` matching the id pattern; an `agent_id` or `agent_type` that
 * does not match its pattern is dropped.
 */
export function parsePostToolUseInput(value: unknown): ParsedInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'skip', reason: 'input-invalid' };
  }
  const record = value as Record<string, unknown>;
  const sessionId = record.session_id;
  if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
    return { kind: 'skip', reason: 'input-invalid' };
  }
  const agentId = stringOrNull(record.agent_id);
  const agentType = stringOrNull(record.agent_type);
  const agentTypeValid = agentType !== null && AGENT_TYPE_PATTERN.test(agentType);
  return {
    kind: 'input',
    input: {
      sessionId,
      toolName: stringOrNull(record.tool_name),
      toolUseId: stringOrNull(record.tool_use_id),
      agentId: agentId !== null && ID_PATTERN.test(agentId) ? agentId : null,
      agentType: agentTypeValid ? agentType : null,
      agentTypeDropped: record.agent_type !== undefined && record.agent_type !== null && !agentTypeValid,
      responseText: responseText(record.tool_response),
    },
  };
}
