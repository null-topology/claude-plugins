/**
 * The 1Password accounts the tools can address: the ones `op account list`
 * reports (when the op CLI is installed) and the ones the user configured in
 * the plugin's `accounts` option (`OP_BRIDGE_ACCOUNTS`).
 *
 * An account found by `op` is passed to the broker by its UUID and labelled
 * `<url> · <email>`. A configured entry is passed verbatim (the SDK's desktop
 * authentication takes a sidebar name or a UUID) and labelled with itself,
 * unless it equals a discovered UUID or URL host: then it merges into that
 * account. The `account` argument of a tool matches a UUID, a URL (with or
 * without `https://`), an email or a configured entry, ignoring case, and
 * must match exactly one account.
 */

import { execFile } from 'node:child_process';
import type { Environment } from '../paths.ts';

/** How long `op account list` may run. */
export const OP_TIMEOUT_MS = 5000;
const MAX_OP_OUTPUT_BYTES = 1024 * 1024;

export interface OpAccount {
  uuid: string;
  url?: string;
  email?: string;
}

export interface Account {
  /** What the broker receives: the account UUID, or a configured entry verbatim. */
  readonly id: string;
  /** What the approval window and the `accounts` tool show. */
  readonly label: string;
  readonly uuid?: string;
  readonly url?: string;
  readonly email?: string;
  /** Configured entries merged into this discovered account. */
  readonly aliases: readonly string[];
  readonly source: 'op' | 'configured';
}

export type OpListing = { ok: true; accounts: OpAccount[] } | { ok: false; reason: 'missing' | 'failed' };

export class AccountError extends Error {
  override readonly name = 'AccountError';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** The accounts in the output of `op account list --format json`; throws when it is not a JSON array. */
export function parseOpAccounts(stdout: string): OpAccount[] {
  if (stdout.trim() === '') return [];
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('op account list did not print a JSON array');
  const accounts: OpAccount[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const uuid = nonEmpty(entry['account_uuid']);
    if (uuid === undefined) continue;
    const account: OpAccount = { uuid };
    const url = nonEmpty(entry['url']);
    if (url !== undefined) account.url = url;
    const email = nonEmpty(entry['email']);
    if (email !== undefined) account.email = email;
    accounts.push(account);
  }
  return accounts;
}

/** The entries of the `accounts` option, comma-separated; an unsubstituted placeholder counts as none. */
export function parseConfigured(setting: string | undefined): string[] {
  if (setting === undefined) return [];
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of setting.split(',')) {
    const entry = raw.trim();
    if (entry === '' || /^\$\{[^}]*\}$/.test(entry)) continue;
    const folded = entry.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    entries.push(entry);
  }
  return entries;
}

/** The host of a URL, lower-cased, with or without a scheme or a trailing path. */
function hostOf(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '');
}

function opLabel(account: OpAccount): string {
  if (account.url === undefined) return account.email ?? account.uuid;
  const host = hostOf(account.url);
  return account.email === undefined ? host : `${host} · ${account.email}`;
}

/** The discovered accounts, with matching configured entries merged in, then the other configured entries. */
export function knownAccounts(discovered: readonly OpAccount[], configured: readonly string[]): Account[] {
  const aliases = discovered.map((): string[] => []);
  const standalone: Account[] = [];
  for (const entry of configured) {
    const folded = entry.toLowerCase();
    const host = hostOf(entry);
    const index = discovered.findIndex(
      (a) => a.uuid.toLowerCase() === folded || (a.url !== undefined && hostOf(a.url) === host),
    );
    if (index >= 0) aliases[index]?.push(entry);
    else standalone.push({ id: entry, label: entry, aliases: [], source: 'configured' });
  }
  const fromOp = discovered.map((a, i): Account => {
    const account: { -readonly [K in keyof Account]: Account[K] } = {
      id: a.uuid,
      label: opLabel(a),
      uuid: a.uuid,
      aliases: aliases[i] ?? [],
      source: 'op',
    };
    if (a.url !== undefined) account.url = a.url;
    if (a.email !== undefined) account.email = a.email;
    return account;
  });
  return [...fromOp, ...standalone];
}

/** One account for an error message: its label and the value to pass. */
export function describeAccount(account: Account): string {
  return account.label === account.id ? account.id : `${account.label} (${account.id})`;
}

function listing(accounts: readonly Account[]): string {
  return accounts.map(describeAccount).join('; ');
}

function matches(account: Account, wanted: string): boolean {
  const folded = wanted.toLowerCase();
  const host = hostOf(wanted);
  if (account.uuid !== undefined && account.uuid.toLowerCase() === folded) return true;
  if (account.url !== undefined && hostOf(account.url) === host) return true;
  if (account.email !== undefined && account.email.toLowerCase() === folded) return true;
  if (account.source === 'configured' && account.id.toLowerCase() === folded) return true;
  return account.aliases.some((alias) => alias.toLowerCase() === folded);
}

export const NO_ACCOUNT_HINT =
  'Install the op CLI (it lists the accounts signed in to the 1Password app) or set the plugin option "accounts".';

/** The one account `wanted` names, or the only known account when `wanted` is empty; throws AccountError otherwise. */
export function resolveAccount(accounts: readonly Account[], wanted: string | undefined): Account {
  const value = wanted?.trim() ?? '';
  if (accounts.length === 0) {
    const subject = value === '' ? 'No 1Password account is known.' : `No 1Password account is known, so "${value}" matches nothing.`;
    throw new AccountError(`${subject} ${NO_ACCOUNT_HINT}`);
  }
  if (value === '') {
    const [only] = accounts;
    if (accounts.length === 1 && only !== undefined) return only;
    throw new AccountError(`${accounts.length} 1Password accounts are known; pass "account" as one of: ${listing(accounts)}.`);
  }
  const found = accounts.filter((a) => matches(a, value));
  const [first] = found;
  if (found.length === 1 && first !== undefined) return first;
  if (found.length === 0) {
    throw new AccountError(`No known 1Password account matches "${value}". Known accounts: ${listing(accounts)}.`);
  }
  throw new AccountError(`"${value}" matches ${found.length} accounts: ${listing(found)}. Pass the account UUID or email.`);
}

function errno(err: unknown): unknown {
  return isRecord(err) ? err['code'] : undefined;
}

/**
 * The accounts `op account list --format json` reports. A missing op is
 * `missing`; a failing run, unparsable output or a run past `timeoutMs` is
 * `failed`. Nothing is thrown and nothing op prints is returned as text.
 */
export function listOpAccounts(env: Environment, timeoutMs: number = OP_TIMEOUT_MS): Promise<OpListing> {
  return new Promise((resolve) => {
    execFile(
      'op',
      ['account', 'list', '--format', 'json'],
      { env: { ...env }, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OP_OUTPUT_BYTES, encoding: 'utf8' },
      (err, stdout) => {
        if (err !== null) {
          resolve({ ok: false, reason: errno(err) === 'ENOENT' ? 'missing' : 'failed' });
          return;
        }
        try {
          resolve({ ok: true, accounts: parseOpAccounts(stdout) });
        } catch {
          resolve({ ok: false, reason: 'failed' });
        }
      },
    );
  });
}
