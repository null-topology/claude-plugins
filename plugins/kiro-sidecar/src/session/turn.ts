/**
 * One turn of a session while it runs, and its result when it ends (4.3, 4.4).
 *
 * Agent text streams through redaction into `turns/<n>.md.part` and into the
 * accumulator (tool calls, last tool, the final text).
 * Kiro's calls of the plugin's own tools are read from the tool call updates
 * (4.11). At the end `turns/<n>.md` is finalized first and `turns/<n>.json`
 * is created after it, once.
 */

import { createTurnResult, readTurnResult } from '../store/runs.ts';
import { TurnAccumulator } from '../text/accumulator.ts';
import { REPLY_PREVIEW_CHARS } from '../text/limits.ts';
import { TurnTextWriter } from '../text/log-files.ts';
import { cutKeepingEnd } from '../text/preview.ts';
import { stderrTail } from '../text/read.ts';
import type { SecretSet } from '../text/redact.ts';
import { isoSeconds } from './claims.ts';
import { describeError } from './outcome.ts';
import type { CompletionEnd, OutcomeDecision } from './outcome.ts';
import { SidecarCalls } from './sidecar-calls.ts';
import type { SidecarCallRecord } from './sidecar-calls.ts';
import { parseTurnResult } from './turn-result.ts';
import type { Completion, EndedBy, LiveTurn, TurnResult } from './types.ts';

export interface TurnContext {
  readonly stateDir: string;
  readonly turnsDir: string;
  readonly launchId: string;
  readonly sessionId: string;
  readonly label: string | null;
  readonly turn: number;
  readonly secrets: SecretSet;
}

/** The notice of a turn in which a current-form call of an own tool completed with no permission proof. */
export const UNPROVEN_CALL_NOTICE =
  `Kiro ran a call titled as a sidecar tool (send_message or complete_task) without a permission ` +
  `request this plugin could verify, so the call was not recorded.`;

/** Outcomes whose result carries `error` and `stderrTail`. */
const FAILED_OUTCOMES: ReadonlySet<string> = new Set(['error', 'exited', 'lost']);

function isLineBreak(char: string): boolean {
  return char === '\n' || char === '\r';
}

export class TurnRecorder {
  readonly turn: number;
  readonly startedAt: Date;
  /** The end this plugin asked for while the turn ran (cancel, interrupt, stop). */
  requested: EndedBy | null = null;
  /** How this plugin is ending the turn itself after its completion (4.11), or null. */
  completionEnd: CompletionEnd | null = null;
  /** Set once `session/prompt` has settled: the turn is ending. */
  settled = false;
  readonly #context: TurnContext;
  readonly #writer: TurnTextWriter;
  readonly #accumulator: TurnAccumulator;
  readonly #calls: SidecarCalls;
  readonly #ended: Promise<TurnResult>;
  #resolveEnded: (result: TurnResult) => void = () => {};
  #finishing = false;
  /** The last character of agent text so far; empty before the first. */
  #lastChar = '';
  /** A tool call came after agent text and before the next agent text. */
  #toolSinceText = false;
  /** The credits of the turn's `turn_completion` updates so far; null before the first that has any. */
  #credits: number | null = null;
  /**
   * The turn's notices for the caller by kind, at most one of each, in the
   * order they first happened (`noteUnreadToolEnvelope`, an unproven call).
   */
  readonly #notices = new Map<'envelope' | 'unproven', string>();
  /** The error that kept `turns/<n>.md` from being finalized, if any. */
  textError: unknown;
  /** The error that kept `turns/<n>.json` from being written or read, if any. */
  resultError: unknown;

  private constructor(context: TurnContext, writer: TurnTextWriter) {
    this.turn = context.turn;
    this.startedAt = new Date();
    this.#context = context;
    this.#writer = writer;
    this.#accumulator = new TurnAccumulator(context.secrets);
    this.#calls = new SidecarCalls(context.secrets);
    this.#ended = new Promise((resolve) => {
      this.#resolveEnded = resolve;
    });
  }

  /** Opens `turns/<n>.md.part` for the turn. */
  static open(context: TurnContext): TurnRecorder {
    const writer = TurnTextWriter.open(context.turnsDir, context.turn, { secrets: context.secrets });
    return new TurnRecorder(context, writer);
  }

  /** Resolves with the result when the turn has ended, also when `turns/<n>.json` could not be written. */
  get ended(): Promise<TurnResult> {
    return this.#ended;
  }

  /** The turn's completion so far: the first recorded `complete_task` call (4.11). */
  get completion(): Completion | null {
    return this.#calls.summary().completion;
  }

  /**
   * An `agent_message_chunk` of this turn. When a tool call separates it from
   * earlier agent text and neither side has a line break there, the turn text
   * gets one `\n` between them; the final text does not. Redaction sees only
   * the agent text, so the `\n` is dropped when it would split a redacted
   * secret.
   */
  text(chunk: string): void {
    if (this.#finishing) {
      return;
    }
    if (chunk !== '') {
      if (this.#toolSinceText && !isLineBreak(this.#lastChar) && !isLineBreak(chunk.charAt(0))) {
        this.#writer.insert('\n');
      }
      this.#toolSinceText = false;
      this.#lastChar = chunk.charAt(chunk.length - 1);
    }
    this.#writer.write(chunk);
    this.#accumulator.text(chunk);
  }

  /**
   * A `tool_call` update of this turn. With its id and raw update, a call of
   * one of the plugin's own tools is also noted.
   */
  toolCall(title: string | undefined, toolCallId?: string, update?: unknown): void {
    if (this.#finishing) {
      return;
    }
    this.#toolSinceText = this.#lastChar !== '';
    this.#accumulator.toolCall(title);
    if (toolCallId !== undefined) {
      this.#calls.call(toolCallId, title, update);
    }
  }

  /**
   * A `tool_call_update` of this turn, with its raw update: records a noted
   * own-tool call once it completes. A current-form call that completes with
   * no permission proof is not recorded, and the turn gets a notice.
   */
  toolCallUpdate(toolCallId: string, status: string | undefined, update?: unknown): SidecarCallRecord {
    if (this.#finishing) {
      return undefined;
    }
    const recorded = this.#calls.update(toolCallId, status, update);
    if (recorded === 'unproven' && !this.#notices.has('unproven')) {
      this.#notices.set('unproven', UNPROVEN_CALL_NOTICE);
    }
    return recorded;
  }

  /**
   * A permission request of this turn that was taken as the plugin's own
   * (`isOwnToolRequest`): the proof a current-form call with that id needs.
   */
  ownToolRequest(toolCallId: string, title: string | undefined): void {
    if (!this.#finishing) {
      this.#calls.prove(toolCallId, title);
    }
  }

  /**
   * The credits of a `turn_completion` update of this turn (null: it had
   * none), added to the turn's. One that comes once the turn is ending is
   * not counted: the turn does not wait for it.
   */
  credits(credits: number | null): void {
    if (this.#finishing || credits === null) {
      return;
    }
    this.#credits = (this.#credits ?? 0) + credits;
  }

  /**
   * Notes that Kiro asked permission for a sidecar tool with a
   * `_meta.kiro.mcpTool` envelope version the plugin does not read. The
   * turn's result then carries one `notice`, however often it happened.
   */
  noteUnreadToolEnvelope(version: number | string): void {
    if (this.#finishing || this.#notices.has('envelope')) {
      return;
    }
    this.#notices.set(
      'envelope',
      `Kiro asked permission for a sidecar tool in an identity layout this plugin does not read ` +
        `(_meta.kiro.mcpTool.version ${version}); the permission policy decided it, and its ` +
        `send_message or complete_task may not be recorded. Update the plugin.`,
    );
  }

  /** The running counters. `lastTool` is redacted. */
  live(): LiveTurn {
    const progress = this.#accumulator.progress();
    return {
      turn: this.turn,
      startedAt: isoSeconds(this.startedAt),
      toolCalls: progress.toolCalls,
      lastTool: progress.lastTool,
    };
  }

  /**
   * Ends the turn: finalizes `turns/<n>.md`, then creates `turns/<n>.json`.
   * When the turn already has a result file (created once), that one is kept
   * and returned. `stderrLog` is read for the tail of a failed turn.
   */
  async finish(decision: OutcomeDecision, stderrLog: string): Promise<TurnResult> {
    this.#finishing = true;
    const { stateDir, launchId, secrets } = this.#context;
    const endedAt = new Date();
    const summary = this.#accumulator.finish();
    const calls = this.#calls.summary();
    let truncated: boolean;
    try {
      truncated = this.#writer.finalize().truncated;
    } catch (error) {
      truncated = this.#writer.truncated;
      this.textError = error;
    }
    // A turn whose text was not saved is an error, whatever Kiro answered.
    const textLost = this.textError !== undefined;
    const outcome = textLost ? 'error' : decision.outcome;
    const failed = FAILED_OUTCOMES.has(outcome);
    let error: string | null = null;
    let tail: string | null = null;
    if (failed) {
      const reasons: string[] = [];
      if (textLost) {
        reasons.push(`The turn text could not be saved: ${describeError(this.textError)}`);
      }
      if (decision.error !== null || !textLost) {
        reasons.push(decision.error ?? 'The turn failed for an unknown reason');
      }
      error = secrets.redact(reasons.join('; '));
      try {
        tail = stderrTail(stderrLog);
      } catch {
        tail = null;
      }
    }
    const result: TurnResult = {
      launchId,
      sessionId: this.#context.sessionId,
      label: this.#context.label,
      turn: this.turn,
      outcome,
      endedBy: decision.endedBy,
      startedAt: isoSeconds(this.startedAt),
      endedAt: isoSeconds(endedAt),
      durationS: Math.max(0, Math.round((endedAt.getTime() - this.startedAt.getTime()) / 1000)),
      toolCalls: summary.toolCalls,
      lastTool: summary.lastTool,
      credits: this.#credits,
      messages: [...calls.messages],
      messagesDropped: calls.messagesDropped,
      completion: calls.completion,
      final: cutKeepingEnd(summary.final, REPLY_PREVIEW_CHARS, summary.finalCutChars),
      textChars: summary.textChars + this.#writer.insertedChars,
      truncated,
      error,
      stderrTail: tail,
      ...(this.#notices.size === 0 ? {} : { notice: [...this.#notices.values()].join(' ') }),
    };
    let stored = result;
    try {
      if (!(await createTurnResult(stateDir, launchId, this.turn, result))) {
        // Another writer created the result first; it wins when it is valid.
        const existing = await readTurnResult(stateDir, launchId, this.turn);
        if (existing !== undefined) {
          try {
            stored = parseTurnResult(existing, launchId, this.turn);
          } catch {
            stored = result;
          }
        }
      }
    } catch (writeError) {
      // The turn still ends, with the result held in memory.
      this.resultError = writeError;
    }
    this.#resolveEnded(stored);
    return stored;
  }
}
