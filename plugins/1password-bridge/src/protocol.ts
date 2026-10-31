/**
 * The broker protocol: one request per connection, one JSON line each way; a
 * `redeem` continues on its connection with the CLI's acknowledgements.
 *
 * A request carries `v: PROTOCOL_VERSION`; the socket name carries it too, so
 * brokers of two protocol versions never meet. Both sides check what they
 * read: `parseRequest` and `parseResponse` return a fresh value holding only
 * the known fields, or null for anything malformed.
 */

import type { Readable } from 'node:stream';
import { isSessionId } from './paths.ts';
import { PROTOCOL_VERSION } from './version.ts';

export interface SessionRef {
  id: string;
  title?: string;
}

/** The agent that issued a ticket: a subagent's `agent_id`, or `main`. */
export interface AgentRef {
  id: string;
  type?: string;
}

export type Request =
  | { v: typeof PROTOCOL_VERSION; op: 'status' }
  | { v: typeof PROTOCOL_VERSION; op: 'fields'; account: string; ref: string }
  | {
      v: typeof PROTOCOL_VERSION;
      op: 'issue_tickets';
      account: string;
      accountLabel: string;
      ref: string;
      reason: string;
      count: number;
      session: SessionRef;
      agent: AgentRef;
    }
  // Continues on the same connection with the CLI's acknowledgements (Ack).
  | { v: typeof PROTOCOL_VERSION; op: 'redeem'; ticket: string; session: string }
  // `tickets`: the ids in the session's `masked` marker; the broker must hold a mask for each of them.
  // `output`: a Bash command's `tool_response`, or the error text of a failed one.
  | { v: typeof PROTOCOL_VERSION; op: 'mask'; session: string; tickets: string[]; output: unknown }
  | { v: typeof PROTOCOL_VERSION; op: 'release'; session: string; tickets: string[] }
  | { v: typeof PROTOCOL_VERSION; op: 'end_session'; session: string };

/** The most tickets one `issue_tickets` creates. */
export const MAX_TICKETS = 5;

export const TICKET_ID_PATTERN = /^tkt_[a-z2-7]{16}$/;

/** The CLI's acknowledgements after a `redeem` answer carrying a value. */
export const ACKS = ['received', 'delivered', 'not_delivered'] as const;
export type AckOp = (typeof ACKS)[number];
export type Ack = { v: typeof PROTOCOL_VERSION; op: AckOp };

export const FAILURE_CODES = [
  'denied',
  'no_dialog',
  'not_found',
  'ambiguous',
  'bad_ref',
  'integration_off',
  'auth_denied',
  'auth_timeout',
  'expired',
  'busy',
  'not_owner',
  'other_agent',
  'no_command',
  'unknown',
  'used',
  'voided',
  'field_gone',
  // The broker lost its socket path to another broker; broker-client reconnects and retries once.
  'displaced',
  'no_app',
  'internal',
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export type Failure = { ok: false; code: FailureCode; message: string };

// id/sectionId let the model reference a field whose title holds `/` or `?`, or one of two
// same-titled fields, by id; lookup accepts a field id in the field segment.
export interface FieldMeta {
  id: string;
  title: string;
  sectionId?: string;
  section?: string;
  type: string;
  masked: boolean;
}

/** What `issue_tickets` resolved, as a preview: the value fetched at approve decides masking. */
export interface FieldSummary {
  vault: string;
  item: string;
  field: string;
  type: string;
  masked: boolean;
  short: boolean;
}

// `in_flight`: the ticket was approved and its redeem still runs; it ends used or voided, never unused.
// `mask_kept`: the ticket's mask is gone, but every value it held stays masked under a ticket outside the call.
export const RELEASE_RESULTS = ['voided', 'in_flight', 'unmasked', 'mask_kept', 'final', 'unknown', 'not_owner'] as const;
export type ReleaseResult = { ticket: string; result: (typeof RELEASE_RESULTS)[number] };

export type Response =
  | {
      ok: true;
      op: 'status';
      accounts: { account: string; warm: boolean }[];
      /**
       * The nominal time the broker drops its 1Password clients, the idle
       * window after the last request. The broker process may live past it:
       * a live ticket or mask keeps it running.
       */
      exitsAt: string;
    }
  | { ok: true; op: 'fields'; vault: string; item: { title: string; category: string }; fields: FieldMeta[] }
  | { ok: true; op: 'issue_tickets'; tickets: string[]; expiresAt: string; field: FieldSummary }
  | { ok: true; op: 'redeem'; value: string }
  // `known: false`: the broker lacks the mask of a requested ticket, or holds none for the session; `output` is the masked output when `changed`.
  // `missing`: the requested ids whose mask the broker does not hold (empty when `known`); only these may be released to stop withholding.
  | { ok: true; op: 'mask'; known: boolean; changed: boolean; output: unknown; missing: string[] }
  | { ok: true; op: 'release'; results: ReleaseResult[] }
  | { ok: true; op: 'end_session' }
  | Failure;

/** The longest line either side reads; a longer one is a FrameError. */
export const MAX_LINE_BYTES = 1024 * 1024;

/** The longest `mask` request or answer: it carries a whole Bash command output. */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export class FrameError extends Error {
  readonly code = 'EFRAME';

  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

/** `message` as one protocol line: JSON (which never holds a raw newline) plus `\n`. */
export function encodeLine(message: Request | Response | Ack): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * The first line of `stream`, without its newline; null when the stream ends,
 * closes or fails first. Rejects with FrameError when no newline comes within
 * `maxBytes`. Bytes after the newline are left unread.
 */
export function readLine(stream: Readable, maxBytes: number = MAX_LINE_BYTES): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (settle: () => void): void => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('close', onEnd);
      stream.off('error', onEnd);
      stream.pause();
      settle();
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const end = bytes.indexOf(0x0a);
      if (end >= 0 && size + end <= maxBytes) {
        chunks.push(bytes.subarray(0, end));
        finish(() => resolve(Buffer.concat(chunks).toString('utf8')));
        return;
      }
      size += end >= 0 ? end : bytes.length;
      if (size > maxBytes) {
        finish(() => reject(new FrameError(`No newline within ${maxBytes} bytes`)));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => finish(() => resolve(null));
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('close', onEnd);
    stream.once('error', onEnd);
  });
}

export interface LineReader {
  /**
   * The next line without its newline; null once the stream ended, closed or failed.
   * Calls must not overlap: await each one before the next, or the earlier one may never settle.
   */
  next(): Promise<string | null>;
  /** Sets the limit for the line being read and every line after it, those already received included. */
  limit(maxBytes: number): void;
}

/**
 * Successive lines of `stream`, keeping the bytes after each newline for the
 * next call (`readLine` reads one line and drops the rest of its chunk).
 * `redeem` needs it: the CLI's acknowledgements can arrive in one chunk.
 * The broker reads a request under the `mask` limit, then lowers it.
 */
export function lineReader(stream: Readable, maxBytes: number = MAX_LINE_BYTES): LineReader {
  let max = maxBytes;
  const lines: string[] = [];
  let partial: Buffer[] = [];
  let partialSize = 0;
  let ended = false;
  let failure: FrameError | undefined;
  let wake: (() => void) | undefined;
  const notify = (): void => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  const tooLong = (): void => {
    failure = new FrameError(`No newline within ${max} bytes`);
    stream.off('data', onData);
    stream.pause();
  };
  const onData = (chunk: Buffer | string): void => {
    let bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    for (let end = bytes.indexOf(0x0a); end >= 0; end = bytes.indexOf(0x0a)) {
      if (partialSize + end > max) {
        tooLong();
        notify();
        return;
      }
      partial.push(bytes.subarray(0, end));
      lines.push(Buffer.concat(partial, partialSize + end).toString('utf8'));
      partial = [];
      partialSize = 0;
      bytes = bytes.subarray(end + 1);
    }
    partial.push(bytes);
    partialSize += bytes.length;
    if (partialSize > max) tooLong();
    notify();
  };
  const onEnd = (): void => {
    ended = true;
    notify();
  };
  stream.on('data', onData);
  stream.once('end', onEnd);
  stream.once('close', onEnd);
  stream.once('error', onEnd);
  return {
    async next() {
      for (;;) {
        const line = lines.shift();
        // A line received under a higher limit is held to the current one.
        if (line !== undefined && Buffer.byteLength(line) > max) tooLong();
        else if (line !== undefined) return line;
        if (failure !== undefined) throw failure;
        if (ended) return null;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    limit(bytes) {
      max = bytes;
      if (failure === undefined && partialSize > max) {
        tooLong();
        // A pending next() waits for bytes the paused stream will not deliver.
        notify();
      }
    },
  };
}

type Json = Record<string, unknown>;

function parseObject(line: string): Json | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return isObject(value) ? value : null;
}

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isOptionalString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === 'string';
}

function isSession(v: unknown): v is string {
  return isString(v) && isSessionId(v);
}

function isTicketId(v: unknown): v is string {
  return isString(v) && TICKET_ID_PATTERN.test(v);
}

/** A request line, checked; null when it is malformed or of another protocol version. */
export function parseRequest(line: string): Request | null {
  const m = parseObject(line);
  if (m === null || m['v'] !== PROTOCOL_VERSION) return null;
  const v = PROTOCOL_VERSION;
  switch (m['op']) {
    case 'status':
      return { v, op: 'status' };
    case 'fields': {
      const { account, ref } = m;
      return isString(account) && isString(ref) ? { v, op: 'fields', account, ref } : null;
    }
    case 'issue_tickets': {
      const { account, accountLabel, ref, reason, count, session, agent } = m;
      if (!isString(account) || !isString(accountLabel) || !isString(ref) || !isString(reason)) return null;
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_TICKETS) return null;
      if (!isObject(session) || !isSession(session['id']) || !isOptionalString(session['title'])) return null;
      if (!isObject(agent) || !isString(agent['id']) || agent['id'] === '' || !isOptionalString(agent['type'])) return null;
      const title = session['title'];
      const type = agent['type'];
      return {
        v,
        op: 'issue_tickets',
        account,
        accountLabel,
        ref,
        reason,
        count,
        session: title === undefined ? { id: session['id'] } : { id: session['id'], title },
        agent: type === undefined ? { id: agent['id'] } : { id: agent['id'], type },
      };
    }
    case 'redeem': {
      const { ticket, session } = m;
      return isString(ticket) && isSession(session) ? { v, op: 'redeem', ticket, session } : null;
    }
    case 'mask': {
      const { session, tickets } = m;
      if (!isSession(session) || !Array.isArray(tickets) || !(tickets as unknown[]).every(isString) || !Object.hasOwn(m, 'output')) return null;
      return { v, op: 'mask', session, tickets: [...(tickets as string[])], output: m['output'] };
    }
    case 'release': {
      const { session, tickets } = m;
      if (!isSession(session) || !Array.isArray(tickets) || !(tickets as unknown[]).every(isString)) return null;
      return { v, op: 'release', session, tickets: [...(tickets as string[])] };
    }
    case 'end_session': {
      const { session } = m;
      return isSession(session) ? { v, op: 'end_session', session } : null;
    }
    default:
      return null;
  }
}

function parseField(v: unknown): FieldMeta | null {
  if (!isObject(v)) return null;
  const { id, title, sectionId, section, type, masked } = v;
  if (!isString(id) || !isString(title) || !isString(type) || typeof masked !== 'boolean') return null;
  if (!isOptionalString(sectionId) || !isOptionalString(section)) return null;
  const field: FieldMeta = { id, title, type, masked };
  if (sectionId !== undefined) field.sectionId = sectionId;
  if (section !== undefined) field.section = section;
  return field;
}

/** A response line to a request of `op`, checked; null when malformed or answering another op. */
export function parseResponse(line: string, op: Request['op']): Response | null {
  const m = parseObject(line);
  if (m === null) return null;
  if (m['ok'] === false) {
    const { code, message } = m;
    return FAILURE_CODES.includes(code as FailureCode) && isString(message) ? { ok: false, code: code as FailureCode, message } : null;
  }
  if (m['ok'] !== true || m['op'] !== op) return null;
  switch (op) {
    case 'status': {
      const { accounts, exitsAt } = m;
      if (!Array.isArray(accounts) || !isString(exitsAt)) return null;
      const list: { account: string; warm: boolean }[] = [];
      for (const a of accounts as unknown[]) {
        if (!isObject(a) || !isString(a['account']) || typeof a['warm'] !== 'boolean') return null;
        list.push({ account: a['account'], warm: a['warm'] });
      }
      return { ok: true, op, accounts: list, exitsAt };
    }
    case 'fields': {
      const { vault, item, fields } = m;
      if (!isString(vault) || !isObject(item) || !isString(item['title']) || !isString(item['category']) || !Array.isArray(fields)) return null;
      const list: FieldMeta[] = [];
      for (const f of fields as unknown[]) {
        const field = parseField(f);
        if (field === null) return null;
        list.push(field);
      }
      return { ok: true, op, vault, item: { title: item['title'], category: item['category'] }, fields: list };
    }
    case 'issue_tickets': {
      const { tickets, expiresAt, field } = m;
      if (!Array.isArray(tickets) || !(tickets as unknown[]).every(isTicketId) || !isString(expiresAt) || !isObject(field)) return null;
      const { vault, item, field: title, type, masked, short } = field;
      if (!isString(vault) || !isString(item) || !isString(title) || !isString(type)) return null;
      if (typeof masked !== 'boolean' || typeof short !== 'boolean') return null;
      return { ok: true, op, tickets: [...(tickets as string[])], expiresAt, field: { vault, item, field: title, type, masked, short } };
    }
    case 'redeem': {
      const value = m['value'];
      return isString(value) ? { ok: true, op, value } : null;
    }
    case 'mask': {
      const { known, changed, missing } = m;
      if (typeof known !== 'boolean' || typeof changed !== 'boolean' || !Object.hasOwn(m, 'output')) return null;
      if (!Array.isArray(missing) || !(missing as unknown[]).every(isString)) return null;
      return { ok: true, op, known, changed, output: m['output'], missing: [...(missing as string[])] };
    }
    case 'release': {
      const results = m['results'];
      if (!Array.isArray(results)) return null;
      const list: ReleaseResult[] = [];
      for (const r of results as unknown[]) {
        if (!isObject(r) || !isString(r['ticket'])) return null;
        const result = r['result'] as ReleaseResult['result'];
        if (!RELEASE_RESULTS.includes(result)) return null;
        list.push({ ticket: r['ticket'], result });
      }
      return { ok: true, op, results: list };
    }
    case 'end_session':
      return { ok: true, op };
  }
}

/** An acknowledgement line of the CLI; null for anything else, a closed stream included. */
export function parseAck(line: string | null): AckOp | null {
  if (line === null) return null;
  const m = parseObject(line);
  if (m === null || m['v'] !== PROTOCOL_VERSION) return null;
  const op = m['op'] as AckOp;
  return ACKS.includes(op) ? op : null;
}

export function encodeAck(op: AckOp): string {
  return encodeLine({ v: PROTOCOL_VERSION, op });
}
