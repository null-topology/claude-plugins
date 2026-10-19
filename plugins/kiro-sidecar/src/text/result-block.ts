/**
 * The result block that tool replies show for a turn with a completion (4.4):
 * `Result from Kiro (data):`, then the `complete_task` result between
 * `KIRO_OUTPUT_BEGIN` and `KIRO_OUTPUT_END`, neutralised as Kiro's text is. A
 * turn without a completion has no block.
 *
 * The result shown between the delimiters holds at most `RESULT_KEPT_CHARS`
 * as shown, the cut marker not counted, as the stored result is kept (4.4):
 * when neutralising lengthens it past that, it is cut shorter keeping its
 * start, before neutralising, and marked ` [...]`.
 */

import { fittedStart } from './fit.ts';
import { RESULT_KEPT_CHARS } from './limits.ts';
import { KIRO_OUTPUT_BEGIN, KIRO_OUTPUT_END, neutraliseKiroText } from './neutralise.ts';

export const RESULT_HEADER = 'Result from Kiro (data):';

/** `text` between the delimiters, neutralised; one line break at its end is not shown. */
export function delimitedLines(text: string): string[] {
  const neutralised = neutraliseKiroText(text);
  const lines = [KIRO_OUTPUT_BEGIN];
  if (neutralised !== '') {
    lines.push(neutralised.endsWith('\n') ? neutralised.slice(0, -1) : neutralised);
  }
  lines.push(KIRO_OUTPUT_END);
  return lines;
}

/** The lines of the block; none without a result. */
export function resultBlock(result: string | null): string[] {
  return result === null ? [] : [RESULT_HEADER, ...delimitedLines(fittedStart(result, RESULT_KEPT_CHARS))];
}

/** How many characters the block adds to a reply, a line break after each line included. */
export function resultBlockChars(result: string | null): number {
  return resultBlock(result).reduce((total, line) => total + line.length + 1, 0);
}
