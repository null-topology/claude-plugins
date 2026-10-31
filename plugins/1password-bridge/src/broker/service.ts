/**
 * The broker: one per user and protocol version, serving tickets (`issue_tickets`,
 * `redeem`, `release`), masks (`mask`), `end_session`, `fields` and `status`
 * on a Unix socket.
 *
 * Ownership. The socket path is the arbiter, checked by inode; there is no
 * lock file. A starting broker asks the socket for `status` and exits when a
 * broker answers. Otherwise it listens; on EADDRINUSE (a socket file nobody
 * answered on) it asks once more, then removes the file and listens again, at
 * most three times. It owns the path while the path still names the socket it
 * bound. The pool checks that before every SDK operation and a timer checks it
 * every 2 s. A broker that lost the path answers what is queued `displaced`,
 * lets running work settle and exits without removing the path, which belongs
 * to the new broker. It never closes its listening socket either: closing a
 * Unix socket server removes the path by name, whoever it now belongs to.
 *
 * Tickets and masks live only in this process. `issue_tickets` reads the
 * value only to classify it and drops it. A value leaves the broker only on
 * the `redeem` connection that the user approved: not to the window, the log,
 * the marker file or an error message.
 */

import { appendFileSync, chmodSync, lstatSync, mkdirSync, statSync, truncateSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { readBoard } from '../board.ts';
import { classify } from '../classify.ts';
import {
  encodeLine,
  lineReader,
  MAX_LINE_BYTES,
  MAX_OUTPUT_BYTES,
  parseAck,
  parseRequest,
  parseResponse,
  readLine,
  type Failure,
  type FailureCode,
  type LineReader,
  type ReleaseResult,
  type Request,
  type Response,
} from '../protocol.ts';
import { parseFieldRef, parseItemRef, RefError } from '../ref.ts';
import { markTicket, readSessionInfo, unmarkTickets } from '../session-files.ts';
import { FORGET_SCAN_MS, SESSION_FORGET_MS } from '../session-lifetime.ts';
import { PROTOCOL_VERSION } from '../version.ts';
import { attributeWaiting, ATTRIBUTION_WAIT_MS, RECHECK_MS } from './attribution.ts';
import { ticketApproval, type Answer, type Dialog } from './dialog.ts';
import { describeItem, fetchValue, resolveField, type FieldTarget } from './lookup.ts';
import { createMaskBook } from './masks.ts';
import type { AccountClient } from './onepassword.ts';
import { createPool, mapError, systemClock, type Clock } from './pool.ts';
import { createTicketBook, type Interrupt } from './tickets.ts';

export const WATCH_INTERVAL_MS = 2000;
export const PROBE_TIMEOUT_MS = 1000;
export const STUCK_EXIT_MS = 1000;
/** How long a connection may take to send its request line. */
export const REQUEST_READ_TIMEOUT_MS = 30_000;
/** A session without a ticket or mask request for this long is forgotten. */
export { SESSION_FORGET_MS };
/** How often the broker looks for sessions to forget, at most. */
export { FORGET_SCAN_MS };
const LISTEN_ATTEMPTS = 3;

export type LogDetail = Record<string, string | number | boolean>;

export interface BrokerOptions {
  socketPath: string;
  /** The plugin's state directory; the broker writes the sessions' `masked` markers there. */
  stateDir: string;
  connect(account: string): Promise<AccountClient>;
  dialog: Dialog;
  /** The window language (`OP_BRIDGE_LANGUAGE`). */
  lang?: string | undefined;
  /**
   * Drop the 1Password clients this long after the last `fields`, `issue_tickets`
   * or `redeem`, unless a 1Password operation is running; an open window does not
   * defer the drop. Exit then as well when no connection is open and no session
   * holds a live ticket or a mask.
   */
  idleMs: number;
  /** Forget a session after this long without a ticket or mask request; SESSION_FORGET_MS by default. */
  sessionForgetMs?: number;
  exit(code: number): void;
  /** One log line; callers pass codes and counts, never values. */
  log(event: string, detail?: LogDetail): void;
  clock?: Clock;
  watchMs?: number;
  probeTimeoutMs?: number;
  stuckExitMs?: number;
  operationTimeoutMs?: number;
  /** How long a redeem waits for the board to attribute it (30 s). */
  attributionWaitMs?: number;
  /** How often a waiting redeem reads the board again (500 ms). */
  recheckMs?: number;
}

export interface Broker {
  server: Server;
  owns(): boolean;
}

type RequestOf<K extends Request['op']> = Extract<Request, { op: K }>;

function fail(code: FailureCode, message: string): Failure {
  return { ok: false, code, message };
}

function errno(err: unknown): unknown {
  return err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
}

/** Whether a broker answers `status` on `path` within `timeoutMs`. */
export function probe(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const socket = connect(path);
    const finish = (answered: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answered);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('error', () => finish(false));
    socket.once('connect', () => {
      socket.write(encodeLine({ v: PROTOCOL_VERSION, op: 'status' }));
      readLine(socket).then(
        (line) => finish(line !== null && parseResponse(line, 'status') !== null),
        () => finish(false),
      );
    });
  });
}

/** Creates the socket directory 0700 and refuses one that is not a directory of this user. */
function prepareRunDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) {
    throw new Error(`The socket directory ${dir} is not a directory owned by this user`);
  }
  chmodSync(dir, 0o700);
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

export const DEFAULT_IDLE_MINUTES = 60;
export const MAX_BROKER_LOG_BYTES = 1024 * 1024;

/** The idle window from `OP_BRIDGE_IDLE_MINUTES`; a missing or non-positive value gives 60 minutes. */
export function idleWindowMs(value: string | undefined): number {
  const minutes = value === undefined || value.trim() === '' ? Number.NaN : Number(value);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_IDLE_MINUTES) * 60_000;
}

export function brokerLogPath(stateDir: string): string {
  return join(stateDir, 'log', 'broker.log');
}

/**
 * The broker's logger: one JSON line per event in `<stateDir>/log/broker.log`,
 * cut back to nothing at start once it passes 1 MB. Callers pass codes and
 * counts only; writing never throws.
 */
export function openBrokerLog(stateDir: string): (event: string, detail?: LogDetail) => void {
  const path = brokerLogPath(stateDir);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (statSync(path).size > MAX_BROKER_LOG_BYTES) truncateSync(path, 0);
  } catch {
    // No log yet, or no log directory: logging is best effort.
  }
  return (event, detail) => {
    try {
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`, { mode: 0o600 });
      chmodSync(path, 0o600);
    } catch {
      // Logging is best effort.
    }
  };
}

function displayType(target: FieldTarget): string {
  return target.attribute === undefined ? target.fieldType : `${target.fieldType} (${target.attribute})`;
}

/** What a refused redeem tells the agent, by code. */
const REFUSALS: Partial<Record<FailureCode, string>> = {
  unknown: 'No such ticket (never issued, or the broker restarted); call issue_tickets for a new one',
  not_owner: 'Another session or another agent holds this ticket; a subagent issues its own tickets',
  busy: 'The ticket is already waiting for an answer, or its value is being sent',
  used: 'The ticket was already used or denied; call issue_tickets for a new one',
  voided: 'The ticket was released or voided; call issue_tickets for a new one',
  expired: 'The ticket expired after 10 minutes; call issue_tickets for a new one',
  other_agent: 'Another agent of this session kept running commands for 30 s; retry when it is done',
  no_command: "No command of the ticket's agent is running; redeem inside the command that needs the value",
};

function refused(code: FailureCode): Failure {
  return fail(code, REFUSALS[code] ?? code);
}

/**
 * Starts the broker on `options.socketPath`. Resolves null, after calling
 * `exit(0)`, when another broker already serves; rejects when the path cannot
 * be taken.
 */
export async function startBroker(options: BrokerOptions): Promise<Broker | null> {
  const path = options.socketPath;
  const probeMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const log = (event: string, detail?: LogDetail): void => {
    try {
      options.log(event, detail);
    } catch {
      // Logging is best effort.
    }
  };

  prepareRunDir(dirname(path));
  const alreadyServed = (): null => {
    log('start', { result: 'already-served' });
    options.exit(0);
    return null;
  };
  if (await probe(path, probeMs)) return alreadyServed();

  let refusal: Failure | undefined;
  let active = 0;
  let exiting = false;
  let lastActivity = Date.now();
  let idleTimer: NodeJS.Timeout | undefined;
  let watch: NodeJS.Timeout | undefined;
  let sweep: unknown;

  const server = createServer((socket) => void serve(socket));
  for (let attempt = 1; ; attempt++) {
    try {
      await listen(server, path);
      break;
    } catch (err) {
      if (errno(err) !== 'EADDRINUSE' || attempt >= LISTEN_ATTEMPTS) throw err;
      if (await probe(path, probeMs)) return alreadyServed();
      try {
        unlinkSync(path);
      } catch (unlinkErr) {
        if (errno(unlinkErr) !== 'ENOENT') throw unlinkErr;
      }
    }
  }
  chmodSync(path, 0o600);
  const bound = statSync(path);
  const owns = (): boolean => {
    try {
      const now = statSync(path);
      return now.ino === bound.ino && now.dev === bound.dev;
    } catch {
      return false;
    }
  };

  const pool = createPool({
    connect: options.connect,
    owns,
    onStuck,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.operationTimeoutMs === undefined ? {} : { operationTimeoutMs: options.operationTimeoutMs }),
  });
  const clock = options.clock ?? systemClock;
  const book = createTicketBook(clock);
  const masks = createMaskBook();
  /** When each session last made a ticket or mask request. */
  const seen = new Map<string, number>();

  function noteSession(id: string): void {
    seen.set(id, clock.now());
  }

  function finish(reason: string, code: number, closeServer: boolean): void {
    if (exiting) return;
    exiting = true;
    clearInterval(watch);
    clock.clearInterval(sweep);
    clearTimeout(idleTimer);
    options.dialog.close();
    pool.close();
    // Closing removes the path by name, so only a broker that still owns it closes.
    if (closeServer && owns()) server.close();
    log('exit', { reason, code });
    options.exit(code);
  }

  function displaced(): void {
    if (refusal !== undefined || exiting) return;
    refusal = fail('displaced', 'Another broker took over the socket');
    log('displaced');
    // The new broker shows its own windows; an answer here would be thrown away.
    options.dialog.close();
    pool.abort('displaced', refusal.message);
    if (active === 0) finish('displaced', 0, false);
  }

  function onStuck(): void {
    if (exiting) return;
    refusal ??= fail('auth_timeout', '1Password did not answer in time; the next request starts a new broker');
    log('stuck');
    // A window process would outlive this one and overlap the next broker's window.
    options.dialog.close();
    pool.abort(refusal.code, refusal.message);
    clearInterval(watch);
    clock.clearInterval(sweep);
    clearTimeout(idleTimer);
    if (owns()) server.close();
    setTimeout(() => finish('stuck', 1, false), options.stuckExitMs ?? STUCK_EXIT_MS);
  }

  const forgetMs = options.sessionForgetMs ?? SESSION_FORGET_MS;

  /** Forgets sessions that made no ticket or mask request for `forgetMs`. */
  function forgetQuiet(): void {
    const now = clock.now();
    for (const [id, at] of seen) {
      if (now - at <= forgetMs) continue;
      book.forget(id);
      masks.forget(id);
      seen.delete(id);
    }
  }

  function armIdle(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (exiting || refusal !== undefined) return;
      // Only a 1Password operation in flight defers the drop; an open window or a stalled delivery does not (§10).
      if (pool.busy()) {
        armIdle();
        return;
      }
      // The idle window ends 1Password access; a fetch approved later connects (and asks for Touch ID) again.
      pool.drop();
      // The process stays while a connection is open or a ticket or a mask lives.
      if (active > 0 || book.live() || masks.any()) armIdle();
      else finish('idle', 0, true);
    }, options.idleMs);
    idleTimer.unref();
  }

  function touch(): void {
    lastActivity = Date.now();
    armIdle();
  }

  async function fields(req: RequestOf<'fields'>): Promise<Response> {
    const ref = parseItemRef(req.ref);
    const described = await pool.run(req.account, (client) => describeItem(client, ref));
    return { ok: true, op: 'fields', ...described };
  }

  async function issueTickets(req: RequestOf<'issue_tickets'>): Promise<Response> {
    // A failed or still pending issue is activity of the session as well (§9).
    noteSession(req.session.id);
    const ref = parseFieldRef(req.ref);
    const { target, value } = await pool.run(req.account, (client) => resolveField(client, ref));
    // The value is read only to classify it; it is dropped here.
    const kind = classify({ fieldType: target.fieldType, attribute: ref.attribute, notes: target.notes, value });
    const issued = book.issue(
      {
        session: req.session.id,
        agent: req.agent,
        account: req.account,
        accountLabel: req.accountLabel,
        target,
        attribute: ref.attribute,
        kind,
        reason: req.reason,
        title: req.session.title,
      },
      req.count,
    );
    const first = issued[0];
    if (first === undefined) return fail('internal', 'No ticket was issued');
    return {
      ok: true,
      op: 'issue_tickets',
      tickets: issued.map((t) => t.id),
      expiresAt: new Date(first.expiresAt).toISOString(),
      field: { vault: target.vaultTitle, item: target.itemTitle, field: target.fieldTitle, type: displayType(target), masked: kind.masked, short: kind.short },
    };
  }

  function release(req: RequestOf<'release'>): Response {
    noteSession(req.session);
    const results: ReleaseResult[] = [];
    const found = [...new Set(req.tickets)].map((id) => ({ id, t: book.find(id) }));
    const unmark = found.filter(({ t }) => t === undefined || t.session === req.session).map(({ id }) => id);
    // The masks go in any state (§5), before the book is asked: a ticket in flight keeps no mask either.
    // They go as one set, so a value the call's tickets alone held is unmasked for each of them.
    const dropped = masks.drop(req.session, unmark);
    for (const { id, t } of found) {
      if (t !== undefined && t.session !== req.session) {
        results.push({ ticket: id, result: 'not_owner' });
        continue;
      }
      // `mask_kept` only when every value the ticket held stays masked under a ticket outside the call.
      const drop = dropped.get(id) ?? 'none';
      const maskResult = drop === 'none' ? undefined : drop === 'kept' ? 'mask_kept' : 'unmasked';
      if (t === undefined) {
        results.push({ ticket: id, result: maskResult ?? 'unknown' });
        continue;
      }
      // `voided` or `in_flight` (sending or received: the ticket ends used or voided, never unused, §8).
      const released = book.release(t);
      if (released === 'not_voided') results.push({ ticket: id, result: maskResult ?? 'final' });
      else results.push({ ticket: id, result: released });
    }
    // Also for ids this broker never knew (a restart): the marker must not outlive the masks.
    try {
      unmarkTickets(options.stateDir, req.session, unmark);
    } catch {
      log('marker', { result: 'unmark-failed' });
    }
    return { ok: true, op: 'release', results };
  }

  function mask(req: RequestOf<'mask'>): Response {
    noteSession(req.session);
    // Every id in the session's marker must still have its mask here. After a restart the broker forgot the
    // values of earlier tickets; masking only the later ones would let the earlier values through (§9).
    // `missing` names only those ids: releasing one whose mask is still held here would lift a live mask.
    const missing = [...new Set(req.tickets)].filter((id) => !masks.holds(req.session, id));
    if (missing.length > 0) return { ok: true, op: 'mask', known: false, changed: false, output: null, missing };
    try {
      const { known, changed, output } = masks.apply(req.session, req.output);
      return { ok: true, op: 'mask', known, changed, output: changed ? output : null, missing: [] };
    } catch {
      // A pattern build error can quote a needle, so neither the answer nor the log carries the error text (§18).
      log('mask', { result: 'internal' });
      return fail('internal', 'The broker could not apply the masks');
    }
  }

  function endSession(req: RequestOf<'end_session'>): Response {
    book.forget(req.session);
    masks.forget(req.session);
    seen.delete(req.session);
    return { ok: true, op: 'end_session' };
  }

  /** The broker's refusal now; a function, so a check after an `await` is not narrowed by one before it. */
  function brokerRefusal(): Failure | undefined {
    return refusal;
  }

  /**
   * One redeem on its own connection (§6-§9): the ticket's session, the board's attribution, the
   * window, the value fetched again, the marker and the mask, the value, then the CLI's `received`
   * and `delivered`. Answers on `socket` itself and resolves the code it logs. Every exit after
   * the window opened leaves the ticket burned, used, voided, expired, or given back.
   */
  async function redeem(req: RequestOf<'redeem'>, socket: Socket, lines: LineReader): Promise<string> {
    const answer = (res: Response): string => {
      socket.end(encodeLine(res));
      return res.ok ? 'ok' : res.code;
    };
    noteSession(req.session);
    const ticket = book.find(req.ticket);
    if (ticket === undefined) return answer(refused('unknown'));
    if (ticket.session !== req.session) return answer(refused('not_owner'));
    const early = book.refusal(ticket);
    if (early !== undefined) return answer(refused(early));

    const closed = new AbortController();
    socket.once('close', () => closed.abort());
    // A CLI that went away before this listener existed fires no `close` again.
    if (socket.destroyed) closed.abort();
    const verdict = await attributeWaiting(
      () => readBoard(options.stateDir, ticket.session, Date.now()),
      ticket.agent.id,
      ticket.id,
      clock,
      closed.signal,
      options.attributionWaitMs ?? ATTRIBUTION_WAIT_MS,
      options.recheckMs ?? RECHECK_MS,
    );
    if (verdict === null) return 'closed';

    // What happened to the ticket or the broker during the wait comes before what the board said.
    // `end_session` drops the session's tickets from the book; a dropped ticket is never served.
    const forgotten = (): boolean => book.find(ticket.id) !== ticket;
    if (forgotten()) return answer(refused('unknown'));
    const late = book.refusal(ticket);
    if (late !== undefined) return answer(refused(late));
    const stoppedEarly = brokerRefusal();
    if (stoppedEarly !== undefined) return answer({ ...stoppedEarly });
    if (verdict.kind !== 'attributed') return answer(refused(verdict.code));

    // A transition that did not apply: the ticket left the state this redeem expected.
    const moved = (): string => answer(refused(forgotten() ? 'unknown' : (book.refusal(ticket) ?? 'busy')));
    const releasedInFetch = (): Failure =>
      fail('voided', 'The ticket was released while its value was fetched; nothing was sent');
    const sessionEnded = (): Failure => fail('voided', 'The session ended while the value was fetched; nothing was sent');

    const shown = new AbortController();
    let interrupted = undefined as Interrupt | undefined;
    const waiting = book.wait(ticket, (why) => {
      interrupted = why;
      shown.abort();
    });
    if (!waiting) return moved();
    try {
      const onClose = (): void => shown.abort();
      closed.signal.addEventListener('abort', onClose, { once: true });
      touch();
      let choice: Answer;
      try {
        choice = await options.dialog.ask(
          ticketApproval(
            {
              session: { id: ticket.session, title: ticket.title, startDir: readSessionInfo(options.stateDir, ticket.session).cwd },
              agent: ticket.agent,
              account: ticket.accountLabel,
              vault: ticket.target.vaultTitle,
              item: ticket.target.itemTitle,
              category: ticket.target.category,
              section: ticket.target.sectionTitle,
              field: ticket.target.fieldTitle,
              fieldType: displayType(ticket.target),
              kind: ticket.kind,
              ticket: ticket.id,
              reason: ticket.reason,
              commands: verdict.commands,
            },
            options.lang,
          ),
          shown.signal,
        );
      } finally {
        // Also when the window throws: the per-redeem close signal keeps no listener of this window.
        closed.signal.removeEventListener('abort', onClose);
      }

      // The TTL or a release already moved the ticket to its final state.
      if (interrupted !== undefined) return answer(refused(interrupted));
      if (closed.signal.aborted) {
        book.giveBack(ticket);
        return 'closed';
      }
      // Read again: `displaced` or `onStuck` may have set it while the window was open.
      const stopped = brokerRefusal();
      if (stopped !== undefined) {
        book.giveBack(ticket);
        return answer({ ...stopped });
      }
      if (choice === 'deny') {
        if (!book.deny(ticket)) return moved();
        return answer(fail('denied', 'The user denied the request; the ticket is burned'));
      }
      if (choice !== 'approve') {
        book.giveBack(ticket);
        return answer(
          fail('no_dialog', 'No approval window can be shown on this host (macOS needs osascript, Linux needs zenity)'),
        );
      }
      if (!book.approve(ticket)) return moved();

      let value: string;
      try {
        value = await pool.run(ticket.account, (client) => fetchValue(client, ticket.target));
      } catch (err) {
        const failure = mapError(err);
        if (failure.code === 'displaced') displaced();
        if (forgotten()) return answer(sessionEnded());
        if (ticket.released) {
          book.voidTicket(ticket);
          return answer(releasedInFetch());
        }
        if (failure.code === 'not_found') {
          // The item or the field is gone: no later redeem of this ticket can succeed (§8, §17).
          book.voidTicket(ticket);
          return answer(fail('field_gone', `${failure.message}; the ticket is voided`));
        }
        book.giveBack(ticket);
        return answer(fail(failure.code, failure.message));
      } finally {
        touch();
      }
      if (forgotten()) return answer(sessionEnded());
      if (ticket.released) {
        book.voidTicket(ticket);
        return answer(releasedInFetch());
      }

      // The marker and the mask go first: the value must not leave unmasked (§9).
      const kind = classify({ fieldType: ticket.target.fieldType, attribute: ticket.attribute, notes: ticket.target.notes, value });
      if (kind.masked) {
        try {
          markTicket(options.stateDir, ticket.session, ticket.id);
        } catch {
          book.giveBack(ticket);
          log('marker', { result: 'mark-failed' });
          return answer(fail('internal', 'The mask marker could not be written; nothing was sent'));
        }
        masks.arm(ticket.session, ticket.id, ticket.issuedAt, value);
      }
      if (closed.signal.aborted) {
        book.giveBack(ticket);
        return 'closed';
      }
      socket.write(encodeLine({ ok: true, op: 'redeem', value }));

      const received = parseAck(await lines.next().catch(() => null));
      if (received !== 'received') {
        book.giveBack(ticket);
        socket.destroy();
        return 'not_received';
      }
      // A ticket `end_session` dropped moves no further in the book; its exchange still ends in order.
      if (!book.receive(ticket) && !forgotten()) {
        socket.destroy();
        return 'not_applied';
      }
      const delivered = parseAck(await lines.next().catch(() => null));
      let result: string;
      if (forgotten()) {
        result = 'session_ended';
      } else if (delivered !== 'delivered') {
        book.giveBack(ticket);
        result = 'not_delivered';
      } else {
        result = book.deliver(ticket) ? 'ok' : 'not_applied';
      }
      socket.end();
      return result;
    } catch (err) {
      // Whatever failed, a ticket still waiting, sending or received goes back (§8).
      book.giveBack(ticket);
      throw err;
    }
  }

  async function handle(req: Request): Promise<Response> {
    if (refusal !== undefined) return { ...refusal };
    switch (req.op) {
      case 'status':
        return { ok: true, op: 'status', accounts: pool.accounts(), exitsAt: new Date(lastActivity + options.idleMs).toISOString() };
      case 'release':
        return release(req);
      case 'mask':
        return mask(req);
      case 'end_session':
        return endSession(req);
      case 'redeem':
        return fail('internal', `${req.op} is not served here`);
      default:
        break;
    }
    touch();
    try {
      return req.op === 'fields' ? await fields(req) : await issueTickets(req);
    } catch (err) {
      const failure = err instanceof RefError ? { code: 'bad_ref' as const, message: err.message } : mapError(err);
      if (failure.code === 'displaced') displaced();
      return fail(failure.code, failure.message);
    } finally {
      touch();
    }
  }

  async function serve(socket: Socket): Promise<void> {
    socket.on('error', () => {});
    active += 1;
    try {
      socket.setTimeout(REQUEST_READ_TIMEOUT_MS, () => socket.destroy());
      // A `mask` request carries a Bash command's output, up to 64 MiB; every other line stays under 1 MiB.
      const lines = lineReader(socket, MAX_OUTPUT_BYTES);
      let line: string | null;
      try {
        line = await lines.next();
      } catch {
        line = null;
      }
      socket.setTimeout(0);
      if (line === null) {
        socket.destroy();
        return;
      }
      const req = parseRequest(line);
      if (req?.op !== 'mask' && Buffer.byteLength(line) > MAX_LINE_BYTES) {
        log('request', { op: req?.op ?? 'malformed', result: 'too_long' });
        socket.destroy();
        return;
      }
      // The CLI's acknowledgements on a redeem connection are short lines.
      lines.limit(MAX_LINE_BYTES);
      if (req?.op === 'redeem' && refusal === undefined) {
        let result: string;
        try {
          result = await redeem(req, socket, lines);
        } catch {
          // The error can carry a path or a value fragment; the answer and the log carry a fixed text (§18).
          if (!socket.destroyed && !socket.writableEnded) {
            socket.end(encodeLine(fail('internal', 'The broker could not serve this redeem')));
          }
          result = 'internal';
        }
        log('request', { op: 'redeem', result });
        return;
      }
      let response: Response;
      try {
        response = req === null ? fail('internal', 'Malformed request') : await handle(req);
      } catch {
        response = fail('internal', 'The broker could not serve this request');
      }
      log('request', { op: req?.op ?? 'malformed', result: response.ok ? 'ok' : response.code });
      socket.end(encodeLine(response));
    } finally {
      active -= 1;
      if (refusal?.code === 'displaced' && active === 0) finish('displaced', 0, false);
    }
  }

  watch = setInterval(() => {
    if (!owns()) displaced();
  }, options.watchMs ?? WATCH_INTERVAL_MS);
  watch.unref();
  // Its own timer: other sessions' requests reset the idle window and must not keep a quiet session's masks (§9).
  // The system clock's intervals are unref'd, so the sweep never keeps the process alive.
  sweep = clock.setInterval(forgetQuiet, Math.min(forgetMs, FORGET_SCAN_MS));
  armIdle();
  log('start', { result: 'listening' });
  return { server, owns };
}
