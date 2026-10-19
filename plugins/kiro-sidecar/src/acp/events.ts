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
  /** Any other session update, unchanged. */
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
