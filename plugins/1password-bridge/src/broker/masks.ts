/**
 * The broker's masks: per session, each delivered secret value and the
 * tickets that delivered it. One value has one mask, labelled with the
 * earliest of its tickets still holding it; the mask goes when the last of
 * them is released or the session ends. Values live only here, in memory.
 */

import { buildMasker, maskDeep } from '../mask/masker.ts';
import { needlesFor } from '../mask/needles.ts';

interface Holder {
  ticket: string;
  issuedAt: number;
}

export interface MaskResult {
  /** False when the broker holds no mask for the session. */
  known: boolean;
  changed: boolean;
  output: unknown;
}

/**
 * What dropping a ticket did: `none` when it held no value; `unmasked` when a
 * value it held is no longer masked by any ticket; `kept` when every value it
 * held stays masked under another ticket of the session.
 */
export type DropResult = 'none' | 'unmasked' | 'kept';

export interface MaskBook {
  arm(session: string, ticket: string, issuedAt: number, value: string): void;
  /**
   * Drops the hold of every ticket in `tickets` on its values, as one set: a
   * value is unmasked when no ticket outside the set holds it. Answers for each
   * ticket in `tickets`.
   */
  drop(session: string, tickets: readonly string[]): Map<string, DropResult>;
  /** Whether `ticket` holds a mask in `session`: false for an id from before a broker restart. */
  holds(session: string, ticket: string): boolean;
  /** Masks every string in `output`. */
  apply(session: string, output: unknown): MaskResult;
  forget(session: string): void;
  /** Whether any session holds a mask. */
  any(): boolean;
}

export function createMaskBook(): MaskBook {
  const sessions = new Map<string, Map<string, Holder[]>>();
  const maskers = new Map<string, ((s: string) => string) | null>();

  function masker(session: string, values: Map<string, Holder[]>): ((s: string) => string) | null {
    let mask = maskers.get(session);
    if (mask === undefined) {
      mask = buildMasker(
        [...values].map(([value, holders]) => ({ replacement: `<masked ticket=${holders[0]?.ticket ?? 'unknown'}>`, needles: needlesFor(value) })),
      );
      maskers.set(session, mask);
    }
    return mask;
  }

  return {
    arm(session, ticket, issuedAt, value) {
      let values = sessions.get(session);
      if (values === undefined) {
        values = new Map();
        sessions.set(session, values);
      }
      const holders = values.get(value) ?? [];
      if (!holders.some((h) => h.ticket === ticket)) holders.push({ ticket, issuedAt });
      holders.sort((a, b) => a.issuedAt - b.issuedAt);
      values.set(value, holders);
      maskers.delete(session);
    },
    drop(session, tickets) {
      const dropping = new Set(tickets);
      const dropped = new Map<string, DropResult>([...dropping].map((t) => [t, 'none']));
      const values = sessions.get(session);
      if (values === undefined) return dropped;
      for (const [value, holders] of values) {
        const left = holders.filter((h) => !dropping.has(h.ticket));
        if (left.length === holders.length) continue;
        for (const h of holders) {
          if (!dropping.has(h.ticket)) continue;
          if (left.length === 0) dropped.set(h.ticket, 'unmasked');
          else if (dropped.get(h.ticket) === 'none') dropped.set(h.ticket, 'kept');
        }
        if (left.length === 0) values.delete(value);
        else values.set(value, left);
      }
      if (values.size === 0) sessions.delete(session);
      maskers.delete(session);
      return dropped;
    },
    holds(session, ticket) {
      const values = sessions.get(session);
      if (values === undefined) return false;
      for (const holders of values.values()) if (holders.some((h) => h.ticket === ticket)) return true;
      return false;
    },
    apply(session, output) {
      const values = sessions.get(session);
      if (values === undefined) return { known: false, changed: false, output };
      const mask = masker(session, values);
      if (mask === null) return { known: true, changed: false, output };
      const { changed, value } = maskDeep(output, mask);
      return { known: true, changed, output: value };
    },
    forget(session) {
      sessions.delete(session);
      maskers.delete(session);
    },
    any: () => sessions.size > 0,
  };
}
