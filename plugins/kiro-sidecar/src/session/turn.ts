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
import type { OutcomeDecision } from './outcome.ts';
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

  /** A `tool_call_update` of this turn: records a noted own-tool call once it completes. */
  toolCallUpdate(toolCallId: string, status: string | undefined): SidecarCallRecord {
    return this.#finishing ? undefined : this.#calls.update(toolCallId, status);
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
      messages: [...calls.messages],
      messagesDropped: calls.messagesDropped,
      completion: calls.completion,
      final: cutKeepingEnd(summary.final, REPLY_PREVIEW_CHARS, summary.finalCutChars),
      textChars: summary.textChars + this.#writer.insertedChars,
      truncated,
      error,
      stderrTail: tail,
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
