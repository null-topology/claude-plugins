/**
 * Kiro's calls of the plugin's own tools in one turn (4.11).
 *
 * A `tool_call` whose title is exactly `@sidecar/send_message` or
 * `@sidecar/complete_task` and whose `rawInput.tool_id` is exactly
 * `sidecar::<that tool>` is noted with its id and its arguments. A later
 * `tool_call_update` of that id with status `completed` records it. A failed
 * call, a call still open when the turn ends, a non-string `text` or `result`
 * and an update of an id never noted (Kiro's "Tool Load" frames) record
 * nothing. A recorded text is redacted, then cut keeping its start.
 *
 * Messages are kept in call order, the order of their `tool_call` frames,
 * whatever order the calls complete in; the bound keeps the latest calls.
 */

import { MESSAGE_KEPT_CHARS, MESSAGES_KEPT_TOTAL_CHARS, RESULT_KEPT_CHARS } from '../text/limits.ts';
import { MESSAGE_LINE_EXTRA_CHARS } from '../text/messages.ts';
import { cutKeepingStart } from '../text/preview.ts';
import type { SecretSet } from '../text/redact.ts';
import { isoSeconds } from './claims.ts';
import { TOOL_SERVER_NAME } from './tool-server.ts';
import type { Completion } from './types.ts';

/** The own tools, with the argument each call carries. */
const OWN_TOOLS = Object.freeze({ send_message: 'text', complete_task: 'result' } as const);

type OwnTool = keyof typeof OWN_TOOLS;

/** The title Kiro gives a call of `tool`, which is also its permission title. */
function ownToolTitle(tool: OwnTool): string {
  return `@${TOOL_SERVER_NAME}/${tool}`;
}

/** The own tool a title names exactly, if any. */
function ownToolOf(title: string | undefined): OwnTool | undefined {
  return (Object.keys(OWN_TOOLS) as OwnTool[]).find((tool) => title === ownToolTitle(tool));
}

/** The parts of a `session/request_permission` that tell whose tool it is for. */
export interface PermissionRequestIdentity {
  readonly toolCall: { readonly title?: string | null | undefined };
  readonly _meta?: unknown;
}

/**
 * Whether a permission request is for one of the plugin's own tools: its
 * title is exactly that tool's AND the host-resolved identity Kiro attaches,
 * `_meta.kiro.mcpTool.identity`, names server `sidecar` and that tool. Kiro
 * titles a `run_command` request with the command text, so a title alone is
 * never trusted (4.5).
 */
export function isOwnToolRequest(request: PermissionRequestIdentity): boolean {
  const tool = ownToolOf(request.toolCall.title ?? undefined);
  if (tool === undefined) {
    return false;
  }
  const kiro = isObject(request._meta) ? request._meta['kiro'] : undefined;
  const mcpTool = isObject(kiro) ? kiro['mcpTool'] : undefined;
  const identity = isObject(mcpTool) ? mcpTool['identity'] : undefined;
  return isObject(identity) && identity['serverName'] === TOOL_SERVER_NAME && identity['toolName'] === tool;
}

export interface SidecarCallsSummary {
  /** The kept messages, in call order. */
  readonly messages: readonly string[];
  /** Earlier messages not kept within the total bound. */
  readonly messagesDropped: number;
  readonly completion: Completion | null;
}

/**
 * What a `tool_call_update` did; `message` is a recorded message, kept or
 * counted as dropped, and `ignored` is a later `complete_task`.
 */
export type SidecarCallRecord = 'message' | 'completion' | 'ignored' | undefined;

interface KeptMessage {
  /** The position of its `tool_call` among the noted calls of the turn. */
  readonly order: number;
  readonly text: string;
  /**
   * What the message counts within the per-turn total: its line in the block,
   * the kept text with its cut marker plus `- ` and the line break (4.4), so
   * many tiny messages cannot grow the block past the bound.
   */
  readonly chars: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SidecarCalls {
  readonly #secrets: Pick<SecretSet, 'redact'>;
  readonly #now: () => Date;
  readonly #open = new Map<string, { readonly order: number; readonly tool: OwnTool; readonly value: unknown }>();
  /** The kept messages, sorted by call order. */
  readonly #messages: KeptMessage[] = [];
  #noted = 0;
  #messageChars = 0;
  #messagesDropped = 0;
  /** The call order of the latest dropped message; a message of an earlier call is dropped too. */
  #droppedThrough = 0;
  #completion: Completion | null = null;

  constructor(secrets: Pick<SecretSet, 'redact'>, now: () => Date = () => new Date()) {
    this.#secrets = secrets;
    this.#now = now;
  }

  /** Notes a `tool_call` when it is a call of an own tool; `update` is the raw session update. */
  call(toolCallId: string, title: string | undefined, update: unknown): void {
    const tool = ownToolOf(title);
    if (tool === undefined || !isObject(update) || !isObject(update['rawInput'])) {
      return;
    }
    const rawInput = update['rawInput'];
    if (rawInput['tool_id'] !== `${TOOL_SERVER_NAME}::${tool}`) {
      return;
    }
    const args = rawInput['arguments'];
    this.#noted += 1;
    this.#open.set(toolCallId, { order: this.#noted, tool, value: isObject(args) ? args[OWN_TOOLS[tool]] : undefined });
  }

  /** Records a noted call on its `completed` update and forgets it on a `failed` one. */
  update(toolCallId: string, status: string | undefined): SidecarCallRecord {
    const noted = this.#open.get(toolCallId);
    if (noted === undefined || (status !== 'completed' && status !== 'failed')) {
      return undefined;
    }
    this.#open.delete(toolCallId);
    if (status === 'failed' || typeof noted.value !== 'string') {
      return undefined;
    }
    const text = this.#secrets.redact(noted.value);
    if (noted.tool === 'complete_task') {
      if (this.#completion !== null) {
        return 'ignored';
      }
      this.#completion = { result: cutKeepingStart(text, RESULT_KEPT_CHARS), at: isoSeconds(this.#now()) };
      return 'completion';
    }
    const kept = cutKeepingStart(text, MESSAGE_KEPT_CHARS);
    this.#keep({ order: noted.order, text: kept, chars: kept.length + MESSAGE_LINE_EXTRA_CHARS });
    return 'message';
  }

  summary(): SidecarCallsSummary {
    return {
      messages: this.#messages.map((message) => message.text),
      messagesDropped: this.#messagesDropped,
      completion: this.#completion,
    };
  }

  /**
   * Places a message by its call order and drops the earliest ones until the
   * kept total fits. A message of a call earlier than a dropped one is dropped
   * at once, so what is kept is always the latest calls (4.4).
   */
  #keep(message: KeptMessage): void {
    if (message.order <= this.#droppedThrough) {
      this.#messagesDropped += 1;
      return;
    }
    let at = this.#messages.length;
    while (at > 0 && (this.#messages[at - 1]?.order ?? 0) > message.order) {
      at -= 1;
    }
    this.#messages.splice(at, 0, message);
    this.#messageChars += message.chars;
    while (this.#messageChars > MESSAGES_KEPT_TOTAL_CHARS) {
      const dropped = this.#messages.shift();
      this.#messageChars -= dropped?.chars ?? 0;
      this.#droppedThrough = dropped?.order ?? this.#droppedThrough;
      this.#messagesDropped += 1;
    }
  }
}
