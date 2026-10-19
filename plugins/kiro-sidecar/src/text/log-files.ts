/**
 * Size-capped writers for the run's text files. Every file is created with
 * mode 0600 and without following a symlink, and everything written is
 * redacted first.
 *
 * At the cap a writer appends one marker and drops later capped writes, so a
 * file holds at most its cap of content plus the marker. Writes never throw:
 * the first I/O error stops the writer and is kept in `error`.
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  ACP_LOG_CAP_BYTES,
  PRIVATE_FILE_MODE,
  STDERR_LOG_CAP_BYTES,
  TURN_TEXT_CAP_BYTES,
  formatBytes,
} from './limits.ts';
import type { SecretSet, StreamRedactor } from './redact.ts';
import { utf8PrefixLength } from './unicode.ts';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const OPEN_APPEND = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NO_FOLLOW;
const OPEN_TRUNCATE = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NO_FOLLOW;

/** Opens a file with mode 0600, also when it already existed with another mode. */
export function openPrivateFile(path: string, flags: number): number {
  const fd = openSync(path, flags, PRIVATE_FILE_MODE);
  try {
    fchmodSync(fd, PRIVATE_FILE_MODE);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

export interface LogOptions {
  readonly secrets: SecretSet;
  /** Defaults to the file's real cap; tests pass a small one. */
  readonly capBytes?: number;
}

/** Byte-counting appender shared by the writers. */
class CappedFile {
  readonly path: string;
  readonly capBytes: number;
  readonly #marker: Uint8Array;
  #fd: number | undefined;
  #bytes: number;
  #capped = false;
  #error: unknown = undefined;

  constructor(path: string, flags: number, capBytes: number, marker: string) {
    this.path = path;
    this.capBytes = capBytes;
    this.#marker = Buffer.from(marker, 'utf8');
    const fd = openPrivateFile(path, flags);
    try {
      this.#bytes = fstatSync(fd).size;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    this.#fd = fd;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get capped(): boolean {
    return this.#capped;
  }

  get error(): unknown {
    return this.#error;
  }

  /**
   * Appends `text` when it fits under the cap. When it does not, a `whole`
   * text is dropped entirely and a `prefix` text is written up to the cap
   * (never inside a UTF-8 sequence); then the marker is appended once.
   * Returns false when anything was dropped.
   */
  appendCapped(text: string, mode: 'whole' | 'prefix'): boolean {
    if (this.#capped) {
      return text === '';
    }
    const data = Buffer.from(text, 'utf8');
    const room = this.capBytes - this.#bytes;
    if (data.length <= room) {
      this.#write(data);
      return true;
    }
    if (mode === 'prefix' && room > 0) {
      this.#write(data.subarray(0, utf8PrefixLength(data, room)));
    }
    this.#capped = true;
    this.#write(this.#marker);
    return false;
  }

  /** Appends `text` regardless of the cap. */
  appendUncapped(text: string): void {
    this.#write(Buffer.from(text, 'utf8'));
  }

  /** Flushes to disk. Errors are kept like write errors. */
  sync(): void {
    if (this.#fd === undefined || this.#error !== undefined) {
      return;
    }
    try {
      fsyncSync(this.#fd);
    } catch (error) {
      this.#error = error;
    }
  }

  close(): void {
    if (this.#fd === undefined) {
      return;
    }
    const fd = this.#fd;
    this.#fd = undefined;
    try {
      closeSync(fd);
    } catch (error) {
      this.#error ??= error;
    }
  }

  #write(data: Uint8Array): void {
    if (this.#fd === undefined || this.#error !== undefined || data.length === 0) {
      return;
    }
    try {
      let offset = 0;
      while (offset < data.length) {
        offset += writeSync(this.#fd, data, offset, data.length - offset);
      }
      this.#bytes += data.length;
    } catch (error) {
      this.#error = error;
    }
  }
}

/**
 * `acp.jsonl`: one JSON value per line, each line redacted on its own.
 * Appends to an existing file and counts its size towards the cap. Past the
 * cap, ordinary lines are dropped whole and lifecycle lines are still
 * written; the first dropped line adds an `acp_log_capped` marker line.
 */
export class AcpLog {
  readonly #file: CappedFile;
  readonly #secrets: SecretSet;

  private constructor(file: CappedFile, secrets: SecretSet) {
    this.#file = file;
    this.#secrets = secrets;
  }

  static open(path: string, options: LogOptions): AcpLog {
    const capBytes = options.capBytes ?? ACP_LOG_CAP_BYTES;
    const marker = `${JSON.stringify({ event: 'acp_log_capped', capBytes })}\n`;
    return new AcpLog(new CappedFile(path, OPEN_APPEND, capBytes, marker), options.secrets);
  }

  get path(): string {
    return this.#file.path;
  }

  get bytes(): number {
    return this.#file.bytes;
  }

  get capped(): boolean {
    return this.#file.capped;
  }

  get error(): unknown {
    return this.#file.error;
  }

  /**
   * Appends one line: a serialized JSON value without a newline. Returns
   * whether it was written.
   */
  write(line: string, options: { readonly lifecycle?: boolean } = {}): boolean {
    const text = `${this.#secrets.redact(line)}\n`;
    if (options.lifecycle === true) {
      this.#file.appendUncapped(text);
      return this.#file.error === undefined;
    }
    return this.#file.appendCapped(text, 'whole') && this.#file.error === undefined;
  }

  close(): void {
    this.#file.close();
  }
}

/**
 * `stderr.log`: Kiro's stderr as a stream. Bytes are decoded as UTF-8 across
 * chunk borders and redacted as a stream, so a secret split across chunks is
 * caught. At the cap the part that fits is written, then a marker line, and
 * later output is dropped. `close` flushes the held-back text.
 */
export class StderrLog {
  readonly #file: CappedFile;
  readonly #redactor: StreamRedactor;
  readonly #decoder = new StringDecoder('utf8');
  #closed = false;

  private constructor(file: CappedFile, redactor: StreamRedactor) {
    this.#file = file;
    this.#redactor = redactor;
  }

  static open(path: string, options: LogOptions): StderrLog {
    const capBytes = options.capBytes ?? STDERR_LOG_CAP_BYTES;
    const marker = `\n[kiro-sidecar] stderr.log reached its ${formatBytes(capBytes)} cap; later output was dropped\n`;
    return new StderrLog(
      new CappedFile(path, OPEN_APPEND, capBytes, marker),
      options.secrets.stream(),
    );
  }

  get path(): string {
    return this.#file.path;
  }

  get bytes(): number {
    return this.#file.bytes;
  }

  get capped(): boolean {
    return this.#file.capped;
  }

  get error(): unknown {
    return this.#file.error;
  }

  write(chunk: string | Uint8Array): void {
    if (this.#closed) {
      return;
    }
    const text = typeof chunk === 'string' ? chunk : this.#decoder.write(Buffer.from(chunk));
    this.#file.appendCapped(this.#redactor.push(text), 'prefix');
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const rest = this.#redactor.push(this.#decoder.end()) + this.#redactor.end();
    this.#file.appendCapped(rest, 'prefix');
    this.#file.close();
  }
}

export interface TurnTextFile {
  readonly path: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

/**
 * The full agent text of one turn. Text is redacted as a stream and written
 * to `<n>.md.part`; at the cap the part that fits is written, then a marker,
 * and the turn is `truncated`. `finalize` flushes the held-back text and
 * renames the file to `<n>.md`, so `<n>.md` exists before the caller writes
 * the turn result.
 */
export class TurnTextWriter {
  readonly path: string;
  readonly partPath: string;
  readonly #file: CappedFile;
  readonly #redactor: StreamRedactor;
  #finalized = false;

  private constructor(path: string, partPath: string, file: CappedFile, redactor: StreamRedactor) {
    this.path = path;
    this.partPath = partPath;
    this.#file = file;
    this.#redactor = redactor;
  }

  /** Creates (or truncates) `<turnsDir>/<turn>.md.part`. */
  static open(turnsDir: string, turn: number, options: LogOptions): TurnTextWriter {
    if (!Number.isSafeInteger(turn) || turn < 1) {
      throw new RangeError(`turn must be a positive integer, got ${String(turn)}`);
    }
    const capBytes = options.capBytes ?? TURN_TEXT_CAP_BYTES;
    const marker = `\n\n[kiro-sidecar] The turn text reached its ${formatBytes(capBytes)} cap; the rest was not saved.\n`;
    const path = join(turnsDir, `${turn}.md`);
    const partPath = `${path}.part`;
    return new TurnTextWriter(
      path,
      partPath,
      new CappedFile(partPath, OPEN_TRUNCATE, capBytes, marker),
      options.secrets.stream(),
    );
  }

  get truncated(): boolean {
    return this.#file.capped;
  }

  get bytes(): number {
    return this.#file.bytes;
  }

  /** Appends agent text. Never throws; an I/O error is reported by `finalize`. */
  write(text: string): void {
    if (this.#finalized) {
      return;
    }
    this.#file.appendCapped(this.#redactor.push(text), 'prefix');
  }

  /**
   * Adds text of this plugin's own (not agent text) after the text written so
   * far. Redaction does not see it, so a secret across this point is still
   * redacted; when the point falls inside a redacted secret, it is dropped.
   */
  insert(text: string): void {
    if (this.#finalized) {
      return;
    }
    this.#redactor.insert(text);
  }

  /** UTF-16 code units of inserted text that reached the turn text, before the cap. */
  get insertedChars(): number {
    return this.#redactor.insertedChars;
  }

  /**
   * Flushes, closes and renames `<n>.md.part` to `<n>.md`. Throws the first
   * I/O error instead, leaving the `.part` file in place.
   */
  finalize(): TurnTextFile {
    if (this.#finalized) {
      throw new Error(`${this.path} was already finalized`);
    }
    this.#finalized = true;
    this.#file.appendCapped(this.#redactor.end(), 'prefix');
    this.#file.sync();
    this.#file.close();
    const error = this.#file.error;
    if (error !== undefined) {
      throw error;
    }
    renameSync(this.partPath, this.path);
    return { path: this.path, bytes: this.#file.bytes, truncated: this.#file.capped };
  }
}
