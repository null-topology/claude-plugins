import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BrokerError, brokerEnv, brokerSocketPath, request, startBroker, type Lstat, type RequestOptions } from '../../src/mcp/broker-client.ts';
import type { Request, Response } from '../../src/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/version.ts';

const STATUS: Request = { v: PROTOCOL_VERSION, op: 'status' };
const FIELDS: Request = { v: PROTOCOL_VERSION, op: 'fields', account: 'ACCOUNTUUID', ref: 'op://Vault/Item' };
const FIELDS_OK: Response = { ok: true, op: 'fields', vault: 'Vault', item: { title: 'Item', category: 'Login' }, fields: [] };
const STATUS_OK: Response = { ok: true, op: 'status', accounts: [], exitsAt: '2026-10-28T13:00:00.000Z' };
const DISPLACED: Response = { ok: false, code: 'displaced', message: 'another broker took over' };

/** What a fake broker does with one request: answer it, or drop the connection unanswered. */
type Handler = (req: unknown, socket: Socket, connection: number) => Response | 'close' | 'hang';

let root: string;
let stateDir: string;
let path: string;
let servers: Server[];
let sockets: Socket[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'op-bc-'));
  stateDir = join(root, 'state');
  path = brokerSocketPath(stateDir);
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
async function serve(handler: Handler): Promise<{ server: Server; requests: unknown[]; connections: () => number }> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const requests: unknown[] = [];
  let connections = 0;
  const server = createServer((socket) => {
    sockets.push(socket);
    const connection = ++connections;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const req: unknown = JSON.parse(buffer.slice(0, end));
      requests.push(req);
      const answer = handler(req, socket, connection);
      if (answer === 'close') socket.destroy();
      else if (answer !== 'hang') socket.end(`${JSON.stringify(answer)}\n`);
    });
    socket.on('error', () => {});
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return { server, requests, connections: () => connections };
}

function options(overrides: Partial<RequestOptions> = {}): RequestOptions & { spawns: () => number } {
  let spawns = 0;
  const spawnBroker = overrides.spawnBroker ?? (() => {});
  return {
    stateDir,
    startTimeoutMs: 1000,
    ...overrides,
    spawnBroker: () => {
      spawns += 1;
      spawnBroker();
    },
    spawns: () => spawns,
  };
}

async function rejectsWith(promise: Promise<unknown>, code: BrokerError['code']): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof BrokerError && err.code === code);
}

describe('request', () => {
  test('sends one JSON line and returns the answer', async () => {
    const { requests } = await serve(() => FIELDS_OK);
    const opts = options();
    assert.deepEqual(await request(FIELDS, opts), FIELDS_OK);
    assert.deepEqual(requests, [FIELDS]);
    assert.equal(opts.spawns(), 0);
  });

  test('status with no broker fails at once and never spawns one', async () => {
    const opts = options();
    await rejectsWith(request(STATUS, opts), 'unavailable');
    assert.equal(opts.spawns(), 0);
  });

  test('no socket: spawns a broker and connects once it listens', async () => {
    const opts = options({ spawnBroker: () => void setTimeout(() => void serve(() => FIELDS_OK).catch(() => {}), 120) });
    assert.deepEqual(await request(FIELDS, opts), FIELDS_OK);
    assert.equal(opts.spawns(), 1);
  });

  test('a stale socket file (connection refused): spawns a broker', async () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const stale = spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, 'SIGKILL'))`]);
    assert.equal(stale.signal, 'SIGKILL');
    assert.ok(existsSync(path));
    const opts = options({
      spawnBroker: () => {
        unlinkSync(path);
        void serve(() => FIELDS_OK).catch(() => {});
      },
    });
    assert.deepEqual(await request(FIELDS,opts), FIELDS_OK);
    assert.equal(opts.spawns(), 1);
  });

  test('a broker that never comes up: unavailable after the start timeout', async () => {
    const opts = options({ startTimeoutMs: 200, retryIntervalMs: 20 });
    const started = Date.now();
    await rejectsWith(request(FIELDS, opts), 'unavailable');
    assert.ok(Date.now() - started >= 200);
    assert.equal(opts.spawns(), 1);
  });

  test('a spawner that throws: unavailable', async () => {
    const opts = options({
      spawnBroker: () => {
        throw new Error('spawn failed');
      },
    });
    await rejectsWith(request(FIELDS, opts), 'unavailable');
  });

  test('displaced: reconnects and retries the same request once', async () => {
    const { requests } = await serve((_req, _socket, connection) => (connection === 1 ? DISPLACED : FIELDS_OK));
    assert.deepEqual(await request(FIELDS,options()), FIELDS_OK);
    assert.deepEqual(requests, [FIELDS, FIELDS]);
  });

  test('displaced twice: the second answer is returned, with no third try', async () => {
    const { requests } = await serve(() => DISPLACED);
    assert.deepEqual(await request(FIELDS,options()), DISPLACED);
    assert.equal(requests.length, 2);
  });

  test('displaced and gone: the retry spawns a broker', async () => {
    // The first broker stops listening (which unlinks its socket), then answers `displaced`.
    let first: Server | undefined;
    const { requests } = await serve(() => {
      first?.close();
      return DISPLACED;
    }).then((served) => {
      first = served.server;
      return served;
    });
    const opts = options({ spawnBroker: () => void serve(() => FIELDS_OK).catch(() => {}) });
    assert.deepEqual(await request(FIELDS,opts), FIELDS_OK);
    assert.equal(requests.length, 1);
    assert.equal(opts.spawns(), 1);
  });

  test('status displaced and gone: unavailable, with no spawn', async () => {
    let first: Server | undefined;
    first = (
      await serve(() => {
        first?.close();
        return DISPLACED;
      })
    ).server;
    const opts = options();
    await rejectsWith(request(STATUS, opts), 'unavailable');
    assert.equal(opts.spawns(), 0);
  });

  test('closed without an answer: retries once', async () => {
    const { requests } = await serve((_req, _socket, connection) => (connection === 1 ? 'close' : STATUS_OK));
    assert.deepEqual(await request(STATUS, options()), STATUS_OK);
    assert.equal(requests.length, 2);
  });

  test('closed without an answer twice: closed', async () => {
    const { requests } = await serve(() => 'close');
    await rejectsWith(request(FIELDS, options()), 'closed');
    assert.equal(requests.length, 2);
  });

  test('a request has no read timeout of its own: a slow answer arrives', async () => {
    await serve((_req, socket) => {
      setTimeout(() => socket.end(`${JSON.stringify(FIELDS_OK)}\n`), 300);
      return 'hang';
    });
    assert.deepEqual(await request(FIELDS,options()), FIELDS_OK);
  });

  test('a caller-given timeout ends a request that gets no answer', async () => {
    await serve(() => 'hang');
    await rejectsWith(request(STATUS, options({ timeoutMs: 100 })), 'timeout');
  });

  test('an answer that does not parse, or answers another op: protocol', async () => {
    await serve((_req, socket, connection) => {
      if (connection === 1) socket.end('not json\n');
      else socket.end(`${JSON.stringify(STATUS_OK)}\n`);
      return 'hang';
    });
    await rejectsWith(request(FIELDS, options()), 'protocol');
    await rejectsWith(request(FIELDS, options()), 'protocol');
  });
});

describe('socket trust', () => {
  const uid = process.getuid?.() ?? 0;

  /** The real lstat, except that `target` reports `owner` as its uid: tests cannot chown. */
  function ownedBy(target: string, owner: number): Lstat {
    return (p) => {
      const st = lstatSync(p);
      if (p !== target) return st;
      return {
        uid: owner,
        mode: st.mode,
        isDirectory: () => st.isDirectory(),
        isSocket: () => st.isSocket(),
        isSymbolicLink: () => st.isSymbolicLink(),
      };
    };
  }

  /** Rejects with BrokerError `untrusted` naming the socket path and `reason`. */
  async function refused(promise: Promise<unknown>, reason: string): Promise<void> {
    await assert.rejects(promise, (err: unknown) => {
      assert.ok(err instanceof BrokerError, String(err));
      assert.equal(err.code, 'untrusted');
      assert.ok(err.message.includes(path), err.message);
      assert.ok(err.message.includes(reason), err.message);
      return true;
    });
  }

  test('a socket directory owned by another user: untrusted, never connected, no broker started', async () => {
    const { connections } = await serve(() => FIELDS_OK);
    for (const req of [FIELDS, STATUS]) {
      const opts = options({ lstat: ownedBy(dirname(path), uid + 1) });
      await refused(request(req, opts), 'owned by another user');
      assert.equal(opts.spawns(), 0);
    }
    assert.equal(connections(), 0);
  });

  test('a socket owned by another user: untrusted, never connected, no broker started', async () => {
    const { connections } = await serve(() => FIELDS_OK);
    const opts = options({ lstat: ownedBy(path, uid + 1) });
    await refused(request(FIELDS,opts), 'owned by another user');
    assert.equal(connections(), 0);
    assert.equal(opts.spawns(), 0);
  });

  test('a socket directory open to the group or others: untrusted, never connected', async () => {
    const { connections } = await serve(() => FIELDS_OK);
    // The last mode leaves the owner write access, so the cleanup can remove the socket.
    for (const mode of [0o705, 0o750, 0o707, 0o770, 0o777]) {
      chmodSync(dirname(path), mode);
      const opts = options();
      await refused(request(FIELDS, opts), 'open to other users');
      assert.equal(opts.spawns(), 0, mode.toString(8));
    }
    assert.equal(connections(), 0);
  });

  test('a socket directory that is a symbolic link: untrusted, never connected', async () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    symlinkSync(elsewhere, dirname(path));
    const { connections } = await serve(() => FIELDS_OK);
    const opts = options();
    await refused(request(FIELDS, opts), 'symbolic link');
    assert.equal(connections(), 0);
    assert.equal(opts.spawns(), 0);
  });

  test('a socket path that is not a socket, or a directory that is not a directory: untrusted', async () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, '');
    const opts = options();
    await refused(request(FIELDS, opts), 'not a socket');
    rmSync(dirname(path), { recursive: true });
    writeFileSync(dirname(path), '');
    await refused(request(FIELDS, opts), 'not a directory');
    assert.equal(opts.spawns(), 0);
  });

  test('the check runs before every connect: a directory that turns untrusted after the spawn is refused', async () => {
    let served: Promise<{ connections: () => number }> | undefined;
    const opts = options({
      retryIntervalMs: 20,
      spawnBroker: () => {
        served = serve(() => FIELDS_OK).then((s) => {
          chmodSync(dirname(path), 0o777);
          return s;
        });
      },
    });
    await refused(request(FIELDS, opts), 'open to other users');
    assert.equal(opts.spawns(), 1);
    assert.ok(served !== undefined);
    assert.equal((await served).connections(), 0);
  });

  test('a 0700 directory of this user without a socket: spawns a broker, as with no directory', async () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const opts = options({ spawnBroker: () => void serve(() => FIELDS_OK).catch(() => {}) });
    assert.deepEqual(await request(FIELDS, opts), FIELDS_OK);
    assert.equal(opts.spawns(), 1);
  });
});

describe('brokerEnv', () => {
  test('passes the OP_BRIDGE_ settings and pins CLAUDE_PLUGIN_DATA to the state directory', () => {
    const env = brokerEnv(stateDir, { OP_BRIDGE_IDLE_MINUTES: '5', OP_BRIDGE_ACCOUNTS: 'a,b', PATH: '/usr/bin', HOME: '/home/x', UNSET: undefined });
    assert.equal(env['OP_BRIDGE_IDLE_MINUTES'], '5');
    assert.equal(env['OP_BRIDGE_ACCOUNTS'], 'a,b');
    assert.equal(env['CLAUDE_PLUGIN_DATA'], stateDir);
    assert.equal(env['PATH'], '/usr/bin');
    assert.equal('UNSET' in env, false);
  });
});

describe('startBroker', () => {
  test('starts dist/broker.js detached with the broker env, and request reaches it', async () => {
    const pluginRoot = join(root, 'plugin');
    mkdirSync(join(pluginRoot, 'dist'), { recursive: true });
    // A fake broker: answers one request with the env it got, then exits.
    writeFileSync(
      join(pluginRoot, 'dist', 'broker.js'),
      [
        "import { createServer } from 'node:net';",
        "import { mkdirSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const dir = join(process.env.CLAUDE_PLUGIN_DATA, 'run');",
        'mkdirSync(dir, { recursive: true, mode: 0o700 });',
        'setTimeout(() => process.exit(0), 10000);',
        'const server = createServer((s) => s.once("data", () => {',
        '  const answer = { ok: true, op: "fields", vault: process.env.OP_BRIDGE_PROBE ?? "", item: { title: "t", category: "c" }, fields: [] };',
        '  s.end(JSON.stringify(answer) + "\\n", () => server.close(() => process.exit(0)));',
        '}));',
        `server.listen(join(dir, 'broker-v${PROTOCOL_VERSION}.sock'));`,
        '',
      ].join('\n'),
    );
    writeFileSync(join(pluginRoot, 'package.json'), '{"type":"module"}\n');
    const opts = options({ spawnBroker: () => startBroker(pluginRoot, stateDir, { ...process.env, OP_BRIDGE_PROBE: 'probe-vault' }) });
    const response = await request(FIELDS, opts);
    assert.equal(response.ok && response.op === 'fields' ? response.vault : undefined, 'probe-vault');
  });
});
