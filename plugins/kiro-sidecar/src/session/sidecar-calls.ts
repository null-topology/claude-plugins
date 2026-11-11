/**
 * Kiro's calls of the plugin's own tools in one turn (4.11).
 *
 * A `tool_call` whose title is exactly `@sidecar/send_message` or
 * `@sidecar/complete_task` is noted with its id, in one of two forms:
 * - legacy (Kiro CLI 2.x): `rawInput.tool_id` is exactly `sidecar::<that
 *   tool>` and the value is `rawInput.arguments.text` or `.result`;
 * - current (Kiro CLI 3.x): any other `rawInput`; the value is `rawInput.text`
 *   or `.result`, taken from whichever frame of the call carries it (the
 *   `tool_call` or a later `tool_call_update`).
 *
 * A later `tool_call_update` of that id with status `completed` records it.
 * The title and the current form's `rawInput` come from the model's side for
 * some tool kinds, so a call in the current form is recorded only when a
 * permission request for the same id and the same tool was taken as the
 * plugin's own (`isOwnToolRequest`) before it completed (`prove`). One that
 * completes with a string value and no such proof is reported `unproven`
 * and records nothing. A failed call, a call still open when the turn ends, a
 * non-string `text` or `result` and an update of an id never noted (Kiro's
 * "Tool Load" frames) record nothing. A recorded text is redacted, then cut
 * keeping its start.
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

/** At most this many key names per list in an {@link OwnToolFrameShape}. */
export const FRAME_SHAPE_KEYS_KEPT = 16;
/** Each key name in an {@link OwnToolFrameShape} is cut to this many characters. */
export const FRAME_SHAPE_KEY_CHARS = 40;

/**
 * The shape of a `tool_call` frame titled as an own tool, for the ACP log:
 * key names only, never a value. `rawInputKeys` and `kiroMetaKeys` (the keys
 * of `_meta.kiro`) are present when that part is an object.
 */
export interface OwnToolFrameShape {
  readonly toolCallId: string;
  readonly tool: string;
  readonly rawInputKeys?: readonly string[];
  readonly kiroMetaKeys?: readonly string[];
}

/** What stands in an {@link OwnToolFrameShape} for a key name that is not an identifier. */
export const FRAME_SHAPE_OTHER_KEY = '?';

/** A key name written as it is: a field name, not text the model could place in a key. */
const FIELD_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The sorted key names of `value`, bounded in count and length; undefined
 * when it is not an object. The model chooses the keys of `rawInput`, so a
 * name that is not an identifier is not written.
 */
function keyNames(value: unknown): string[] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.keys(value)
    .sort()
    .slice(0, FRAME_SHAPE_KEYS_KEPT)
    .map((key) => (FIELD_NAME.test(key) ? key.slice(0, FRAME_SHAPE_KEY_CHARS) : FRAME_SHAPE_OTHER_KEY));
}

/**
 * The shape of a `tool_call` frame whose title is exactly an own tool's, or
 * undefined for any other title. `update` is the raw session update. It lets
 * the frame layout a Kiro version sends be seen in `acp.jsonl` without
 * logging what the call carries.
 */
export function ownToolFrameShape(toolCallId: string, title: string | undefined, update: unknown): OwnToolFrameShape | undefined {
  const tool = ownToolOf(title);
  if (tool === undefined) {
    return undefined;
  }
  const frame = typeof update === 'object' && update !== null ? (update as Record<string, unknown>) : {};
  const meta = frame['_meta'];
  const kiro = typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>)['kiro'] : undefined;
  const rawInputKeys = keyNames(frame['rawInput']);
  const kiroMetaKeys = keyNames(kiro);
  return {
    toolCallId,
    tool,
    ...(rawInputKeys === undefined ? {} : { rawInputKeys }),
    ...(kiroMetaKeys === undefined ? {} : { kiroMetaKeys }),
  };
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
  return checkOwnToolRequest(request).own;
}

/** The `_meta.kiro.mcpTool` envelope version this plugin reads; no `version` means this one. */
export const MCP_TOOL_ENVELOPE_VERSION = 1;

/**
 * How a permission request was judged. `unreadVersion` is set when the
 * title names an own tool but `_meta.kiro.mcpTool.version` is present and
 * not {@link MCP_TOOL_ENVELOPE_VERSION}: the identity is in a layout this
 * plugin does not know, so the request is not taken as its own and the
 * permission policy decides it. It holds the version when it is a number,
 * else its JSON type.
 */
export type OwnToolCheck =
  | { readonly own: true }
  | { readonly own: false; readonly unreadVersion?: number | string };

/** {@link isOwnToolRequest}, telling also when the envelope version was not one it reads. */
export function checkOwnToolRequest(request: PermissionRequestIdentity): OwnToolCheck {
  const tool = ownToolOf(request.toolCall.title ?? undefined);
  if (tool === undefined) {
    return { own: false };
  }
  const kiro = isObject(request._meta) ? request._meta['kiro'] : undefined;
  const mcpTool = isObject(kiro) ? kiro['mcpTool'] : undefined;
  if (isObject(mcpTool) && 'version' in mcpTool && mcpTool['version'] !== MCP_TOOL_ENVELOPE_VERSION) {
    const version = mcpTool['version'];
    return { own: false, unreadVersion: typeof version === 'number' ? version : version === null ? 'null' : typeof version };
  }
  const identity = isObject(mcpTool) ? mcpTool['identity'] : undefined;
  return { own: isObject(identity) && identity['serverName'] === TOOL_SERVER_NAME && identity['toolName'] === tool };
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
 * counted as dropped, `ignored` is a later `complete_task`, and `unproven` is
 * a call in the current form that completed with no permission proof, so it
 * was not recorded.
 */
export type SidecarCallRecord = 'message' | 'completion' | 'ignored' | 'unproven' | undefined;

/**
 * The most permission proofs a turn keeps for calls that have not ended; the
 * oldest is forgotten first. A proof is forgotten as soon as its call ends.
 */
export const OWN_TOOL_PROOFS_KEPT = 256;

/** A noted call: `legacy` is the Kiro CLI 2.x `{tool_id, arguments}` form, `current` the 3.x form. */
interface NotedCall {
  readonly order: number;
  readonly tool: OwnTool;
  readonly form: 'legacy' | 'current';
  value: unknown;
}

/** The value a current-form `rawInput` of `tool` carries, or undefined when it carries none. */
function currentFormValue(update: Record<string, unknown>, tool: OwnTool): string | undefined {
  const rawInput = update['rawInput'];
  const value = isObject(rawInput) ? rawInput[OWN_TOOLS[tool]] : undefined;
  return typeof value === 'string' ? value : undefined;
}

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
  readonly #open = new Map<string, NotedCall>();
  /** The own tool each permission request taken as the plugin's own was for, by tool call id (`prove`). */
  readonly #proofs = new Map<string, OwnTool>();
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
    if (tool === undefined || !isObject(update)) {
      return;
    }
    const rawInput = update['rawInput'];
    if (isObject(rawInput) && rawInput['tool_id'] === `${TOOL_SERVER_NAME}::${tool}`) {
      const args = rawInput['arguments'];
      this.#noted += 1;
      this.#open.set(toolCallId, {
        order: this.#noted,
        tool,
        form: 'legacy',
        value: isObject(args) ? args[OWN_TOOLS[tool]] : undefined,
      });
      return;
    }
    const known = this.#open.get(toolCallId);
    if (known !== undefined) {
      // A repeated frame of a noted call: a current-form one may bring the value.
      if (known.form === 'current' && known.tool === tool) {
        known.value = currentFormValue(update, tool) ?? known.value;
      }
      return;
    }
    this.#noted += 1;
    this.#open.set(toolCallId, { order: this.#noted, tool, form: 'current', value: currentFormValue(update, tool) });
  }

  /**
   * Notes that the permission request for `toolCallId`, titled `title`, was
   * taken as the plugin's own (`isOwnToolRequest`): the proof a current-form
   * call of that tool needs to be recorded. It is kept after the request is
   * answered, until the call ends or the bound pushes it out.
   */
  prove(toolCallId: string, title: string | undefined): void {
    const tool = ownToolOf(title);
    if (tool === undefined) {
      return;
    }
    this.#proofs.delete(toolCallId);
    this.#proofs.set(toolCallId, tool);
    for (const oldest of this.#proofs.keys()) {
      if (this.#proofs.size <= OWN_TOOL_PROOFS_KEPT) {
        break;
      }
      this.#proofs.delete(oldest);
    }
  }

  /**
   * Records a noted call on its `completed` update and forgets it on a
   * `failed` one; `update` is the raw session update, whose `rawInput` may
   * bring a current-form call's value.
   */
  update(toolCallId: string, status: string | undefined, update?: unknown): SidecarCallRecord {
    const noted = this.#open.get(toolCallId);
    const ends = status === 'completed' || status === 'failed';
    const proven = this.#proofs.get(toolCallId);
    if (ends) {
      this.#proofs.delete(toolCallId);
    }
    if (noted === undefined) {
      return undefined;
    }
    if (noted.form === 'current' && isObject(update)) {
      noted.value = currentFormValue(update, noted.tool) ?? noted.value;
    }
    if (!ends) {
      return undefined;
    }
    this.#open.delete(toolCallId);
    if (status === 'failed' || typeof noted.value !== 'string') {
      return undefined;
    }
    if (noted.form === 'current' && proven !== noted.tool) {
      return 'unproven';
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
