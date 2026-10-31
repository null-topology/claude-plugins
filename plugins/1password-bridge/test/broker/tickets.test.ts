import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TICKET_ID_PATTERN } from '../../src/protocol.ts';
import {
  createTicketBook,
  newTicketId,
  TICKET_TTL_MS,
  type Interrupt,
  type Ticket,
  type TicketBook,
  type TicketSpec,
  type TicketState,
} from '../../src/broker/tickets.ts';
import type { FieldTarget } from '../../src/broker/lookup.ts';
import { systemClock, type Clock } from '../../src/broker/pool.ts';
import { FakeClock } from './clock.ts';

const TARGET = {
  vaultId: 'v',
  vaultTitle: 'Deploy',
  itemId: 'i',
  itemTitle: 'Deploy server',
  category: 'Login',
  fieldId: 'f',
  fieldTitle: 'api token',
  sectionId: undefined,
  sectionTitle: undefined,
  fieldType: 'Concealed',
  attribute: undefined,
  notes: false,
} as FieldTarget;

const SPEC: TicketSpec = {
  session: 'session-0000-test',
  agent: { id: 'main' },
  account: 'example.1password.test',
  accountLabel: 'Work',
  target: TARGET,
  attribute: undefined,
  kind: { masked: true, short: false },
  reason: 'deploy',
};

function book() {
  const clock = new FakeClock();
  let n = 0;
  const tickets = createTicketBook(clock, () => `tkt_${String(n++).padStart(16, 'a')}`);
  return { clock, tickets };
}

function one(t: ReturnType<typeof book>['tickets']): Ticket {
  const [ticket] = t.issue(SPEC, 1);
  assert.ok(ticket !== undefined);
  return ticket;
}

describe('ticket ids', () => {
  test('tkt_ and 16 lower-case base32 characters', () => {
    for (let i = 0; i < 50; i++) assert.match(newTicketId(), TICKET_ID_PATTERN);
    assert.equal(newTicketId(() => Buffer.alloc(16, 0xff)), 'tkt_7777777777777777');
  });
});

describe('ticket book', () => {
  test('issue creates count independent unused tickets valid for 10 minutes', () => {
    const { clock, tickets } = book();
    clock.t = 5000;
    const issued = tickets.issue(SPEC, 3);
    assert.equal(new Set(issued.map((t) => t.id)).size, 3);
    for (const t of issued) {
      assert.equal(t.state, 'unused');
      assert.equal(t.released, false);
      assert.equal(t.expiresAt, 5000 + TICKET_TTL_MS);
      assert.equal(tickets.find(t.id), t);
    }
    assert.equal(tickets.live(), true);
  });

  test('unused -> waiting; a second redeem while waiting, sending or received is busy', () => {
    const { tickets } = book();
    const t = one(tickets);
    assert.equal(tickets.refusal(t), undefined);
    tickets.wait(t, () => {});
    assert.equal(tickets.refusal(t), 'busy');
    tickets.approve(t);
    assert.equal(t.state, 'sending');
    assert.equal(tickets.refusal(t), 'busy');
    tickets.receive(t);
    assert.equal(t.state, 'received');
    assert.equal(tickets.refusal(t), 'busy');
  });

  test('waiting + deny -> burned, answered as used', () => {
    const { tickets } = book();
    const t = one(tickets);
    tickets.wait(t, () => {});
    tickets.deny(t);
    assert.equal(t.state, 'burned');
    assert.equal(tickets.refusal(t), 'used');
  });

  test('received + delivered -> used', () => {
    const { tickets } = book();
    const t = one(tickets);
    tickets.wait(t, () => {});
    tickets.approve(t);
    tickets.receive(t);
    tickets.deliver(t);
    assert.equal(t.state, 'used');
    assert.equal(tickets.refusal(t), 'used');
    assert.equal(tickets.live(), false);
  });

  test('sending or received given back -> unused within the TTL, expired after it', async () => {
    const { clock, tickets } = book();
    const a = one(tickets);
    tickets.wait(a, () => {});
    tickets.approve(a);
    tickets.giveBack(a);
    assert.equal(a.state, 'unused');
    const b = one(tickets);
    tickets.wait(b, () => {});
    tickets.approve(b);
    tickets.receive(b);
    await clock.advance(TICKET_TTL_MS + 1);
    assert.equal(b.state, 'received', 'no expiry while received');
    tickets.giveBack(b);
    assert.equal(b.state, 'expired');
  });

  test('waiting + socket close -> unused', () => {
    const { tickets } = book();
    const t = one(tickets);
    tickets.wait(t, () => {});
    tickets.giveBack(t);
    assert.equal(t.state, 'unused');
  });

  test('unused or waiting + TTL -> expired; a waiting one is interrupted', async () => {
    const { clock, tickets } = book();
    const idle = one(tickets);
    const waiting = one(tickets);
    const seen: Interrupt[] = [];
    tickets.wait(waiting, (why) => seen.push(why));
    await clock.advance(TICKET_TTL_MS);
    assert.equal(idle.state, 'expired');
    assert.equal(waiting.state, 'expired');
    assert.deepEqual(seen, ['expired']);
    assert.equal(tickets.refusal(idle), 'expired');
  });

  test('unused or waiting + release -> voided; later states are not voided', () => {
    const { tickets } = book();
    const idle = one(tickets);
    const waiting = one(tickets);
    const seen: Interrupt[] = [];
    tickets.wait(waiting, (why) => seen.push(why));
    assert.equal(tickets.release(idle), 'voided');
    assert.equal(tickets.release(waiting), 'voided');
    assert.deepEqual(seen, ['voided']);
    assert.equal(tickets.refusal(idle), 'voided');
    const used = one(tickets);
    tickets.wait(used, () => {});
    tickets.approve(used);
    tickets.receive(used);
    tickets.deliver(used);
    assert.equal(tickets.release(used), 'not_voided');
    assert.equal(used.state, 'used');
  });

  test('field gone at approve voids the ticket', () => {
    const { tickets } = book();
    const t = one(tickets);
    tickets.wait(t, () => {});
    tickets.approve(t);
    tickets.voidTicket(t);
    assert.equal(t.state, 'voided');
    tickets.giveBack(t);
    assert.equal(t.state, 'voided', 'a final state stays final');
  });

  test('voiding a waiting ticket tells its window', () => {
    const { tickets } = book();
    const t = one(tickets);
    const seen: Interrupt[] = [];
    tickets.wait(t, (why) => seen.push(why));
    assert.equal(tickets.voidTicket(t), true);
    assert.deepEqual(seen, ['voided']);
    assert.equal(t.state, 'voided');
    assert.equal(tickets.approve(t), false);
    assert.equal(t.state, 'voided');
    assert.deepEqual(seen, ['voided'], 'the listener hears it once');
  });

  test('forget drops a session\'s tickets and interrupts a waiting one', () => {
    const { tickets } = book();
    const t = one(tickets);
    const other = tickets.issue({ ...SPEC, session: 'session-1111-test' }, 1)[0];
    const seen: Interrupt[] = [];
    tickets.wait(t, (why) => seen.push(why));
    tickets.forget('session-0000-test');
    assert.deepEqual(seen, ['voided']);
    assert.equal(tickets.find(t.id), undefined);
    assert.ok(other !== undefined && tickets.find(other.id) === other);
  });

  test('expiry timers on the system clock do not keep the process (or a test run) alive', () => {
    const handles: unknown[] = [];
    const clock: Clock = {
      ...systemClock,
      setTimeout: (fn, ms) => {
        const handle = systemClock.setTimeout(fn, ms);
        handles.push(handle);
        return handle;
      },
    };
    const tickets = createTicketBook(clock);
    const [given] = tickets.issue(SPEC, 2);
    assert.ok(given !== undefined);
    tickets.wait(given, () => {});
    tickets.approve(given);
    tickets.giveBack(given);
    assert.equal(handles.length, 3, 'a ticket given back is re-armed');
    for (const handle of handles) assert.equal((handle as NodeJS.Timeout).hasRef(), false);
    tickets.forget(SPEC.session);
  });
});

/** A FakeClock that also tracks the one-shot timers still pending. */
class TrackingClock extends FakeClock {
  readonly pending = new Set<unknown>();

  override setTimeout(fn: () => void, ms: number): unknown {
    const handle: unknown = super.setTimeout(() => {
      this.pending.delete(handle);
      fn();
    }, ms);
    this.pending.add(handle);
    return handle;
  }

  override clearTimeout(handle: unknown): void {
    this.pending.delete(handle);
    super.clearTimeout(handle);
  }
}

type Step = (b: TicketBook, t: Ticket, clock: FakeClock) => void;

/** How to reach each state through the book's own transitions. */
const REACH: Record<TicketState, Step> = {
  unused: () => {},
  waiting: (b, t) => b.wait(t, () => {}),
  sending: (b, t) => (b.wait(t, () => {}), b.approve(t)),
  received: (b, t) => (b.wait(t, () => {}), b.approve(t), b.receive(t)),
  used: (b, t) => (b.wait(t, () => {}), b.approve(t), b.receive(t), b.deliver(t)),
  burned: (b, t) => (b.wait(t, () => {}), b.deny(t)),
  // The fallback in `refusal`, so no timer has to fire.
  expired: (b, t, clock) => ((clock.t = t.expiresAt), b.refusal(t)),
  voided: (b, t) => b.release(t),
};

const STATES = Object.keys(REACH) as TicketState[];

/** Each transition, the states it applies from (section 8), and where it leads within the TTL. */
const TRANSITIONS: [string, (b: TicketBook, t: Ticket) => boolean, TicketState[], TicketState][] = [
  ['wait', (b, t) => b.wait(t, () => {}), ['unused'], 'waiting'],
  ['deny', (b, t) => b.deny(t), ['waiting'], 'burned'],
  ['approve', (b, t) => b.approve(t), ['waiting'], 'sending'],
  ['receive', (b, t) => b.receive(t), ['sending'], 'received'],
  ['deliver', (b, t) => b.deliver(t), ['received'], 'used'],
  ['giveBack', (b, t) => b.giveBack(t), ['waiting', 'sending', 'received'], 'unused'],
  ['voidTicket', (b, t) => b.voidTicket(t), ['unused', 'waiting', 'sending', 'received'], 'voided'],
];

describe('ticket transitions apply only from their source states', () => {
  for (const [name, apply, from, to] of TRANSITIONS) {
    for (const state of STATES) {
      const applies = from.includes(state);
      test(`${name} from ${state} ${applies ? `-> ${to}` : 'changes nothing'}`, () => {
        const { clock, tickets } = book();
        const t = one(tickets);
        REACH[state](tickets, t, clock);
        assert.equal(t.state, state);
        const before = { ...t };
        const live = tickets.live();
        const result = apply(tickets, t);
        if (applies) {
          assert.equal(result, true);
          assert.equal(t.state, to);
        } else {
          assert.equal(result, false);
          assert.deepEqual(t, before);
          assert.equal(tickets.live(), live);
        }
      });
    }
  }

  test('approve cannot revive a voided or expired ticket', () => {
    for (const state of ['voided', 'expired'] as const) {
      const { clock, tickets } = book();
      const t = one(tickets);
      REACH[state](tickets, t, clock);
      assert.equal(tickets.approve(t), false);
      assert.equal(t.state, state);
      assert.equal(tickets.refusal(t), state);
    }
  });

  test('a second wait keeps the first listener', () => {
    const { tickets } = book();
    const t = one(tickets);
    const seen: string[] = [];
    tickets.wait(t, (why) => seen.push(`first ${why}`));
    assert.equal(tickets.wait(t, (why) => seen.push(`second ${why}`)), false);
    tickets.release(t);
    assert.deepEqual(seen, ['first voided']);
  });
});

describe('ticket expiry', () => {
  test('the TTL firing while sending changes nothing; a give-back past it expires the ticket', async () => {
    const { clock, tickets } = book();
    const t = one(tickets);
    tickets.wait(t, () => {});
    tickets.approve(t);
    await clock.advance(TICKET_TTL_MS + 1);
    assert.equal(t.state, 'sending');
    assert.equal(tickets.refusal(t), 'busy');
    assert.equal(tickets.giveBack(t), true);
    assert.equal(t.state, 'expired');
    assert.equal(tickets.live(), false);
  });

  test('waiting given back past the TTL before its timer fired -> expired', () => {
    const { clock, tickets } = book();
    const t = one(tickets);
    tickets.wait(t, () => {});
    clock.t = t.expiresAt;
    assert.equal(tickets.giveBack(t), true);
    assert.equal(t.state, 'expired');
  });

  test('refusal settles an unused ticket past its TTL whose timer has not fired', () => {
    const { clock, tickets } = book();
    const t = one(tickets);
    clock.t = t.expiresAt - 1;
    assert.equal(tickets.refusal(t), undefined);
    clock.t = t.expiresAt;
    assert.equal(tickets.refusal(t), 'expired');
    assert.equal(t.state, 'expired');
    assert.equal(tickets.live(), false);
  });

  test('a ticket given back after its timer fired early is re-armed for the time left', async () => {
    const { clock, tickets } = book();
    const t = one(tickets);
    tickets.wait(t, () => {});
    tickets.approve(t);
    await clock.advance(TICKET_TTL_MS);
    assert.equal(t.state, 'sending');
    // The timer fired while the wall clock still read 1 s before expiresAt.
    clock.t = t.expiresAt - 1000;
    assert.equal(tickets.giveBack(t), true);
    assert.equal(t.state, 'unused');
    await clock.advance(999);
    assert.equal(t.state, 'unused');
    await clock.advance(1);
    assert.equal(t.state, 'expired');
    assert.equal(tickets.live(), false);
  });

  test('a released ticket in flight is not re-armed when given back', () => {
    const clock = new TrackingClock();
    const tickets = createTicketBook(clock);
    const [t] = tickets.issue(SPEC, 1);
    assert.ok(t !== undefined);
    tickets.wait(t, () => {});
    tickets.approve(t);
    tickets.release(t);
    tickets.giveBack(t);
    assert.equal(clock.pending.size, 0);
  });

  test('a give-back replaces the pending timer instead of adding one', async () => {
    const clock = new TrackingClock();
    const tickets = createTicketBook(clock);
    const [t] = tickets.issue(SPEC, 1);
    assert.ok(t !== undefined);
    await clock.advance(1000);
    tickets.wait(t, () => {});
    tickets.giveBack(t);
    assert.equal(clock.pending.size, 1);
    await clock.advance(TICKET_TTL_MS - 1001);
    assert.equal(t.state, 'unused');
    await clock.advance(1);
    assert.equal(t.state, 'expired');
    assert.equal(clock.pending.size, 0);
  });
});

describe('release of a ticket in flight', () => {
  for (const state of ['sending', 'received'] as const) {
    test(`${state} + release -> in_flight: marked released, state kept`, () => {
      const { clock, tickets } = book();
      const t = one(tickets);
      REACH[state](tickets, t, clock);
      assert.equal(tickets.release(t), 'in_flight');
      assert.equal(t.state, state);
      assert.equal(t.released, true);
      assert.equal(tickets.refusal(t), 'busy');
      assert.equal(tickets.release(t), 'in_flight', 'a second release changes nothing');
      assert.equal(t.state, state);
    });

    test(`${state}, released, given back -> voided, not unused`, () => {
      const { clock, tickets } = book();
      const t = one(tickets);
      REACH[state](tickets, t, clock);
      tickets.release(t);
      assert.equal(tickets.giveBack(t), true);
      assert.equal(t.state, 'voided');
      assert.equal(tickets.refusal(t), 'voided');
      assert.equal(tickets.live(), false);
    });
  }

  test('released given back past the TTL -> voided', async () => {
    const { clock, tickets } = book();
    const t = one(tickets);
    REACH.sending(tickets, t, clock);
    tickets.release(t);
    await clock.advance(TICKET_TTL_MS + 1);
    tickets.giveBack(t);
    assert.equal(t.state, 'voided');
  });

  test('released while sending, then received and delivered -> used', () => {
    const { clock, tickets } = book();
    const t = one(tickets);
    REACH.sending(tickets, t, clock);
    tickets.release(t);
    assert.equal(tickets.receive(t), true);
    assert.equal(tickets.deliver(t), true);
    assert.equal(t.state, 'used');
    assert.equal(t.released, true);
    assert.equal(tickets.release(t), 'not_voided');
  });

  test('a final ticket is not voided and not marked released', () => {
    for (const state of ['used', 'burned', 'expired', 'voided'] as const) {
      const { clock, tickets } = book();
      const t = one(tickets);
      REACH[state](tickets, t, clock);
      assert.equal(tickets.release(t), 'not_voided', state);
      assert.equal(t.state, state);
      assert.equal(t.released, false, state);
    }
  });
});

describe('an answer at or after the TTL', () => {
  for (const answer of ['approve', 'deny'] as const) {
    test(`${answer} at expiresAt, before the expiry timer ran -> expired; the listener hears it`, () => {
      const clock = new TrackingClock();
      const tickets = createTicketBook(clock);
      const [t] = tickets.issue(SPEC, 1);
      assert.ok(t !== undefined);
      const seen: Interrupt[] = [];
      tickets.wait(t, (why) => seen.push(why));
      clock.t = t.expiresAt;
      assert.equal(clock.pending.size, 1, 'the expiry timer has not run');
      assert.equal(tickets[answer](t), false);
      assert.equal(t.state, 'expired');
      assert.deepEqual(seen, ['expired']);
      assert.equal(tickets.refusal(t), 'expired');
      assert.equal(clock.pending.size, 0);
      assert.equal(tickets.live(), false);
    });

    test(`${answer} 1 ms before expiresAt still applies`, () => {
      const { clock, tickets } = book();
      const t = one(tickets);
      tickets.wait(t, () => {});
      clock.t = t.expiresAt - 1;
      assert.equal(tickets[answer](t), true);
      assert.equal(t.state, answer === 'approve' ? 'sending' : 'burned');
    });
  }
});

describe('a ticket the book no longer holds', () => {
  for (const state of ['unused', 'sending', 'received'] as const) {
    test(`forgotten while ${state}: no transition applies and no expiry is re-armed`, () => {
      const clock = new TrackingClock();
      const tickets = createTicketBook(clock);
      const [t] = tickets.issue(SPEC, 1);
      assert.ok(t !== undefined);
      REACH[state](tickets, t, clock);
      tickets.forget(SPEC.session);
      assert.equal(clock.pending.size, 0);
      const before = { ...t };
      for (const [name, apply] of TRANSITIONS) assert.equal(apply(tickets, t), false, name);
      assert.equal(tickets.release(t), 'not_voided');
      assert.equal(tickets.refusal(t), 'unknown');
      assert.deepEqual(t, before);
      assert.equal(clock.pending.size, 0, 'nothing armed an expiry timer');
      clock.t = t.expiresAt;
      assert.equal(tickets.refusal(t), 'unknown');
      assert.deepEqual(t, before, 'not settled as expired either');
      assert.equal(tickets.live(), false);
    });
  }
});
