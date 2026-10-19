/**
 * A short value from a user or from Kiro shown inside a line of the plugin's
 * own text: a wake header value (4.6) or a tool title (`lastTool`, 4.4). It
 * is redacted first, put on one line (every line break becomes a space) and
 * cut to `FIELD_KEPT_CHARS` keeping its start, marked ` [...]`.
 */

import { FIELD_KEPT_CHARS } from './limits.ts';
import { oneLine } from './messages.ts';
import { neutraliseKiroText } from './neutralise.ts';
import { HEAD_CUT_MARKER } from './preview.ts';
import type { SecretSet } from './redact.ts';
import { headChars } from './unicode.ts';

/** A redacted value on one line, cut keeping its start; not neutralised. */
export function fieldValue(value: string, secrets: Pick<SecretSet, 'redact'>): string {
  const flat = oneLine(secrets.redact(value));
  return flat.length > FIELD_KEPT_CHARS
    ? headChars(flat, FIELD_KEPT_CHARS - HEAD_CUT_MARKER.length) + HEAD_CUT_MARKER
    : flat;
}

/** A redacted value on one line, cut keeping its start, then neutralised. */
export function headerValue(value: string, secrets: Pick<SecretSet, 'redact'>): string {
  return neutraliseKiroText(fieldValue(value, secrets));
}
