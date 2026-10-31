import { createHash } from 'node:crypto';

/**
 * A synthetic PEM-shaped block: armor lines around 64-column base64-like body
 * lines and a short last line. Deterministic for a seed; not a real key.
 */
export function fakePem(seed: string, bodyLines: number): string {
  let body = '';
  for (let i = 0; body.length < bodyLines * 64; i += 1) {
    body += createHash('sha512').update(`${seed}-${i}`).digest('base64').replace(/=+$/, '');
  }
  const lines = body.slice(0, bodyLines * 64).match(/.{64}/g) ?? [];
  return ['-----BEGIN EXAMPLE TEST KEY-----', ...lines, 'tail=', '-----END EXAMPLE TEST KEY-----', ''].join('\n');
}
