/**
 * Fitting Kiro's text to a bound measured on the text as shown (4.4, 4.6).
 * Neutralising can lengthen a text, so a part that must fit a bound is cut on
 * the raw text, neutralised, measured, and cut shorter by the overshoot until
 * it fits. Cutting before neutralising means a cut cannot leave a forged
 * marker at the start of a line: every line that is shown went through the
 * neutraliser as it is shown.
 */

import { neutraliseKiroText } from './neutralise.ts';
import { cutKeepingEnd, cutKeepingStart, cutMarker } from './preview.ts';
import { headChars, splitsSurrogatePair } from './unicode.ts';

export interface Fitted {
  /** The budget of the last try. */
  readonly budget: number;
  /** What `show` made of that budget. */
  readonly shown: string;
}

/**
 * Tries `show(budget)` and, when it is longer than `maxChars`, gives up the
 * overshoot by halves: the largest budget between `floor` and `budget` that
 * still fits is kept, so a part keeps as much of its text as fits once shown.
 * Giving up the overshoot itself and trying again would fall to the floor as
 * soon as neutralising more than doubles the text, which lines that look
 * like a trailer do. Returns the try at `floor` when nothing above it fits.
 */
export function fitLongest(
  maxChars: number,
  budget: number,
  show: (budget: number) => string,
  floor = 0,
): Fitted {
  const whole = show(budget);
  if (whole.length <= maxChars || budget <= floor) {
    return { budget, shown: whole };
  }
  // `fits` is the floor or a budget that fits; `over` is a budget that does not.
  let fits: Fitted = { budget: floor, shown: show(floor) };
  let over = budget;
  while (over - fits.budget > 1) {
    const middle = fits.budget + Math.floor((over - fits.budget) / 2);
    const shown = show(middle);
    if (shown.length <= maxChars) {
      fits = { budget: middle, shown };
    } else {
      over = middle;
    }
  }
  return fits;
}

/**
 * The longest start of `text` that is at most `maxChars` long once
 * neutralised, but never less than its first character (a whole surrogate
 * pair), so a page always moves on. The cut never splits a surrogate pair.
 */
export function fittedHead(text: string, maxChars: number): string {
  const floor = text.length === 0 ? 0 : splitsSurrogatePair(text, 1) ? 2 : 1;
  const { budget } = fitLongest(maxChars, text.length, (keep) => neutraliseKiroText(headChars(text, keep)), floor);
  return headChars(text, budget);
}

/**
 * `cutKeepingEnd(text, budget)` with the largest budget up to `maxChars` that
 * is at most `maxChars` long once shown; `show` neutralises by default. A cut
 * text keeps its cut marker whenever `maxChars` can hold the marker.
 */
export function fittedTail(
  text: string,
  maxChars: number,
  show: (text: string) => string = neutraliseKiroText,
): string {
  const marker = cutMarker(text.length).length;
  const floor = marker <= maxChars ? marker : 0;
  const { budget } = fitLongest(maxChars, maxChars, (keep) => show(cutKeepingEnd(text, keep)), floor);
  return cutKeepingEnd(text, budget);
}

/**
 * `cutKeepingStart(text, budget)` with the largest budget whose result, its
 * cut marker included, is at most `maxChars` long once shown; `show`
 * neutralises by default. Showing never shortens a text, so the budget never
 * needs to pass `maxChars`.
 */
export function fittedStartMarked(
  text: string,
  maxChars: number,
  show: (text: string) => string = neutraliseKiroText,
): string {
  const { budget } = fitLongest(maxChars, Math.min(text.length, maxChars), (keep) => show(cutKeepingStart(text, keep)));
  return cutKeepingStart(text, budget);
}

/**
 * `cutKeepingStart(text, budget)` with the largest budget whose kept start is
 * at most `maxChars` long once neutralised. As in `cutKeepingStart`, the cut
 * marker is not counted: neutralising the kept start with the marker after
 * it gives the neutralised start followed by the marker.
 */
export function fittedStart(text: string, maxChars: number): string {
  const { budget } = fitLongest(maxChars, text.length, (keep) => neutraliseKiroText(headChars(text, keep)));
  return cutKeepingStart(text, budget);
}
