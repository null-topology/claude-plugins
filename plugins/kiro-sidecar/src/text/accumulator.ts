/**
 * Summarises one turn while it streams: tool call count, last tool, text
 * size and the final text (after the last `tool_call`). Memory holds only the
 * counters and the tail of the final text; the full text goes to disk through
 * `TurnTextWriter`.
 *
 * The final text is redacted here, as a stream that is restarted at each
 * `tool_call`, so a secret is caught even when it is split across chunks or
 * straddles the start of the final text.
 */

import { fieldValue } from './field.ts';
import { REPLY_PREVIEW_CHARS } from './limits.ts';
import type { SecretSet, StreamRedactor } from './redact.ts';
import { tailStart } from './unicode.ts';

export interface TurnProgress {
  readonly toolCalls: number;
  readonly lastTool: string | null;
  /** UTF-16 code units of agent text received, before redaction and the file cap. */
  readonly textChars: number;
}

export interface TurnSummary extends TurnProgress {
  /**
   * The redacted text after the last `tool_call` (the whole text when there
   * was none), cut to its last `finalMaxChars` characters.
   */
  readonly final: string;
  /** Characters dropped from the start of `final`; 0 when it is whole. */
  readonly finalCutChars: number;
}

export interface AccumulatorOptions {
  readonly finalMaxChars?: number;
}

export class TurnAccumulator {
  readonly #secrets: SecretSet;
  readonly #redactor: StreamRedactor;
  readonly #finalMaxChars: number;
  #toolCalls = 0;
  #lastTool: string | null = null;
  #textChars = 0;
  #tail = '';
  #tailCut = 0;
  #summary: TurnSummary | undefined;

  constructor(secrets: SecretSet, options: AccumulatorOptions = {}) {
    this.#secrets = secrets;
    this.#redactor = secrets.stream();
    this.#finalMaxChars = options.finalMaxChars ?? REPLY_PREVIEW_CHARS;
  }

  /** An `agent_message_chunk` text. */
  text(chunk: string): void {
    this.#assertOpen();
    this.#textChars += chunk.length;
    this.#take(this.#redactor.push(chunk));
  }

  /**
   * A `tool_call` update: counts it and starts a new final text. Its title
   * becomes `lastTool` as a wake header value does: redacted, on one line and
   * cut keeping its start (4.4).
   */
  toolCall(title?: string | null): void {
    this.#assertOpen();
    this.#toolCalls += 1;
    this.#lastTool = title === undefined || title === null || title === '' ? null : fieldValue(title, this.#secrets);
    this.#redactor.restart();
    this.#tail = '';
    this.#tailCut = 0;
  }

  /** The counters so far, for a turn that is still running. */
  progress(): TurnProgress {
    return { toolCalls: this.#toolCalls, lastTool: this.#lastTool, textChars: this.#textChars };
  }

  /** Ends the turn. Later calls return the same summary. */
  finish(): TurnSummary {
    if (this.#summary !== undefined) {
      return this.#summary;
    }
    this.#take(this.#redactor.end());
    this.#trimTail();
    this.#summary = Object.freeze({
      ...this.progress(),
      final: this.#tail,
      finalCutChars: this.#tailCut,
    });
    return this.#summary;
  }

  #assertOpen(): void {
    if (this.#summary !== undefined) {
      throw new Error('the turn is already finished');
    }
  }

  #take(piece: string): void {
    if (piece === '') {
      return;
    }
    this.#tail += piece;
    if (this.#tail.length > 2 * this.#finalMaxChars) {
      this.#trimTail();
    }
  }

  #trimTail(): void {
    const start = tailStart(this.#tail, this.#finalMaxChars);
    if (start > 0) {
      this.#tailCut += start;
      this.#tail = this.#tail.slice(start);
    }
  }
}
