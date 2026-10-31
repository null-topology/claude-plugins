/**
 * Tickets: one-use permissions to ask for one field's value, held only in the
 * broker's memory; a broker restart forgets them. A ticket holds the field's
 * ids and what the window shows, never a value.
 *
 * States: unused -> waiting (window queued or shown) -> sending (approved,
 * value on its way) -> received -> used. A deny burns a waiting ticket; the
 * TTL expires an unused or waiting one, and `release` voids it. A release
 * while sending or received marks the ticket `released` instead: it then ends
 * used or voided, never unused. A field gone at approve voids the ticket.
 * Anything else that ends a redeem gives the ticket back: unused while its
 * TTL holds, expired after. The TTL is not applied while sending or received.
 * An answer (approve or deny) at or after the TTL expires a waiting ticket,
 * also when its expiry timer has not run yet.
 *
 * Each transition applies only from its source states; from any other it
 * changes nothing and returns false. A ticket `forget` dropped moves no
 * further: every transition on it changes nothing and returns false.
 */

import { randomBytes } from 'node:crypto';
import type { Kind } from '../classify.ts';
import type { FailureCode } from '../protocol.ts';
import type { Attribute } from '../ref.ts';
import { TICKET_TTL_MS } from '../ticket-lifetime.ts';
import type { FieldTarget } from './lookup.ts';
import type { Clock } from './pool.ts';

export { TICKET_TTL_MS };

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** `tkt_` and 16 random lower-case base32 characters (256 is a multiple of 32, so each is uniform). */
export function newTicketId(random: (size: number) => Buffer = randomBytes): string {
  let id = 'tkt_';
  for (const byte of random(16)) id += BASE32.charAt(byte & 31);
  return id;
}

export type TicketState = 'unused' | 'waiting' | 'sending' | 'received' | 'used' | 'burned' | 'expired' | 'voided';

/** Why a waiting ticket left its window: the TTL, or `release` (or the session's end). */
export type Interrupt = 'expired' | 'voided';

export interface TicketSpec {
  session: string;
  agent: { id: string; type?: string | undefined };
  /** The account id, and the label the window shows. */
  account: string;
  accountLabel: string;
  target: FieldTarget;
  /** The reference's attribute, to classify the value fetched at approve. */
  attribute: Attribute | undefined;
  /** The classification at issue, shown in the window as a preview. */
  kind: Kind;
  reason: string;
  title?: string | undefined;
}

export interface Ticket extends TicketSpec {
  readonly id: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  state: TicketState;
  /** A `release` came while sending or received: the value must not be armed or sent after it. */
  released: boolean;
}

export interface TicketBook {
  issue(spec: TicketSpec, count: number): Ticket[];
  find(id: string): Ticket | undefined;
  /** Why a redeem of `t` cannot go to a window now (`unknown` once forgotten); undefined when it can. */
  refusal(t: Ticket): FailureCode | undefined;
  /** unused -> waiting; `onInterrupt` runs if the TTL or a release ends the wait. */
  wait(t: Ticket, onInterrupt: (why: Interrupt) => void): boolean;
  /** waiting -> burned; at or after the TTL -> expired instead, returning false. */
  deny(t: Ticket): boolean;
  /** waiting -> sending; at or after the TTL -> expired instead, returning false. */
  approve(t: Ticket): boolean;
  /** sending -> received. */
  receive(t: Ticket): boolean;
  /** received -> used. */
  deliver(t: Ticket): boolean;
  /** waiting, sending or received -> unused with its expiry re-armed, expired once the TTL has passed, voided once released. */
  giveBack(t: Ticket): boolean;
  /** Any state not final -> voided; a waiting ticket's listener hears `voided`. */
  voidTicket(t: Ticket): boolean;
  /** unused or waiting -> voided; sending or received -> marked released, `in_flight`; a final ticket is left as it is. */
  release(t: Ticket): 'voided' | 'in_flight' | 'not_voided';
  /** Drops the session's tickets (a waiting one hears `voided`); a dropped ticket moves no further. */
  forget(session: string): void;
  /** Whether any ticket is not final yet. */
  live(): boolean;
}

const FINAL: ReadonlySet<TicketState> = new Set(['used', 'burned', 'expired', 'voided']);

/** Unrefs a system timer, so an expiry alone never keeps the process alive; a fake clock's handle passes through. */
function unref(handle: unknown): unknown {
  if (typeof handle === 'object' && handle !== null && 'unref' in handle && typeof handle.unref === 'function') handle.unref();
  return handle;
}

export function createTicketBook(clock: Clock, newId: () => string = newTicketId): TicketBook {
  const tickets = new Map<string, Ticket>();
  const timers = new Map<string, unknown>();
  const interrupts = new Map<string, (why: Interrupt) => void>();

  function settle(t: Ticket, state: TicketState): void {
    t.state = state;
    if (state !== 'waiting') interrupts.delete(t.id);
    if (FINAL.has(state)) {
      clock.clearTimeout(timers.get(t.id));
      timers.delete(t.id);
    }
  }

  function interrupt(t: Ticket, why: Interrupt): void {
    const notify = interrupts.get(t.id);
    settle(t, why);
    notify?.(why);
  }

  /** Whether the book still holds `t`; one that `forget` dropped moves no further. */
  function held(t: Ticket): boolean {
    return tickets.get(t.id) === t;
  }

  function expire(t: Ticket): void {
    if (held(t) && (t.state === 'unused' || t.state === 'waiting')) interrupt(t, 'expired');
  }

  /** (Re)starts `t`'s expiry timer, replacing an earlier one. */
  function arm(t: Ticket, ms: number): void {
    clock.clearTimeout(timers.get(t.id));
    timers.set(t.id, unref(clock.setTimeout(() => expire(t), ms)));
  }

  /** Settles `t` to `to` when the book holds it and its state is one of `from`; whether it did. */
  function move(t: Ticket, from: readonly TicketState[], to: TicketState): boolean {
    if (!held(t) || !from.includes(t.state)) return false;
    settle(t, to);
    return true;
  }

  /** The user's answer: waiting -> `to`, or expired when it comes at or after the TTL, before the timer ran. */
  function answered(t: Ticket, to: TicketState): boolean {
    if (held(t) && t.state === 'waiting' && clock.now() >= t.expiresAt) {
      interrupt(t, 'expired');
      return false;
    }
    return move(t, ['waiting'], to);
  }

  return {
    issue(spec, count) {
      const issuedAt = clock.now();
      const out: Ticket[] = [];
      for (let i = 0; i < count; i++) {
        let id = newId();
        while (tickets.has(id)) id = newId();
        const t: Ticket = { ...spec, id, issuedAt, expiresAt: issuedAt + TICKET_TTL_MS, state: 'unused', released: false };
        tickets.set(id, t);
        arm(t, TICKET_TTL_MS);
        out.push(t);
      }
      return out;
    },
    find: (id) => tickets.get(id),
    refusal(t) {
      if (!held(t)) return 'unknown';
      if (t.state === 'unused' && clock.now() >= t.expiresAt) settle(t, 'expired');
      switch (t.state) {
        case 'unused':
          return undefined;
        case 'waiting':
        case 'sending':
        case 'received':
          return 'busy';
        case 'used':
        case 'burned':
          return 'used';
        case 'expired':
          return 'expired';
        case 'voided':
          return 'voided';
      }
    },
    wait(t, onInterrupt) {
      if (!move(t, ['unused'], 'waiting')) return false;
      interrupts.set(t.id, onInterrupt);
      return true;
    },
    deny: (t) => answered(t, 'burned'),
    approve: (t) => answered(t, 'sending'),
    receive: (t) => move(t, ['sending'], 'received'),
    deliver: (t) => move(t, ['received'], 'used'),
    giveBack(t) {
      if (!held(t)) return false;
      if (t.state !== 'waiting' && t.state !== 'sending' && t.state !== 'received') return false;
      if (t.released) {
        settle(t, 'voided');
        return true;
      }
      const left = t.expiresAt - clock.now();
      if (left <= 0) {
        settle(t, 'expired');
        return true;
      }
      settle(t, 'unused');
      // The timer may have fired while the ticket was in flight, before the clock reached expiresAt.
      arm(t, left);
      return true;
    },
    voidTicket(t) {
      if (!held(t) || FINAL.has(t.state)) return false;
      interrupt(t, 'voided');
      return true;
    },
    release(t) {
      if (!held(t)) return 'not_voided';
      if (t.state === 'sending' || t.state === 'received') {
        t.released = true;
        return 'in_flight';
      }
      if (t.state !== 'unused' && t.state !== 'waiting') return 'not_voided';
      interrupt(t, 'voided');
      return 'voided';
    },
    forget(session) {
      for (const t of [...tickets.values()]) {
        if (t.session !== session) continue;
        if (t.state === 'waiting') interrupt(t, 'voided');
        clock.clearTimeout(timers.get(t.id));
        timers.delete(t.id);
        interrupts.delete(t.id);
        tickets.delete(t.id);
      }
    },
    live: () => [...tickets.values()].some((t) => !FINAL.has(t.state)),
  };
}
