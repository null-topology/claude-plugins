/**
 * Secret redaction. Every occurrence of a secret, in its raw, JSON-escaped
 * and URL-encoded forms, is replaced with `[REDACTED]`. Occurrences that
 * overlap or touch form one covered run, and each run becomes a single
 * `[REDACTED]`, so when one secret contains another the longer one decides
 * what is covered.
 *
 * A percent escape (`%XX`) decodes to the same character whatever the case of
 * its hex digits, so inside every form the hex digits of each escape match in
 * either case (`%2f` and `%2F` alike). Every other character matches exactly.
 *
 * The streaming redactor gives the same output as redacting the whole text
 * at once, however the text is split into chunks: it holds back the last
 * (longest form - 1) characters until the next chunk or the end of the
 * stream shows whether they start a secret.
 */

import type { Environment } from '../settings.ts';
import { InvalidInputError } from './errors.ts';
import { MIN_KIRO_TOKEN_CHARS } from './limits.ts';
import { isHighSurrogate } from './unicode.ts';

export const REDACTED = '[REDACTED]';

/** Set when the server runs inside Claude Code; its value is a secret. */
export const MESSAGING_TOKEN_VARIABLE = 'CLAUDE_CODE_MESSAGING_TOKEN';

/** Proxy variables whose values are secrets: a proxy URL can carry credentials. */
export const SECRET_PROXY_VARIABLES = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
] as const);

/** The `proxy` setting as the server gets it and as Claude Code exports it to hook processes. */
export const PROXY_SETTING_VARIABLES = Object.freeze(['KIRO_SIDECAR_PROXY', 'CLAUDE_PLUGIN_OPTION_PROXY'] as const);

/** The forms of one secret that are redacted: raw, JSON-escaped and URL-encoded. */
export function secretForms(secret: string): string[] {
  if (secret === '') {
    return [];
  }
  const forms = new Set<string>([secret, JSON.stringify(secret).slice(1, -1)]);
  try {
    forms.add(encodeURIComponent(secret));
  } catch {
    // A lone surrogate has no URL-encoded form.
  }
  return [...forms];
}

/** Refuses a Kiro token shorter than 16 characters. The message never holds the token. */
export function assertKiroToken(token: string, field: string): void {
  if (token.length < MIN_KIRO_TOKEN_CHARS) {
    throw new InvalidInputError(
      field,
      `must hold a Kiro token of at least ${MIN_KIRO_TOKEN_CHARS} characters`,
    );
  }
}

export interface SecretSources {
  /** The `api_key` setting; an empty value is not a secret. */
  readonly apiKey?: string;
  /** Every token-file value this server has read. */
  readonly tokenFileValues?: readonly string[];
  /** The server's own environment, read for the messaging token, the proxy URLs and the proxy setting. */
  readonly env?: Environment;
  /**
   * `KIRO_API_KEY` values: the one a Kiro process gets and the server's own,
   * which is no token source. Each one that is not empty is a secret
   * whatever its length: it is not checked as a Kiro token.
   */
  readonly kiroKeys?: readonly string[];
}

/**
 * Builds the secret set: `api_key` when not empty, every token-file value,
 * every Kiro key value, `CLAUDE_CODE_MESSAGING_TOKEN` when set, and each of
 * `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy` and `https_proxy` that is set,
 * and the `proxy` setting in either of its variables.
 * Empty values are skipped. Throws `InvalidInputError` (`api_key` or
 * `token_file`) when a Kiro token is shorter than 16 characters.
 */
export function buildSecretSet(sources: SecretSources = {}): SecretSet {
  const secrets: string[] = [];
  const apiKey = sources.apiKey ?? '';
  if (apiKey !== '') {
    assertKiroToken(apiKey, 'api_key');
    secrets.push(apiKey);
  }
  for (const token of sources.tokenFileValues ?? []) {
    assertKiroToken(token, 'token_file');
    secrets.push(token);
  }
  for (const key of sources.kiroKeys ?? []) {
    if (key !== '') {
      secrets.push(key);
    }
  }
  const env = sources.env ?? process.env;
  for (const name of [MESSAGING_TOKEN_VARIABLE, ...SECRET_PROXY_VARIABLES, ...PROXY_SETTING_VARIABLES]) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      secrets.push(value);
    }
  }
  return new SecretSet(secrets);
}

/**
 * A fixed set of secrets. The values are held in private fields, so
 * `util.inspect` and `JSON.stringify` of the set do not show them.
 */
export class SecretSet {
  readonly #patterns: readonly Pattern[];

  constructor(secrets: Iterable<string> = []) {
    const patterns = new Set<string>();
    for (const secret of secrets) {
      for (const form of secretForms(secret)) {
        patterns.add(form);
      }
    }
    this.#patterns = Object.freeze([...patterns].map(compilePattern));
  }

  /** Number of distinct redacted forms. */
  get size(): number {
    return this.#patterns.length;
  }

  /** Characters a stream holds back: the longest form's length minus one. */
  get windowChars(): number {
    return windowFor(this.#patterns);
  }

  redact(text: string): string {
    if (this.#patterns.length === 0 || text === '') {
      return text;
    }
    return emit(text, this.#patterns, text.length, 0, NO_RUN).text;
  }

  /** A redactor for one stream of text. */
  stream(): StreamRedactor {
    return new StreamRedactor(this.#patterns);
  }

  toJSON(): { readonly size: number } {
    return { size: this.size };
  }
}

/**
 * Redacts a stream of chunks. `push` returns the text that is final so far;
 * `end` returns the rest. Concatenated, the output equals `redact` of the
 * concatenated input, with the text given to `insert` placed at its points.
 */
export class StreamRedactor {
  readonly #patterns: readonly Pattern[];
  readonly #window: number;
  /** Text received but not yet emitted. */
  #carry = '';
  /** Where the carry stands against the runs already emitted. */
  #state: EmitState = NO_RUN;
  /** Leading characters of the carry that are never emitted (see `restart`). */
  #hidden = 0;
  /** Inserted text not placed yet, at offsets into the carry, in order. */
  #inserts: Insert[] = [];
  #insertedChars = 0;

  constructor(patterns: readonly Pattern[]) {
    this.#patterns = patterns;
    this.#window = windowFor(patterns);
  }

  push(chunk: string): string {
    if (chunk === '') {
      return '';
    }
    const buffer = this.#carry + chunk;
    let cut = Math.max(0, buffer.length - this.#window);
    if (cut > 0 && isHighSurrogate(buffer.charCodeAt(cut - 1))) {
      // Never emit half of a surrogate pair: the piece is encoded on its own.
      cut -= 1;
    }
    return this.#advance(buffer, cut);
  }

  /**
   * Puts `text` into the output at the point between the input pushed so far
   * and the next push. Redaction does not see it, so a secret that spans the
   * point is still found; when the point falls inside a covered run, the text
   * is dropped.
   */
  insert(text: string): void {
    if (text !== '') {
      this.#inserts.push({ at: this.#carry.length, text });
    }
  }

  /** UTF-16 code units of inserted text placed in the output since the redactor was created. */
  get insertedChars(): number {
    return this.#insertedChars;
  }

  /** Flushes the held-back text and resets the redactor for a new stream. */
  end(): string {
    const output = this.#advance(this.#carry, this.#carry.length, true);
    this.#carry = '';
    this.#state = NO_RUN;
    this.#hidden = 0;
    this.#inserts = [];
    return output;
  }

  /**
   * Starts a new output segment: the held-back text, and any text inserted
   * into it, is dropped without being emitted, but the text stays as context,
   * so a secret that began in it is still redacted in the text that follows.
   */
  restart(): void {
    this.#hidden = this.#carry.length;
    this.#state = NO_RUN;
    this.#inserts = [];
  }

  #advance(buffer: string, cut: number, final = false): string {
    const emitted = emit(buffer, this.#patterns, cut, this.#hidden, this.#state, this.#inserts, final);
    this.#carry = buffer.slice(cut);
    this.#state = { covered: emitted.covered, continues: emitted.continues };
    this.#hidden = Math.max(0, this.#hidden - cut);
    this.#inserts = emitted.pending.map((insert) => ({ at: insert.at - cut, text: insert.text }));
    this.#insertedChars += emitted.insertedChars;
    return emitted.text;
  }
}

/**
 * One redacted form. `escapes` is set when the form holds a percent escape
 * with a hex letter: it matches the form with those letters in either case,
 * and is always exactly `form.length` characters long.
 */
interface Pattern {
  readonly form: string;
  readonly escapes: RegExp | null;
}

const PERCENT_ESCAPE = /^%[0-9A-Fa-f]{2}$/;
const REGEX_SYNTAX = /[.*+?^${}()|[\]\\/]/g;

function compilePattern(form: string): Pattern {
  let source = '';
  let caseFree = false;
  for (let at = 0; at < form.length; at += 1) {
    const escape = form.slice(at, at + 3);
    if (PERCENT_ESCAPE.test(escape)) {
      const high = hexDigitClass(escape.charAt(1));
      const low = hexDigitClass(escape.charAt(2));
      caseFree ||= high.length > 1 || low.length > 1;
      source += `%${high}${low}`;
      at += 2;
    } else {
      source += form.charAt(at).replace(REGEX_SYNTAX, '\\$&');
    }
  }
  return { form, escapes: caseFree ? new RegExp(source, 'g') : null };
}

/** A hex digit as a regular expression matching it in either case. */
function hexDigitClass(digit: string): string {
  const lower = digit.toLowerCase();
  const upper = digit.toUpperCase();
  return lower === upper ? digit : `[${lower}${upper}]`;
}

function windowFor(patterns: readonly Pattern[]): number {
  let longest = 0;
  for (const pattern of patterns) {
    longest = Math.max(longest, pattern.form.length);
  }
  return Math.max(0, longest - 1);
}

type Run = [start: number, end: number];

/** Covered runs of `text`: every occurrence of every pattern, overlapping or touching ones merged. */
function coveredRuns(text: string, patterns: readonly Pattern[], coveredPrefix: number): Run[] {
  const found: Run[] = [];
  if (coveredPrefix > 0) {
    found.push([0, coveredPrefix]);
  }
  for (const { form, escapes } of patterns) {
    if (escapes === null) {
      for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
        found.push([at, at + form.length]);
      }
      continue;
    }
    escapes.lastIndex = 0;
    for (let match = escapes.exec(text); match !== null; match = escapes.exec(text)) {
      found.push([match.index, match.index + form.length]);
      // Step one character on, as `indexOf` does, so overlapping occurrences are found.
      escapes.lastIndex = match.index + 1;
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  const runs: Run[] = [];
  for (const [start, end] of found) {
    const last = runs.at(-1);
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      runs.push([start, end]);
    }
  }
  return runs;
}

interface EmitState {
  /** Leading characters of the buffer inside a run whose `[REDACTED]` was already emitted. */
  readonly covered: number;
  /** The output so far ends with a `[REDACTED]` whose run reaches the buffer start. */
  readonly continues: boolean;
}

/** Text that goes into the output before buffer character `at`, unseen by redaction. */
interface Insert {
  readonly at: number;
  readonly text: string;
}

interface Emitted extends EmitState {
  readonly text: string;
  /** The inserts left for a later call, all at `cut` or later. */
  readonly pending: readonly Insert[];
  /** UTF-16 code units of inserted text placed in `text`. */
  readonly insertedChars: number;
}

const NO_RUN: EmitState = Object.freeze({ covered: 0, continues: false });
const NO_INSERTS: readonly Insert[] = Object.freeze([]);

/**
 * Emits `buffer[hidden, cut)` with covered runs replaced. A run that starts
 * before `cut` is complete in `buffer`; one that starts at `cut` or later is
 * left for the next call. A run starting at 0 while `continues` is set
 * continues a `[REDACTED]` emitted earlier and adds no second one.
 *
 * `inserts`, ordered by `at`, go into the output at their points; one whose
 * point lies inside a covered run is dropped (a continued run starts before
 * the buffer). One at `cut` is left for the next call, which shows whether a
 * run continues across it, unless the call is `final`.
 */
function emit(
  buffer: string,
  patterns: readonly Pattern[],
  cut: number,
  hidden: number,
  state: EmitState,
  inserts: readonly Insert[] = NO_INSERTS,
  final = false,
): Emitted {
  let output = '';
  let position = hidden;
  let lastEnd = -1;
  let next = 0;
  let insertedChars = 0;
  // Emits `buffer[position, to)` with the inserts in it, and the one at `to`
  // when `atEnd` is set. An insert before `position` lies inside a run
  // already replaced and is dropped.
  const plain = (to: number, atEnd: boolean): void => {
    let from = position;
    for (; next < inserts.length; next += 1) {
      const insert = inserts[next];
      if (insert === undefined || insert.at > to || (insert.at === to && !atEnd)) {
        break;
      }
      if (insert.at < from) {
        continue;
      }
      output += buffer.slice(from, insert.at) + insert.text;
      insertedChars += insert.text.length;
      from = insert.at;
    }
    if (to > from) {
      output += buffer.slice(from, to);
    }
  };
  for (const [start, end] of coveredRuns(buffer, patterns, state.covered)) {
    const continuation = start === 0 && state.continues;
    if (start >= cut && !continuation) {
      break;
    }
    if (end <= hidden) {
      continue;
    }
    // An insert where the run starts goes before its `[REDACTED]`, unless the run began earlier.
    plain(start, !continuation);
    if (!continuation) {
      output += REDACTED;
    }
    position = Math.max(position, end);
    lastEnd = end;
    if (end > cut) {
      break;
    }
  }
  plain(cut, final);
  const pending = inserts.slice(next);
  if (lastEnd >= cut) {
    return { text: output, covered: lastEnd - cut, continues: true, pending, insertedChars };
  }
  // Nothing emitted leaves the output, and so the state, as it was.
  return { text: output, covered: 0, continues: output === '' && state.continues, pending, insertedChars };
}
