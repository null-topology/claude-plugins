/**
 * Replaces every needle of every mask entry with the entry's replacement
 * text, in a string or in every string of a Bash tool response.
 */

export interface MaskEntry {
  /** What each needle becomes, such as `<masked ticket=tkt_…>`. */
  readonly replacement: string;
  readonly needles: readonly string[];
}

/**
 * A function masking all needles of `entries`, or null when there is nothing
 * to mask. Needles are tried longest first, so a whole value wins over one of
 * its lines; a needle shared by two entries is reported under the first.
 */
export function buildMasker(entries: readonly MaskEntry[]): ((s: string) => string) | null {
  const byNeedle = new Map<string, string>();
  for (const e of entries) for (const n of e.needles) if (!byNeedle.has(n)) byNeedle.set(n, e.replacement);
  if (byNeedle.size === 0) return null;
  const alternatives = [...byNeedle.keys()]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(alternatives.join('|'), 'g');
  return (s) => s.replace(re, (m) => byNeedle.get(m) ?? '<masked>');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * `mask` applied to every string in `v`. Numbers, booleans, null and keys are
 * kept: a Bash response carries its output in strings, and its keys and
 * numbers are its schema. Arrays and plain objects are rebuilt only when
 * something in them changed, so an unchanged value comes back as the same
 * reference.
 */
export function maskDeep(v: unknown, mask: (s: string) => string): { changed: boolean; value: unknown } {
  if (typeof v === 'string') {
    const masked = mask(v);
    return { changed: masked !== v, value: masked };
  }
  if (Array.isArray(v)) {
    let changed = false;
    const items = v.map((item: unknown) => {
      const result = maskDeep(item, mask);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { changed, value: items } : { changed, value: v };
  }
  if (isPlainObject(v)) {
    let changed = false;
    const entries = Object.entries(v).map(([key, item]) => {
      const result = maskDeep(item, mask);
      changed ||= result.changed;
      return [key, result.value] as const;
    });
    return changed ? { changed, value: Object.fromEntries(entries) } : { changed, value: v };
  }
  return { changed: false, value: v };
}

/**
 * Keys whose string value would name the shape of a Bash response rather than
 * carry its text: insurance in case the response carries a `type` or `mode`
 * enum field.
 */
const DISCRIMINATOR_KEYS: ReadonlySet<string> = new Set(['type', 'mode']);

/**
 * `v` with every string replaced by `note`: the fallback when masking fails,
 * keeping none of the response's text but all of its shape. Claude Code
 * ignores an `updatedToolOutput` that does not match the Bash output schema,
 * so the shape must survive or the withheld output is dropped and the
 * original shows through: strings under `type` and `mode` keys stay verbatim
 * (discriminators); numbers, booleans and null stay; every key stays.
 */
export function withholdDeep(v: unknown, note: string): unknown {
  if (typeof v === 'string') return note;
  if (Array.isArray(v)) return v.map((item: unknown) => withholdDeep(item, note));
  if (isPlainObject(v)) {
    return Object.fromEntries(
      Object.entries(v).map(([key, item]) => [key, typeof item === 'string' && DISCRIMINATOR_KEYS.has(key) ? item : withholdDeep(item, note)]),
    );
  }
  return v;
}
