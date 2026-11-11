/**
 * What the ACP client reports: turn events for the session owner, and
 * lifecycle entries for the ACP log.
 *
 * Turn events carry the agent's content (text, tool titles, raw updates).
 * Lifecycle entries never do: they hold methods, kinds, ids, lengths, timings
 * and errors only. Full frames reach the lifecycle sink only when debug frames
 * are switched on; redacting them is the sink's job.
 */
import type {
  AnyMessage,
  PermissionOptionKind,
  SessionConfigOption,
  SessionNotification,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { PermissionDecision } from './permissions.ts';
import type { CloseReason } from './errors.ts';

interface SessionEventBase {
  readonly sessionId: string;
  /** True while `session/load` replays the session's history. */
  readonly replay: boolean;
}

export type TurnEvent =
  | (SessionEventBase & { readonly kind: 'agent_text'; readonly text: string; readonly update: SessionUpdate })
  | (SessionEventBase & {
      readonly kind: 'tool_call';
      readonly toolCallId: string;
      readonly title: string;
      readonly status: string | undefined;
      readonly update: SessionUpdate;
    })
  | (SessionEventBase & {
      readonly kind: 'tool_call_update';
      readonly toolCallId: string;
      readonly title: string | undefined;
      readonly status: string | undefined;
      readonly update: SessionUpdate;
    })
  | (SessionEventBase & {
      readonly kind: 'config_options';
      readonly configOptions: readonly SessionConfigOption[];
    })
  /**
   * Any other session update, unchanged; a `turn_completion`
   * `session_info_update` among them carries the turn's credits
   * (`turnCompletionCredits`).
   */
  | (SessionEventBase & { readonly kind: 'update'; readonly update: SessionUpdate })
  | {
      readonly kind: 'permission_requested';
      readonly sessionId: string;
      readonly toolCallId: string;
      readonly title: string | undefined;
    }
  | {
      readonly kind: 'permission_answered';
      readonly sessionId: string;
      readonly toolCallId: string;
      /** The title of the tool call the request was for, as requested. */
      readonly title: string | undefined;
      readonly decision: PermissionDecision | undefined;
      readonly outcome: 'selected' | 'cancelled';
      readonly optionId: string | undefined;
      readonly optionKind: PermissionOptionKind | undefined;
      /**
       * `policy`: an option of the kind the decision wants. `fallback`: none
       * was offered. `withdrawn`: answered `cancelled` because the turn was
       * cancelled, ended or the connection closed before a decision.
       */
      readonly via: 'policy' | 'fallback' | 'withdrawn';
    };

export type TurnEventSink = (event: TurnEvent) => void;

export type LifecycleEntry =
  | { readonly event: 'start'; readonly pid: number | undefined }
  | { readonly event: 'request'; readonly method: string; readonly sessionId?: string }
  | {
      readonly event: 'response';
      readonly method: string;
      readonly ms: number;
      readonly ok: boolean;
      readonly stopReason?: string;
      readonly error?: string;
    }
  | { readonly event: 'update'; readonly sessionId: string; readonly update: string; readonly length: number }
  | { readonly event: 'notification'; readonly method: string; readonly length: number }
  /** One server of a `_kiro/mcp/status` notification; `tools` is how many it lists. */
  | {
      readonly event: 'mcp_status';
      readonly sessionId: string;
      readonly server: string;
      readonly status: string;
      readonly tools: number;
    }
  | { readonly event: 'agent_request'; readonly method: string; readonly answer: 'method_not_found' }
  | {
      readonly event: 'permission';
      readonly sessionId: string;
      readonly decision: PermissionDecision | undefined;
      readonly outcome: 'selected' | 'cancelled';
      readonly optionKind: PermissionOptionKind | undefined;
      readonly via: 'policy' | 'fallback' | 'withdrawn';
    }
  | { readonly event: 'cancel'; readonly sessionId: string; readonly openPermissions: number }
  /** A start step's deadline passed: its request was withdrawn with `$/cancel_request`. */
  | { readonly event: 'cancel_request'; readonly method: string }
  | { readonly event: 'closed'; readonly reason: CloseReason; readonly error: string }
  | {
      readonly event: 'exit';
      readonly code: number | null;
      readonly signal: string | null;
      readonly error?: string;
    }
  | { readonly event: 'kill'; readonly reason: CloseReason }
  | { readonly event: 'error'; readonly where: string; readonly error: string }
  /** Debug frames only: the whole JSON-RPC message, unredacted. */
  | { readonly event: 'frame'; readonly dir: 'c2a' | 'a2c'; readonly message: AnyMessage };

export type LifecycleSink = (entry: LifecycleEntry) => void;

/** Maps one `session/update` notification to a turn event. Pure. */
export function toTurnEvent(notification: SessionNotification, replay: boolean): TurnEvent {
  const { sessionId, update } = notification;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      if (update.content.type === 'text') {
        return { kind: 'agent_text', sessionId, replay, text: update.content.text, update };
      }
      break;
    case 'tool_call':
      return {
        kind: 'tool_call',
        sessionId,
        replay,
        toolCallId: update.toolCallId,
        title: update.title,
        status: update.status ?? undefined,
        update,
      };
    case 'tool_call_update':
      return {
        kind: 'tool_call_update',
        sessionId,
        replay,
        toolCallId: update.toolCallId,
        title: update.title ?? undefined,
        status: update.status ?? undefined,
        update,
      };
    case 'config_option_update':
      return { kind: 'config_options', sessionId, replay, configOptions: update.configOptions };
    default:
      break;
  }
  return { kind: 'update', sessionId, replay, update };
}

/** The `_meta.kiro.kind` of the `session_info_update` that meters a turn. */
export const TURN_COMPLETION_KIND = 'turn_completion';

/**
 * The credits of a `session_info_update` whose `_meta.kiro.kind` is
 * `turn_completion`, Kiro's metering of a turn: the sum of `usage` over its
 * `promptTurnSummaries` entries in the credit unit, or null when no entry
 * is one. Undefined for every other update, which says nothing of credits.
 * Pure.
 */
export function turnCompletionCredits(update: SessionUpdate): number | null | undefined {
  if (update.sessionUpdate !== 'session_info_update') {
    return undefined;
  }
  const kiro = update._meta?.['kiro'];
  if (!isRecord(kiro) || kiro['kind'] !== TURN_COMPLETION_KIND) {
    return undefined;
  }
  return creditsOf(kiro['promptTurnSummaries']);
}

/**
 * The sum of `usage` over the `promptTurnSummaries` entries whose `unit` is
 * the credit unit, or null when none is. Kiro itself counts a unit that,
 * trimmed and lower-cased, is `credit` or `credits`, and only a `usage` that
 * is a finite number of at least 0; any other entry is skipped here too.
 */
export function creditsOf(summaries: unknown): number | null {
  if (!Array.isArray(summaries)) {
    return null;
  }
  let total: number | null = null;
  for (const summary of summaries) {
    if (!isRecord(summary)) {
      continue;
    }
    const { unit, usage } = summary;
    if (typeof unit !== 'string' || !CREDIT_UNITS.has(unit.trim().toLowerCase())) {
      continue;
    }
    if (typeof usage !== 'number' || !Number.isFinite(usage) || usage < 0) {
      continue;
    }
    total = (total ?? 0) + usage;
  }
  return total;
}

const CREDIT_UNITS: ReadonlySet<string> = new Set(['credit', 'credits']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
