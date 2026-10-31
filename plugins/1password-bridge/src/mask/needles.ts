/**
 * The strings that give a granted value away in Bash output: the value
 * itself and the encodings a shell command commonly prints it in.
 *
 * Every needle is at least MIN_MASK_LENGTH characters, so masking never
 * rewrites short, common strings. A value printed through any other
 * transformation (hex, a hash, part of a larger base64 blob) is not caught.
 */

import { MIN_MASK_LENGTH } from '../classify.ts';

const PEM_ARMOR = /^-----(BEGIN|END) [A-Z0-9 ]+-----$/;

/** GNU base64 wraps its output at 76 columns. */
const BASE64_WRAP = 76;

export function needlesFor(value: string): string[] {
  const out = new Set<string>();
  const add = (s: string): void => {
    if (s.length >= MIN_MASK_LENGTH) out.add(s);
  };
  if (value.length < MIN_MASK_LENGTH) return [];
  add(value);
  // The value inside a JSON string, as a command that prints JSON escapes it.
  add(JSON.stringify(value).slice(1, -1));
  const url = encodeURIComponent(value);
  add(url);
  add(url.replace(/%20/g, '+'));
  // `printf %s "$X" | base64` and `echo "$X" | base64`, padded, unpadded, URL-safe and wrapped.
  for (const raw of [value, `${value}\n`]) {
    const b64 = Buffer.from(raw, 'utf8').toString('base64');
    add(b64);
    add(b64.replace(/=+$/, ''));
    add(Buffer.from(raw, 'utf8').toString('base64url'));
    if (b64.length > BASE64_WRAP) add(b64.replace(/(.{76})/g, '$1\n').replace(/\n$/, ''));
  }
  // Each line of a multi-line value, so a partial print (`head -3` of a key) is
  // masked too; PEM armor lines are public and stay readable.
  if (value.includes('\n')) {
    for (const line of value.split('\n')) {
      const t = line.replace(/\r$/, '').trim();
      if (!PEM_ARMOR.test(t)) add(t);
    }
  }
  return [...out];
}
