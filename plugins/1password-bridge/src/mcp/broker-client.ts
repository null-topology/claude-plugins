/**
 * The MCP server's side of the broker socket: connect, start a broker when
 * none listens, send one request, read one answer. The CLI and the hooks use
 * `connectSocket` and `requestRunning` instead, which only talk to a broker
 * that is already running and never start one.
 *
 * A broker's answer comes back as a Response, failures included. What is not
 * an answer (no broker, a dropped connection, a timeout the caller set, a
 * line that does not parse) is a BrokerError. Neither ever carries a value.
 *
 * Before every connect the client checks who owns the socket: its directory
 * must be a real directory of this user, closed to the group and others, and
 * the socket a socket of this user. Node has no SO_PEERCRED API, and it is not
 * needed: in a 0700 directory of the user only the user can bind a socket. A
 * socket that fails the check is never connected to and no broker is started
 * in its place, so a listener another user planted in a shared tmp directory
 * cannot answer, or hand out tickets.
 */

import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { socketPath, type Environment } from '../paths.ts';
import { encodeLine, MAX_LINE_BYTES, parseResponse, readLine, type Request, type Response } from '../protocol.ts';

export type BrokerErrorCode = 'unavailable' | 'untrusted' | 'closed' | 'timeout' | 'protocol';

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;

  constructor(code: BrokerErrorCode, message: string) {
    super(message);
    this.name = 'BrokerError';
    this.code = code;
  }
}

export interface RequestOptions {
  readonly stateDir: string;
  /** Starts a broker; called when nobody listens on the socket (never for `status`). */
  readonly spawnBroker: () => void;
  /**
   * Ends a request that gets no answer in time with BrokerError `timeout`.
   * Unset by default: `fields` and `issue_tickets` wait as long as Touch ID
   * takes; the broker times out on its own.
   */
  readonly timeoutMs?: number;
  /** How long to keep connecting after a spawn; 5 s by default. */
  readonly startTimeoutMs?: number;
  /** The pause between connection attempts; 50 ms by default. */
  readonly retryIntervalMs?: number;
  /** The lstat the socket check uses; `fs.lstatSync` by default. Tests swap it, as they cannot chown. */
  readonly lstat?: Lstat;
}

/** The parts of an lstat result the socket check reads. */
export interface SocketStat {
  readonly uid: number;
  readonly mode: number;
  isDirectory(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
}

export type Lstat = (path: string) => SocketStat;

export const START_TIMEOUT_MS = 5000;
export const RETRY_INTERVAL_MS = 50;

/** The broker socket for `stateDir`, for this user. */
export function brokerSocketPath(stateDir: string, env: Environment = process.env): string {
  return socketPath(stateDir, process.getuid?.() ?? 0, tmpdir(), env['XDG_RUNTIME_DIR']);
}

/**
 * The broker's environment: the server's own (so `OP_BRIDGE_*`, `PATH`,
 * `HOME`, `TMPDIR` and the display variables the window needs reach it), with
 * `CLAUDE_PLUGIN_DATA` pinned to the state directory, so the broker listens
 * on the very socket path the client computed.
 */
export function brokerEnv(stateDir: string, env: Environment = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  out['CLAUDE_PLUGIN_DATA'] = stateDir;
  return out;
}

/** Starts `<pluginRoot>/dist/broker.js` detached; it outlives the server that started it. */
export function startBroker(pluginRoot: string, stateDir: string, env: Environment = process.env): void {
  const child = spawn(process.execPath, [join(pluginRoot, 'dist', 'broker.js')], {
    detached: true,
    stdio: 'ignore',
    cwd: '/',
    env: brokerEnv(stateDir, env),
  });
  child.on('error', () => {});
  child.unref();
}

function errorCode(err: unknown): unknown {
  return err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
}

/** Nobody listens: no socket file, or a stale one. */
function isAbsent(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

/** Worth another attempt: absent, or a listener whose backlog is full. */
function isRetryable(err: unknown): boolean {
  return isAbsent(err) || errorCode(err) === 'EAGAIN';
}

function unavailable(err: unknown): BrokerError {
  const code = errorCode(err);
  const why = typeof code === 'string' ? ` (${code})` : '';
  return new BrokerError('unavailable', `The 1password-bridge broker is not running and could not be started${why}.`);
}

function untrusted(path: string, reason: string): BrokerError {
  return new BrokerError('untrusted', `Refusing to connect to the 1password-bridge broker socket ${path}: ${reason}.`);
}

/** lstat, or undefined when the path does not exist. Other errors propagate. */
function lstatIfPresent(lstat: Lstat, path: string): SocketStat | undefined {
  try {
    return lstat(path);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Whether the socket at `path` may be connected to: `absent` when its
 * directory or the socket does not exist yet (a broker may be started, and
 * creates the directory 0700), `present` when both pass the owner and mode
 * checks. Anything else throws BrokerError `untrusted`.
 */
function checkSocket(path: string, uid: number, lstat: Lstat): 'present' | 'absent' {
  const dir = lstatIfPresent(lstat, dirname(path));
  if (dir === undefined) return 'absent';
  if (dir.isSymbolicLink()) throw untrusted(path, 'its directory is a symbolic link');
  if (!dir.isDirectory()) throw untrusted(path, 'its directory is not a directory');
  if (dir.uid !== uid) throw untrusted(path, 'its directory is owned by another user');
  if ((dir.mode & 0o077) !== 0) throw untrusted(path, 'its directory is open to other users');
  const socket = lstatIfPresent(lstat, path);
  if (socket === undefined) return 'absent';
  if (!socket.isSocket()) throw untrusted(path, 'it is not a socket');
  if (socket.uid !== uid) throw untrusted(path, 'the socket is owned by another user');
  return 'present';
}

/** One connection attempt, after the socket check; an absent socket fails as ENOENT without a connect. */
async function connectOnce(path: string, lstat: Lstat): Promise<Socket> {
  // Windows has no uid (process.getuid is absent) and no owner or mode bits
  // to check: there the client connects without the check, as it always did.
  const uid = process.getuid?.();
  if (uid !== undefined && checkSocket(path, uid, lstat) === 'absent') {
    throw Object.assign(new Error(`${path} does not exist`), { code: 'ENOENT' });
  }
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function notRunning(err: unknown): BrokerError {
  const code = errorCode(err);
  const why = typeof code === 'string' ? ` (${code})` : '';
  return new BrokerError('unavailable', `The 1password-bridge broker is not reachable${why}.`);
}

/**
 * A connection to a running broker, after the socket owner and mode check.
 * It never starts a broker and never retries: nobody listening is BrokerError
 * `unavailable`, a socket that fails the check BrokerError `untrusted`.
 */
export async function connectSocket(path: string, lstat: Lstat = lstatSync): Promise<Socket> {
  try {
    return await connectOnce(path, lstat);
  } catch (err) {
    if (err instanceof BrokerError) throw err;
    throw notRunning(err);
  }
}

export interface RunningOptions {
  readonly stateDir: string;
  /** The environment the socket path is computed from (`XDG_RUNTIME_DIR`); `process.env` by default. */
  readonly env?: Environment;
  /** Ends a request that gets no answer in time with BrokerError `timeout`; unset by default. */
  readonly timeoutMs?: number;
  /** The longest answer line; MAX_LINE_BYTES by default. A `mask` answer carries a whole Bash command output. */
  readonly maxBytes?: number;
  /** The lstat the socket check uses; `fs.lstatSync` by default. */
  readonly lstat?: Lstat;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A connection to the broker, starting one when nobody listens (except for
 * `status`). An untrusted socket ends it at once: no connect, no spawn.
 */
async function open(path: string, op: Request['op'], options: RequestOptions): Promise<Socket> {
  const lstat = options.lstat ?? lstatSync;
  try {
    return await connectOnce(path, lstat);
  } catch (err) {
    if (err instanceof BrokerError) throw err;
    if (!isRetryable(err) || (op === 'status' && isAbsent(err))) throw unavailable(err);
    if (isAbsent(err)) {
      try {
        options.spawnBroker();
      } catch (spawnErr) {
        throw unavailable(spawnErr);
      }
    }
  }
  const deadline = Date.now() + (options.startTimeoutMs ?? START_TIMEOUT_MS);
  for (;;) {
    await sleep(options.retryIntervalMs ?? RETRY_INTERVAL_MS);
    try {
      return await connectOnce(path, lstat);
    } catch (err) {
      if (err instanceof BrokerError) throw err;
      if (!isRetryable(err) || Date.now() >= deadline) throw unavailable(err);
    }
  }
}

/** Sends `req` and reads an answer of at most `maxBytes`; null when the broker closed without one. */
async function exchange(socket: Socket, req: Request, timeoutMs: number | undefined, maxBytes: number = MAX_LINE_BYTES): Promise<Response | null> {
  // A write to a broker that is exiting fails with EPIPE; readLine then sees the close.
  socket.on('error', () => {});
  let timer: NodeJS.Timeout | undefined;
  try {
    socket.write(encodeLine(req));
    const reading = readLine(socket, maxBytes);
    const line =
      timeoutMs === undefined
        ? await reading
        : await Promise.race([
            reading,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new BrokerError('timeout', `The 1password-bridge broker did not answer within ${timeoutMs} ms.`)), timeoutMs);
            }),
          ]);
    if (line === null) return null;
    const response = parseResponse(line, req.op);
    if (response === null) throw new BrokerError('protocol', 'The 1password-bridge broker sent an answer this server does not understand.');
    return response;
  } catch (err) {
    if (err instanceof BrokerError) throw err;
    throw new BrokerError('protocol', 'The 1password-bridge broker sent an answer this server does not understand.');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    socket.destroy();
  }
}

/**
 * Sends `req` to the broker and returns its answer. A `displaced` answer, or
 * a connection closed without an answer (a broker exiting), gets one
 * reconnect, starting a broker when needed, and one retry of the same request.
 */
export async function request(req: Request, options: RequestOptions): Promise<Response> {
  const path = brokerSocketPath(options.stateDir);
  for (let attempt = 1; ; attempt++) {
    const socket = await open(path, req.op, options);
    const response = await exchange(socket, req, options.timeoutMs);
    const displaced = response !== null && !response.ok && response.code === 'displaced';
    if (response !== null && (!displaced || attempt === 2)) return response;
    if (attempt === 2) throw new BrokerError('closed', 'The 1password-bridge broker closed the connection without an answer.');
  }
}

/**
 * Sends `req` to a running broker and returns its answer, a `displaced` one
 * included. Never starts a broker and never retries: a broker that is not
 * running holds no tickets or masks to act on.
 */
export async function requestRunning(req: Request, options: RunningOptions): Promise<Response> {
  const socket = await connectSocket(brokerSocketPath(options.stateDir, options.env), options.lstat);
  const response = await exchange(socket, req, options.timeoutMs, options.maxBytes);
  if (response === null) throw new BrokerError('closed', 'The 1password-bridge broker closed the connection without an answer.');
  return response;
}
