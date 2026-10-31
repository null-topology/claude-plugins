import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { BrokerError, brokerSocketPath, connectSocket, requestRunning, startBroker, type Lstat, type RunningOptions } from '../../src/mcp/broker-client.ts';
import { encodeLine, MAX_LINE_BYTES, MAX_OUTPUT_BYTES, readLine, type Request, type Response } from '../../src/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/version.ts';

const SESSION = 'session-0000-test';
const END: Request = { v: PROTOCOL_VERSION, op: 'end_session', session: SESSION };
const END_OK: Response = { ok: true, op: 'end_session' };
const MASK: Request = { v: PROTOCOL_VERSION, op: 'mask', session: SESSION, tickets: ['tkt_aaaaaaaaaaaaaaaa'], output: 'plain output' };
const DISPLACED: Response = { ok: false, code: 'displaced', message: 'another broker took over' };

/** What a fake broker does with one request: answer it, drop the connection unanswered, or never answer. */
type Handler = (req: unknown) => Response | 'close' | 'hang';

/** The functions that start a child process without waiting for it. */
const STARTERS = ['spawn', 'fork', 'exec', 'execFile'] as const;

let root: string;
let stateDir: string;
let path: string;
let servers: Server[];
let sockets: Socket[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'op-running-'));
  stateDir = join(root, 'state');
  path = brokerSocketPath(stateDir, {});
  assert.ok(path.startsWith(stateDir), 'the test socket must live in the test state directory');
  servers = [];
  sockets = [];
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  rmSync(root, { recursive: true, force: true });
});

/** A fake broker on the test socket, in a 0700 directory as the broker makes it; resolves once it listens. */
async function serve(handler: Handler): Promise<{ requests: unknown[]; connections: () => number }> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const requests: unknown[] = [];
  let connections = 0;
  const server = createServer((socket) => {
    sockets.push(socket);
    connections += 1;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const req: unknown = JSON.parse(buffer.slice(0, end));
      requests.push(req);
      const answer = handler(req);
      if (answer === 'close') socket.destroy();
      else if (answer !== 'hang') socket.end(encodeLine(answer));
    });
    socket.on('error', () => {});
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return { requests, connections: () => connections };
}

/** A socket file nobody listens on: its listener was killed before it could remove it. */
function staleSocket(): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const stale = spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, 'SIGKILL'))`]);
  assert.equal(stale.signal, 'SIGKILL');
  assert.ok(lstatSync(path).isSocket());
}

/**
 * Runs `body` while every child-process starter only counts its calls and
 * starts nothing; returns the count.
 */
async function countSpawns(body: () => Promise<unknown>): Promise<number> {
  const target = childProcess as unknown as Record<(typeof STARTERS)[number], (...args: unknown[]) => unknown>;
  const saved = STARTERS.map((name) => [name, target[name]] as const);
  let calls = 0;
  const child = { on: () => child, unref: () => {} };
  for (const name of STARTERS) {
    target[name] = () => {
      calls += 1;
      return child;
    };
  }
  // src/mcp/broker-client.ts holds a named import of spawn; this rebinds it.
  syncBuiltinESMExports();
  try {
    await body();
  } finally {
    for (const [name, real] of saved) target[name] = real;
    syncBuiltinESMExports();
  }
  return calls;
}

function running(overrides: Partial<RunningOptions> = {}): RunningOptions {
  return { stateDir, env: {}, ...overrides };
}

async function rejectsWith(promise: Promise<unknown>, code: BrokerError['code'], message?: RegExp): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof BrokerError, String(err));
    assert.equal(err.code, code);
    if (message !== undefined) assert.match(err.message, message);
    return true;
  });
}

describe('countSpawns', () => {
  test('control: it sees the broker client start a broker', async () => {
    assert.equal(await countSpawns(async () => startBroker(root, stateDir, {})), 1);
    assert.equal(existsSync(stateDir), false);
  });
});

describe('requestRunning', () => {
  test('answers from a running broker, sending it the one request line', async () => {
    const { requests, connections } = await serve(() => END_OK);
    let response: Response | undefined;
    const spawns = await countSpawns(async () => {
      response = await requestRunning(END, running());
    });
    assert.deepEqual(response, END_OK);
    assert.deepEqual(requests, [END]);
    assert.equal(connections(), 1);
    assert.equal(spawns, 0);
  });

  test('no socket: unavailable at once, with nothing spawned and nothing created', async () => {
    const started = Date.now();
    const spawns = await countSpawns(() => rejectsWith(requestRunning(END, running()), 'unavailable', /not reachable \(ENOENT\)\.$/));
    assert.ok(Date.now() - started < 1000, 'no wait for a broker to come up');
    assert.equal(spawns, 0);
    assert.equal(existsSync(stateDir), false, 'no state or socket directory, no socket, no lock');
  });

  test('a stale socket file (connection refused): unavailable, nothing spawned, the directory untouched', async () => {
    staleSocket();
    const started = Date.now();
    const spawns = await countSpawns(() => rejectsWith(requestRunning(END, running()), 'unavailable', /not reachable \(ECONNREFUSED\)\.$/));
    assert.ok(Date.now() - started < 1000, 'no wait for a broker to come up');
    assert.equal(spawns, 0);
    assert.deepEqual(readdirSync(stateDir), [basename(dirname(path))]);
    assert.deepEqual(readdirSync(dirname(path)), [basename(path)]);
    assert.ok(lstatSync(path).isSocket(), 'the stale socket is left for a broker to replace');
  });

  test('closed without an answer: closed, after one connection and no retry', async () => {
    const { connections } = await serve(() => 'close');
    const spawns = await countSpawns(() => rejectsWith(requestRunning(END, running()), 'closed'));
    assert.equal(connections(), 1);
    assert.equal(spawns, 0);
  });

  test('a displaced answer is returned as it is, with no retry', async () => {
    const { connections } = await serve(() => DISPLACED);
    assert.deepEqual(await requestRunning(END, running()), DISPLACED);
    assert.equal(connections(), 1);
  });

  test('a caller-given timeout ends a request that gets no answer', async () => {
    await serve(() => 'hang');
    await rejectsWith(requestRunning(END, running({ timeoutMs: 100 })), 'timeout');
  });

  test('answers are limited to MAX_LINE_BYTES unless the caller raises the limit, as mask does', async () => {
    const output = 'x'.repeat(MAX_LINE_BYTES + 1);
    const answer: Response = { ok: true, op: 'mask', known: true, changed: false, output, missing: [] };
    await serve(() => answer);
    await rejectsWith(requestRunning(MASK, running()), 'protocol');
    assert.deepEqual(await requestRunning(MASK, running({ maxBytes: MAX_OUTPUT_BYTES })), answer);
  });

  test('a socket owned by another user: untrusted, never connected, nothing spawned', async () => {
    const { connections } = await serve(() => END_OK);
    const uid = process.getuid?.() ?? 0;
    const lstat: Lstat = (p) => {
      const st = lstatSync(p);
      if (p !== path) return st;
      return { uid: uid + 1, mode: st.mode, isDirectory: () => st.isDirectory(), isSocket: () => st.isSocket(), isSymbolicLink: () => st.isSymbolicLink() };
    };
    const spawns = await countSpawns(() => rejectsWith(requestRunning(END, running({ lstat })), 'untrusted', /owned by another user/));
    assert.equal(connections(), 0);
    assert.equal(spawns, 0);
  });
});

describe('connectSocket', () => {
  test('connects to a running broker; the caller talks on the connection', async () => {
    const { requests } = await serve(() => END_OK);
    const socket = await connectSocket(path);
    try {
      socket.write(encodeLine(END));
      assert.equal(await readLine(socket), JSON.stringify(END_OK));
    } finally {
      socket.destroy();
    }
    assert.deepEqual(requests, [END]);
  });

  test('no socket: unavailable, with nothing spawned and nothing created', async () => {
    const spawns = await countSpawns(() => rejectsWith(connectSocket(path), 'unavailable', /not reachable/));
    assert.equal(spawns, 0);
    assert.equal(existsSync(stateDir), false);
  });

  test('refuses a socket directory open to other users, without connecting', async () => {
    const { connections } = await serve(() => END_OK);
    chmodSync(dirname(path), 0o755);
    await rejectsWith(connectSocket(path), 'untrusted', /open to other users/);
    assert.equal(connections(), 0);
  });
});
