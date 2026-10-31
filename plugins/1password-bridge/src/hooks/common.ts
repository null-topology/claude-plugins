/**
 * What every hook handler shares: the input it gets, the context it runs in,
 * the output it may return, and the marker check that keeps a hook of a
 * session without masks down to one read. Every hook run but SessionEnd also
 * touches `last-seen`, on which the SessionStart sweep keys, and prunes the
 * board before its handler starts (`keepSession` in `run.ts`).
 */

import { isSessionId, type Environment } from '../paths.ts';
import { TICKET_ID_PATTERN } from '../protocol.ts';
import { readMarker } from '../session-files.ts';

export type HookEventName = 'SessionStart' | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop' | 'SubagentStop' | 'SessionEnd';

export const HOOK_EVENTS: readonly HookEventName[] = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop', 'SessionEnd'];

/** The parsed hook input; every field is untrusted until checked. */
export type HookInput = Readonly<Record<string, unknown>>;

export interface HookContext {
  readonly input: HookInput;
  readonly stateDir: string;
  /** `CLAUDE_PLUGIN_ROOT`, or '' when unset. */
  readonly pluginRoot: string;
  readonly env: Environment;
}

export interface HookSpecificOutput {
  readonly hookEventName: HookEventName;
  readonly additionalContext?: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  readonly updatedToolOutput?: unknown;
}

export interface HookOutput {
  readonly systemMessage?: string;
  readonly hookSpecificOutput?: HookSpecificOutput;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** The input's `session_id` when it is safe as a path segment, else undefined. */
export function liveSessionId(input: HookInput): string | undefined {
  const id = input['session_id'];
  return typeof id === 'string' && isSessionId(id) ? id : undefined;
}

/** A session whose `masked` marker exists; `unreadable` when its ticket ids cannot be known. */
export interface MaskedSession {
  id: string;
  tickets: string[];
  unreadable: boolean;
}

/**
 * The session and the ticket ids in its `masked` marker, or undefined when
 * there is no marker. A marker that exists but cannot be read, holds no id,
 * or holds a line that is not a ticket id is `unreadable` with no tickets:
 * nobody can tell which values it covers, so the handlers withhold rather
 * than let the broker check coverage against an empty list (fail closed).
 */
export function maskedSession(ctx: HookContext): MaskedSession | undefined {
  const id = liveSessionId(ctx.input);
  if (id === undefined) return undefined;
  let tickets: string[] | undefined;
  try {
    tickets = readMarker(ctx.stateDir, id);
  } catch {
    return { id, tickets: [], unreadable: true };
  }
  if (tickets === undefined) return undefined;
  if (tickets.length === 0 || !tickets.every((t) => TICKET_ID_PATTERN.test(t))) return { id, tickets: [], unreadable: true };
  return { id, tickets, unreadable: false };
}
