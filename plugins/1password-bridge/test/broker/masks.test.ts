import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMaskBook, type DropResult, type MaskBook } from '../../src/broker/masks.ts';

const S = 'session-0000-test';
const S2 = 'session-2222-test';
const VALUE = 'synthetic-api-token-value';
const ALPHA = 'fake-secret-alpha-123';
const BRAVO = 'fake-secret-bravo-456';
const A = 'tkt_aaaaaaaaaaaaaaaa';
const B = 'tkt_bbbbbbbbbbbbbbbb';
const C = 'tkt_cccccccccccccccc';

const dropOne = (masks: MaskBook, session: string, ticket: string): DropResult | undefined => masks.drop(session, [ticket]).get(ticket);

describe('mask book', () => {
  test('a session without masks is unknown and its output is untouched', () => {
    const masks = createMaskBook();
    assert.deepEqual(masks.apply(S, { stdout: VALUE }), { known: false, changed: false, output: { stdout: VALUE } });
    assert.equal(masks.any(), false);
  });

  test('an armed value is replaced in every string of the output', () => {
    const masks = createMaskBook();
    masks.arm(S, A, 1, VALUE);
    assert.deepEqual(masks.apply(S, { stdout: `token=${VALUE}`, lines: [VALUE], code: 0 }), {
      known: true,
      changed: true,
      output: { stdout: `token=<masked ticket=${A}>`, lines: [`<masked ticket=${A}>`], code: 0 },
    });
    assert.deepEqual(masks.apply('session-1111-test', VALUE), { known: false, changed: false, output: VALUE });
  });

  test('one value from two tickets is one mask, labelled with the earliest, dropped with the last', () => {
    const masks = createMaskBook();
    masks.arm(S, B, 2, VALUE);
    masks.arm(S, A, 1, VALUE);
    assert.equal(masks.apply(S, VALUE).output, `<masked ticket=${A}>`);
    assert.equal(dropOne(masks, S, A), 'kept');
    assert.equal(masks.apply(S, VALUE).output, `<masked ticket=${B}>`);
    assert.equal(dropOne(masks, S, B), 'unmasked');
    assert.equal(dropOne(masks, S, B), 'none');
    assert.deepEqual(masks.apply(S, VALUE), { known: false, changed: false, output: VALUE });
  });

  test('a ticket holding two values: unmasked when either is left without a holder, kept only when both stay held', () => {
    const mixed = createMaskBook();
    mixed.arm(S, A, 1, ALPHA);
    mixed.arm(S, A, 1, BRAVO);
    mixed.arm(S, B, 2, ALPHA);
    assert.equal(dropOne(mixed, S, A), 'unmasked', 'BRAVO lost its last holder');
    assert.deepEqual(mixed.apply(S, { old: ALPHA, new: BRAVO }).output, { old: `<masked ticket=${B}>`, new: BRAVO });

    const covered = createMaskBook();
    covered.arm(S, A, 1, ALPHA);
    covered.arm(S, A, 1, BRAVO);
    covered.arm(S, B, 2, ALPHA);
    covered.arm(S, B, 2, BRAVO);
    assert.equal(dropOne(covered, S, A), 'kept');
    assert.deepEqual(covered.apply(S, { old: ALPHA, new: BRAVO }).output, { old: `<masked ticket=${B}>`, new: `<masked ticket=${B}>` });
  });

  test('tickets dropped as one set: a value only they held is unmasked for each; a holder outside the set keeps it', () => {
    const together = createMaskBook();
    together.arm(S, A, 1, VALUE);
    together.arm(S, B, 2, VALUE);
    assert.deepEqual(together.drop(S, [A, B, C]), new Map([[A, 'unmasked'], [B, 'unmasked'], [C, 'none']]));
    assert.deepEqual(together.apply(S, VALUE), { known: false, changed: false, output: VALUE });
    assert.equal(together.any(), false);

    const outside = createMaskBook();
    outside.arm(S, A, 1, VALUE);
    outside.arm(S, B, 2, VALUE);
    outside.arm(S, C, 3, VALUE);
    assert.deepEqual(outside.drop(S, [A, B]), new Map([[A, 'kept'], [B, 'kept']]));
    assert.equal(outside.apply(S, VALUE).output, `<masked ticket=${C}>`);
  });

  test('forget drops the session\'s masks', () => {
    const masks = createMaskBook();
    masks.arm(S, A, 1, VALUE);
    masks.forget(S);
    assert.equal(masks.any(), false);
    assert.equal(masks.apply(S, VALUE).known, false);
  });

  test('holds answers per ticket and session', () => {
    const masks = createMaskBook();
    masks.arm(S, A, 1, VALUE);
    assert.equal(masks.holds(S, A), true);
    assert.equal(masks.holds(S, B), false);
    assert.equal(masks.holds('session-1111-test', A), false);
    dropOne(masks, S, A);
    assert.equal(masks.holds(S, A), false);
  });

  test('two values under two tickets are each masked with their own ticket label', () => {
    const masks = createMaskBook();
    masks.arm(S, A, 1, ALPHA);
    masks.arm(S, B, 2, BRAVO);
    assert.deepEqual(masks.apply(S, { stdout: `${ALPHA} ${BRAVO}`, lines: [BRAVO, ALPHA] }), {
      known: true,
      changed: true,
      output: {
        stdout: `<masked ticket=${A}> <masked ticket=${B}>`,
        lines: [`<masked ticket=${B}>`, `<masked ticket=${A}>`],
      },
    });
    dropOne(masks, S, A);
    assert.deepEqual(masks.apply(S, `${ALPHA} ${BRAVO}`), {
      known: true,
      changed: true,
      output: `${ALPHA} <masked ticket=${B}>`,
    });
  });

  test('a session with masks reports output without a secret as known and unchanged', () => {
    const masks = createMaskBook();
    masks.arm(S, A, 1, ALPHA);
    const output = { stdout: 'nothing secret here', lines: ['plain line'], code: 0 };
    const result = masks.apply(S, output);
    assert.deepEqual(result, { known: true, changed: false, output: { stdout: 'nothing secret here', lines: ['plain line'], code: 0 } });
    assert.equal(result.output, output);
  });

  test('any is false before arm, true while a mask is held, false after the last drop or forget', () => {
    const masks = createMaskBook();
    assert.equal(masks.any(), false);
    masks.arm(S, A, 1, ALPHA);
    masks.arm(S, B, 2, BRAVO);
    assert.equal(masks.any(), true);
    dropOne(masks, S, A);
    assert.equal(masks.any(), true);
    dropOne(masks, S, B);
    assert.equal(masks.any(), false);
    masks.arm(S, A, 3, ALPHA);
    assert.equal(masks.any(), true);
    masks.forget(S);
    assert.equal(masks.any(), false);
  });

  test('one ticket armed with a rotated value keeps both values masked until it is dropped', () => {
    const masks = createMaskBook();
    masks.arm(S, A, 1, ALPHA);
    masks.arm(S, A, 1, BRAVO);
    assert.deepEqual(masks.apply(S, { old: ALPHA, new: BRAVO }), {
      known: true,
      changed: true,
      output: { old: `<masked ticket=${A}>`, new: `<masked ticket=${A}>` },
    });
    assert.equal(dropOne(masks, S, A), 'unmasked');
    assert.equal(masks.any(), false);
    assert.deepEqual(masks.apply(S, { old: ALPHA, new: BRAVO }), { known: false, changed: false, output: { old: ALPHA, new: BRAVO } });
  });

  test('two sessions keep their masks apart through apply, drop and forget', () => {
    const masks = createMaskBook();
    masks.arm(S, A, 1, ALPHA);
    masks.arm(S2, B, 2, BRAVO);
    assert.deepEqual(masks.apply(S, BRAVO), { known: true, changed: false, output: BRAVO });
    assert.deepEqual(masks.apply(S2, ALPHA), { known: true, changed: false, output: ALPHA });
    assert.equal(dropOne(masks, S, B), 'none');
    assert.equal(masks.apply(S2, BRAVO).output, `<masked ticket=${B}>`);
    assert.equal(dropOne(masks, S, A), 'unmasked');
    assert.equal(masks.apply(S, ALPHA).known, false);
    assert.equal(masks.apply(S2, BRAVO).output, `<masked ticket=${B}>`);
    assert.equal(masks.any(), true);
    masks.arm(S, A, 3, ALPHA);
    masks.forget(S2);
    assert.equal(masks.apply(S2, BRAVO).known, false);
    assert.equal(masks.apply(S, ALPHA).output, `<masked ticket=${A}>`);
    assert.equal(masks.any(), true);
  });
});
