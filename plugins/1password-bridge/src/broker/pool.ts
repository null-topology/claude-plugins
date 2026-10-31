/**
 * The broker's 1Password clients, one per account, and the only way to call
 * them.
 *
 * Any SDK call may show a 1Password prompt: connecting asks the user to
 * authorize the process, and after about ten idle minutes the app asks again
 * inside an ordinary call. 1Password denies a second prompt while one is open,
 * so every call of every account runs through one FIFO queue, one at a time.
 *
 * The SDK cannot cancel a call. An operation still pending after 120 s fails
 * its caller with `auth_timeout`, and the queue then starts nothing more:
 * advancing would overlap SDK calls and prompts. It calls `onStuck` instead,
 * and the broker ends the process, the one way to cancel the native call.
 *
 * Keep-alive: every 240 s each account whose last success is under 8 minutes
 * old is pinged with `listVaults`, through the queue. The ping checks the age
 * again when it reaches the head of the queue: a ping that waited behind
 * another account's prompt must not run on an expired authorization and ask
 * for Touch ID unasked. An older client is not pinged; its next real request
 * goes through the queue like any other.
 */

import type { FailureCode } from '../protocol.ts';
import { SDK_INTEGRATION_SETTING } from '../strings.ts';
import { LookupError } from './lookup.ts';
import type { AccountClient } from './onepassword.ts';

export const OPERATION_TIMEOUT_MS = 120_000;
export const KEEP_ALIVE_INTERVAL_MS = 240_000;
export const KEEP_ALIVE_WINDOW_MS = 8 * 60_000;

const MAX_MESSAGE_LENGTH = 300;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** The real clock; the keep-alive interval does not keep the process alive by itself. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export class PoolError extends Error {
  override name = 'PoolError';
  readonly code: FailureCode;

  constructor(code: FailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface PoolOptions {
  connect(account: string): Promise<AccountClient>;
  /** Whether this broker still owns the socket path; checked before every operation. */
  owns(): boolean;
  /** Called once, when an operation outlives the timeout. */
  onStuck(): void;
  clock?: Clock;
  operationTimeoutMs?: number;
  keepAliveIntervalMs?: number;
  keepAliveWindowMs?: number;
}

export interface Pool {
  /** Runs `fn` with the account's client, connecting first when none is cached. */
  run<T>(account: string, fn: (client: AccountClient) => Promise<T>): Promise<T>;
  /** The keep-alive tick; the pool runs it every keep-alive interval. */
  tick(): void;
  /** The accounts with a cached client; warm while the last success is inside the keep-alive window. */
  accounts(): { account: string; warm: boolean }[];
  /** Fails every queued run and every later one with `code`; the running operation is left to finish. */
  abort(code: FailureCode, message: string): void;
  /** Aborts, stops the keep-alive and drops every client. */
  close(): void;
  /** True while an operation runs or waits in the queue. */
  busy(): boolean;
  /** Forgets every authorized client; the next operation connects (and asks for Touch ID) again. */
  drop(): void;
}

/** The failure an error from a pool operation answers with. */
export function mapError(err: unknown): { code: FailureCode; message: string } {
  if (err instanceof PoolError || err instanceof LookupError) return { code: err.code, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('IPC operation failed: -3')) {
    return { code: 'integration_off', message: `The 1Password app refuses SDK connections. Turn on 1Password > ${SDK_INTEGRATION_SETTING}.` };
  }
  if (/denied authorization/i.test(message)) {
    return { code: 'auth_denied', message: 'The 1Password authorization was denied.' };
  }
  if (message.includes('desktop application not found') || message.includes('Native library is not available')) {
    return { code: 'no_app', message: 'The 1Password desktop app was not found.' };
  }
  const short = message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message;
  return { code: 'internal', message: `The 1Password call failed: ${short}` };
}

interface Entry {
  client: AccountClient;
  lastOk: number | undefined;
}

interface Job {
  account: string;
  fn: (client: AccountClient) => Promise<unknown>;
  resolve(value: unknown): void;
  reject(err: unknown): void;
  ping: boolean;
}

export function createPool(options: PoolOptions): Pool {
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.operationTimeoutMs ?? OPERATION_TIMEOUT_MS;
  const windowMs = options.keepAliveWindowMs ?? KEEP_ALIVE_WINDOW_MS;
  const clients = new Map<string, Entry>();
  const queue: Job[] = [];
  const pinging = new Set<string>();
  let running = false;
  let refusal: PoolError | undefined;

  const fresh = (entry: Entry | undefined): boolean => entry?.lastOk !== undefined && clock.now() - entry.lastOk < windowMs;

  const owns = (): boolean => {
    try {
      return options.owns();
    } catch {
      return false;
    }
  };

  function enqueue(account: string, fn: Job['fn'], ping: boolean): Promise<unknown> {
    if (refusal !== undefined) return Promise.reject(new PoolError(refusal.code, refusal.message));
    return new Promise((resolve, reject) => {
      queue.push({ account, fn, resolve, reject, ping });
      pump();
    });
  }

  function pump(): void {
    while (!running && refusal === undefined) {
      const job = queue.shift();
      if (job === undefined) return;
      if (job.ping) {
        pinging.delete(job.account);
        if (!fresh(clients.get(job.account))) {
          job.resolve(undefined);
          continue;
        }
      }
      if (!owns()) {
        job.reject(new PoolError('displaced', 'Another broker took over the socket'));
        continue;
      }
      start(job);
    }
  }

  function start(job: Job): void {
    running = true;
    let done = false;
    const timer = clock.setTimeout(() => {
      if (done) return;
      done = true;
      refusal = new PoolError('auth_timeout', `1Password did not answer within ${Math.round(timeoutMs / 1000)} s`);
      job.reject(refusal);
      options.onStuck();
    }, timeoutMs);
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      clock.clearTimeout(timer);
      running = false;
      settle();
      pump();
    };
    (async () => {
      let entry = clients.get(job.account);
      if (entry === undefined) {
        entry = { client: await options.connect(job.account), lastOk: undefined };
        clients.set(job.account, entry);
      }
      return { entry, value: await job.fn(entry.client) };
    })().then(
      ({ entry, value }) =>
        finish(() => {
          entry.lastOk = clock.now();
          job.resolve(value);
        }),
      (err: unknown) =>
        finish(() => {
          const entry = clients.get(job.account);
          // A lookup miss is an answer from 1Password, not a broken client.
          if (err instanceof LookupError && entry !== undefined) entry.lastOk = clock.now();
          else clients.delete(job.account);
          const failure = mapError(err);
          job.reject(new PoolError(failure.code, failure.message));
        }),
    );
  }

  function tick(): void {
    if (refusal !== undefined) return;
    for (const [account, entry] of clients) {
      if (!fresh(entry) || pinging.has(account)) continue;
      pinging.add(account);
      // A failed ping has already dropped the client; nobody waits for its answer.
      enqueue(account, (client) => client.listVaults(), true).catch(() => {});
    }
  }

  const interval = clock.setInterval(tick, options.keepAliveIntervalMs ?? KEEP_ALIVE_INTERVAL_MS);

  function abort(code: FailureCode, message: string): void {
    refusal ??= new PoolError(code, message);
    for (const job of queue.splice(0)) job.reject(new PoolError(code, message));
    pinging.clear();
  }

  return {
    run: <T>(account: string, fn: (client: AccountClient) => Promise<T>) => enqueue(account, fn, false) as Promise<T>,
    tick,
    accounts: () => [...clients].map(([account, entry]) => ({ account, warm: fresh(entry) })),
    abort,
    busy: () => running || queue.length > 0,
    drop() {
      clients.clear();
      pinging.clear();
    },
    close() {
      abort('internal', 'The broker is shutting down');
      clock.clearInterval(interval);
      clients.clear();
    },
  };
}
