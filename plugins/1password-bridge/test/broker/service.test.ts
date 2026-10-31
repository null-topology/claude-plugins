import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Answer, Approval, Dialog } from '../../src/broker/dialog.ts';
import {
  brokerLogPath,
  idleWindowMs,
  MAX_BROKER_LOG_BYTES,
  openBrokerLog,
  startBroker,
  type Broker,
  type BrokerOptions,
} from '../../src/broker/service.ts';
import { encodeLine, parseResponse, readLine, type Request, type Response } from '../../src/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/version.ts';
import { fakeAccount, TOKEN_VALUE } from './fixtures.ts';

const STATUS: Request = { v: PROTOCOL_VERSION, op: 'status' };
const FIELDS: Request = { v: PROTOCOL_VERSION, op: 'fields', account: 'ACCOUNTUUID', ref: 'op://Deploy/Deploy server' };

let dir: string;
let path: string;
let servers: Server[];
let clients: Socket[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'op-svc-'));
  path = join(dir, 'run', `broker-v${PROTOCOL_VERSION}.sock`);
  servers = [];
  clients = [];
});

afterEach(async () => {
  // A request left unanswered by a failing test would keep its server from closing.
  for (const client of clients) client.destroy();
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  rmSync(dir, { recursive: true, force: true });
});

function fakeDialog(answers: Answer[], onAsk: () => void = () => {}): Dialog & { asked: Approval[] } {
  const asked: Approval[] = [];
  return {
    asked,
    async ask(a) {
      asked.push(a);
      onAsk();
      return answers.shift() ?? 'deny';
    },
    close() {},
  };
}

function setup(over: Partial<BrokerOptions> = {}) {
  const account = fakeAccount();
  const events: string[] = [];
  const dialog = fakeDialog(['approve'], () => events.push(`window after ${account.calls.length} calls`));
  const exits: number[] = [];
  let exited!: (code: number) => void;
  const exitedOnce = new Promise<number>((resolve) => (exited = resolve));
  const logs: unknown[] = [];
  const options: BrokerOptions = {
    socketPath: path,
    stateDir: dirname(dirname(path)),
    connect: async () => account,
    dialog,
    idleMs: 60_000,
    exit: (code) => {
      exits.push(code);
      exited(code);
    },
    log: (event, detail) => logs.push({ event, ...detail }),
    watchMs: 20,
    probeTimeoutMs: 200,
    stuckExitMs: 20,
    ...over,
  };
  return { account, dialog, events, exits, exitedOnce, logs, options };
}

async function start(options: BrokerOptions): Promise<Broker | null> {
  const broker = await startBroker(options);
  if (broker !== null) servers.push(broker.server);
  return broker;
}

function send(req: Request, socketPath = path): Promise<Response | null> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(socketPath, () => {
      socket.write(encodeLine(req));
      readLine(socket).then((line) => {
        socket.destroy();
        resolve(line === null ? null : parseResponse(line, req.op));
      }, reject);
    });
    clients.push(socket);
    socket.on('error', reject);
  });
}

function failure(res: Response | null): string {
  assert.ok(res !== null && !res.ok, `expected a failure, got ${JSON.stringify(res)}`);
  return res.code;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('fields and status', () => {
  test('fields lists metadata without values or a window', async () => {
    const s = setup();
    await start(s.options);
    const res = await send(FIELDS);
    assert.ok(res?.ok === true && res.op === 'fields');
    assert.equal(res.vault, 'Deploy');
    assert.ok(res.fields.some((f) => f.title === 'api token'));
    assert.ok(!JSON.stringify(res).includes(TOKEN_VALUE));
    assert.equal(s.dialog.asked.length, 0);
  });

  test('status lists warm accounts and the idle exit time', async () => {
    const s = setup();
    await start(s.options);
    const before = await send(STATUS);
    assert.ok(before?.ok === true && before.op === 'status');
    assert.deepEqual(before.accounts, []);
    await send(FIELDS);
    const after = await send(STATUS);
    assert.ok(after?.ok === true && after.op === 'status');
    assert.deepEqual(after.accounts, [{ account: 'ACCOUNTUUID', warm: true }]);
    assert.ok(Date.parse(after.exitsAt) > Date.now() + 50_000);
  });
});

describe('single instance', () => {
  test('a second broker exits while the first serves', async () => {
    const first = setup();
    assert.ok(await start(first.options));
    const second = setup();
    assert.equal(await start(second.options), null);
    assert.deepEqual(second.exits, [0]);
    assert.equal((await send(STATUS))?.ok, true);
    assert.deepEqual(first.exits, []);
  });

  test('three brokers started at once on a stale socket leave exactly one serving', async () => {
    mkdirSync(dirname(path), { recursive: true });
    const script = `require('net').createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`;
    assert.equal(spawnSync(process.execPath, ['-e', script]).status, 0);
    assert.ok(existsSync(path), 'a stale socket file nobody listens on');
    const setups = [setup(), setup(), setup()];
    const brokers = await Promise.all(setups.map((s) => start(s.options)));
    const answers = await Promise.all([send(STATUS), send(FIELDS), send(STATUS)]);
    assert.ok(answers.every((a) => a !== null), 'every request answered');
    await wait(200);
    const serving = brokers.filter((b, i) => b !== null && setups[i]?.exits.length === 0);
    assert.equal(serving.length, 1);
    assert.equal(serving[0]?.owns(), true);
    assert.equal((await send(STATUS))?.ok, true);
  });
});

describe('displacement', () => {
  test('a replaced socket path answers displaced, calls no SDK and exits without unlinking the new socket', async () => {
    const s = setup();
    const broker = await start(s.options);
    assert.ok(broker);
    const socket = connect(path);
    await new Promise((resolve) => socket.once('connect', resolve));
    unlinkSync(path);
    const replacement = createServer();
    servers.push(replacement);
    await new Promise<void>((resolve) => replacement.listen(path, resolve));
    const ino = statSync(path).ino;
    socket.write(encodeLine(FIELDS));
    const line = await readLine(socket);
    socket.destroy();
    assert.equal(failure(parseResponse(line as string, 'fields')), 'displaced');
    assert.deepEqual(s.account.calls, [], 'no SDK call');
    assert.equal(await s.exitedOnce, 0);
    assert.equal(broker.owns(), false);
    assert.ok(existsSync(path) && statSync(path).ino === ino, 'the new socket is left in place');
  });
});

describe('configuration and log', () => {
  test('idle window from OP_BRIDGE_IDLE_MINUTES, 60 minutes by default', () => {
    assert.equal(idleWindowMs('5'), 5 * 60_000);
    assert.equal(idleWindowMs('0.5'), 30_000);
    for (const bad of [undefined, '', ' ', '0', '-3', 'soon']) assert.equal(idleWindowMs(bad), 60 * 60_000, String(bad));
  });

  test('the log appends JSON lines 0600 and is cut back once over 1 MB at start', () => {
    const stateDir = join(dir, 'state');
    const log = openBrokerLog(stateDir);
    log('start', { result: 'listening' });
    const path = brokerLogPath(stateDir);
    const first = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>;
    assert.equal(first['event'], 'start');
    assert.equal(first['result'], 'listening');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    writeFileSync(path, 'x'.repeat(MAX_BROKER_LOG_BYTES + 1));
    openBrokerLog(stateDir)('exit');
    assert.equal(readFileSync(path, 'utf8').split('\n').filter(Boolean).length, 1);
  });
});

describe('exit', () => {
  test('onStuck answers auth_timeout, removes its own socket and exits', async () => {
    const s = setup({ connect: () => new Promise(() => {}), operationTimeoutMs: 50 });
    await start(s.options);
    const [first, second] = await Promise.all([send(FIELDS), send(FIELDS)]);
    assert.equal(failure(first), 'auth_timeout');
    assert.equal(failure(second), 'auth_timeout');
    assert.equal(await s.exitedOnce, 1);
    assert.equal(existsSync(path), false);
  });
});
