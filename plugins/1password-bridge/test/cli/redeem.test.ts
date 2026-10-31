import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { EXIT_CODES, OTHER_FAILURE_EXIT, runCli, USAGE } from '../../src/cli/redeem.ts';
import { brokerSocketPath } from '../../src/mcp/broker-client.ts';
import {
  encodeAck,
  encodeLine,
  lineReader,
  MAX_LINE_BYTES,
  parseAck,
  parseRequest,
  type LineReader,
  type Request,
  type Response,
} from '../../src/protocol.ts';

const TICKET = 'tkt_abcdefghijklmnop';
const SESSION = 'session-0000-test';
const VALUE = 'synthetic-api-token-value';
const STDOUT_DISCARDED =
  'op-bridge: usage: stdout is closed or /dev/null, so the value would be lost; nothing was sent: capture it with "$(op-bridge redeem <ticket>)"';

let root: string;
let stateDir: string;
let server: Server | undefined;
let connections: Socket[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'op-cli-'));
  stateDir = join(root, 'state');
});

afterEach(async () => {
  // A test that timed out may leave a connection open, and close() waits for every connection.
  for (const socket of connections) socket.destroy();
  connections = [];
  if (server !== undefined) await new Promise((resolve) => server?.close(resolve));
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

type Script = (req: Request | null, lines: LineReader, socket: Socket) => Promise<void>;

/** A fake broker on the CLI's socket path; records the request and the acknowledgements it reads. */
async function broker(script: Script): Promise<{ requests: (Request | null)[] }> {
  const requests: (Request | null)[] = [];
  const path = brokerSocketPath(stateDir, {});
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  server = createServer((socket) => {
    connections.push(socket);
    socket.on('error', () => {});
    const lines = lineReader(socket);
    void lines.next().then(async (line) => {
      const req = line === null ? null : parseRequest(line);
      requests.push(req);
      await script(req, lines, socket);
    });
  });
  await new Promise<void>((resolve) => server?.listen(path, resolve));
  return { requests };
}

type Sink = { stream: Writable; text(): string };

/**
 * A stdout stand-in that behaves like process.stdout. It has no 'error'
 * listener of its own, so an 'error' the CLI does not listen for is an
 * uncaught exception here as it is in the real CLI. A failed write calls back
 * with EPIPE and then emits 'error'. With `hold`, each write calls back only
 * once `hold` settles, like a pipe whose reader is slow. With `events`, each
 * write is logged as `stdout write` when it starts and, if it went through, as
 * `stdout written` just before it calls back.
 */
function sink(options: { fail?: boolean; hold?: Promise<void>; events?: string[] } = {}): Sink {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      options.events?.push('stdout write');
      if (options.fail === true) {
        callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        return;
      }
      chunks.push(chunk.toString('utf8'));
      const done = (): void => {
        options.events?.push('stdout written');
        callback();
      };
      if (options.hold === undefined) done();
      else void options.hold.then(done);
    },
  });
  return { stream, text: () => chunks.join('') };
}

async function cli(argv: string[], options: { env?: Record<string, string>; out?: Sink; discarded?: boolean } = {}) {
  const out = options.out ?? sink();
  const errors: string[] = [];
  const code = await runCli(argv, {
    env: options.env ?? { CLAUDE_CODE_SESSION_ID: SESSION, OP_BRIDGE_STATE_DIR: stateDir },
    stdout: out.stream,
    stdoutDiscarded: () => options.discarded ?? false,
    writeError: (line) => errors.push(line),
  });
  return { code, stdout: out.text(), errors };
}

const answer = (socket: Socket, res: Response): void => {
  socket.write(encodeLine(res));
};

/** Lets a connection or a request the CLI started just before it returned reach the fake broker. */
const ioTurn = (): Promise<void> => sleep(50);

// Passed to each test, so a deadlocked redemption fails its own test after 10 s, by name. A
// timeout on the describe would cancel every test still to run instead and name none of them.
const LIMIT = { timeout: 10_000 };

describe('op-bridge redeem', () => {
  test('prints the value exactly, written after received is sent and before delivered', LIMIT, async () => {
    // One timeline for both sides. The CLI's own socket comes from the net.client.socket channel,
    // so `received sent` is logged when the CLI writes it, in the same tick as the stdout write
    // that must follow it; the broker reads it an I/O turn later, after either order. The write
    // calls back 100 ms after the broker has read `received` (or after 1 s), so a `delivered`
    // sent before the write's callback reaches the broker first.
    const events: string[] = [];
    const RECEIVED = encodeAck('received');
    // Wrapped on 'connect': Node sets the socket's own write after publishing it. This listener
    // runs before the one the CLI adds, so every write the CLI makes goes through the wrapper.
    const watch = (message: unknown): void => {
      const socket = (message as { socket: Socket }).socket;
      socket.once('connect', () => {
        const write = socket.write.bind(socket) as (...args: unknown[]) => boolean;
        socket.write = ((chunk: unknown, ...rest: unknown[]) => {
          if (chunk === RECEIVED) events.push('received sent');
          return write(chunk, ...rest);
        }) as Socket['write'];
      });
    };
    let sawReceived!: () => void;
    const received = new Promise<void>((resolve) => {
      sawReceived = resolve;
    });
    const { requests } = await broker(async (_req, lines, socket) => {
      answer(socket, { ok: true, op: 'redeem', value: VALUE });
      events.push(String(parseAck(await lines.next())));
      sawReceived();
      events.push(String(parseAck(await lines.next())));
      socket.end();
    });
    const hold = Promise.race([received, sleep(1000, undefined, { ref: false })]).then(() => sleep(100));
    subscribe('net.client.socket', watch);
    let result;
    try {
      result = await cli(['redeem', TICKET], { out: sink({ hold, events }) });
    } finally {
      unsubscribe('net.client.socket', watch);
    }
    assert.deepEqual(result, { code: 0, stdout: VALUE, errors: [] });
    assert.deepEqual(requests[0], { v: 2, op: 'redeem', ticket: TICKET, session: SESSION });
    assert.deepEqual(events, ['received sent', 'stdout write', 'received', 'stdout written', 'delivered']);
  });

  test('a failed stdout write sends not_delivered and exits 21 without printing the value', LIMIT, async () => {
    const acks: (string | null)[] = [];
    await broker(async (_req, lines, socket) => {
      answer(socket, { ok: true, op: 'redeem', value: VALUE });
      acks.push(parseAck(await lines.next()));
      acks.push(parseAck(await lines.next()));
      socket.end();
    });
    const out = sink({ fail: true });
    const result = await cli(['redeem', TICKET], { out });
    // The sink emits 'error' after the failed write's callback, as process.stdout does on EPIPE. If the
    // CLI had dropped its listener, that event would be an uncaught exception and fail this test.
    await new Promise((resolve) => setImmediate(resolve));
    assert.notEqual(out.stream.errored, null);
    assert.equal(result.code, EXIT_CODES.not_delivered);
    assert.deepEqual(acks, ['received', 'not_delivered']);
    assert.deepEqual(result.errors, [
      'op-bridge: not_delivered: Delivering the value to stdout failed; the ticket can be redeemed again while its 10 minutes last and it was not released',
    ]);
    assert.ok(!result.errors.join('').includes(VALUE));
  });

  test('a broker that closes during the stdout write lets the redemption settle', { timeout: 5000 }, async () => {
    let brokerClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      brokerClosed = resolve;
    });
    await broker(async (_req, lines, socket) => {
      answer(socket, { ok: true, op: 'redeem', value: VALUE });
      await lines.next();
      socket.once('close', () => brokerClosed());
      socket.destroy();
    });
    // The write calls back only after the broker's close has reached the CLI, so the CLI's
    // 'close' fires before it sends its last acknowledgement; waiting only for a future
    // 'close' would never settle and the timeout would fail the test.
    const hold = closed.then(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
    const result = await cli(['redeem', TICKET], { out: sink({ hold }) });
    assert.deepEqual(result, { code: 0, stdout: VALUE, errors: [] });
  });

  const table: [string, number][] = [
    ['denied', 10],
    ['expired', 11],
    ['busy', 12],
    ['not_owner', 13],
    ['other_agent', 14],
    ['no_command', 15],
    ['unknown', 16],
    ['used', 17],
    ['voided', 18],
    ['field_gone', 19],
    ['no_dialog', OTHER_FAILURE_EXIT],
    ['internal', OTHER_FAILURE_EXIT],
  ];
  for (const [code, exit] of table) {
    test(`broker failure ${code} exits ${exit} with one stderr line`, LIMIT, async () => {
      await broker(async (_req, _lines, socket) => {
        socket.end(encodeLine({ ok: false, code: code as 'denied', message: `the ${code}\nmessage` }));
      });
      const result = await cli(['redeem', TICKET]);
      assert.deepEqual(result, { code: exit, stdout: '', errors: [`op-bridge: ${code}: the ${code} message`] });
    });
  }

  // Each "without a connection" test waits an I/O turn after the CLI returns: a connection or a
  // request started just before the CLI returned reaches the fake broker only then.
  test('usage: wrong arguments exit 2 without a connection', LIMIT, async () => {
    const { requests } = await broker(async () => {});
    for (const argv of [[], ['redeem'], ['redeem', 'not-a-ticket'], ['get', TICKET], ['redeem', TICKET, 'extra']]) {
      assert.deepEqual(await cli(argv), { code: EXIT_CODES.usage, stdout: '', errors: [USAGE] });
    }
    await ioTurn();
    assert.equal(connections.length, 0);
    assert.equal(requests.length, 0);
  });

  test('no session id is not_owner, without a connection', LIMIT, async () => {
    const { requests } = await broker(async () => {});
    const envs: Record<string, string>[] = [{ OP_BRIDGE_STATE_DIR: stateDir }, { OP_BRIDGE_STATE_DIR: stateDir, CLAUDE_CODE_SESSION_ID: '' }];
    for (const env of envs) {
      assert.deepEqual(await cli(['redeem', TICKET], { env }), {
        code: EXIT_CODES.not_owner,
        stdout: '',
        errors: [
          'op-bridge: not_owner: CLAUDE_CODE_SESSION_ID is not set; run op-bridge inside a Bash command of the Claude Code session that issued the ticket',
        ],
      });
    }
    await ioTurn();
    assert.equal(connections.length, 0);
    assert.equal(requests.length, 0);
  });

  test('a session id that is not a Claude Code session id is not_owner, without a connection', LIMIT, async () => {
    const { requests } = await broker(async (_req, _lines, socket) => {
      socket.destroy();
    });
    for (const session of ['../escape', 'two words', 'x'.repeat(129)]) {
      assert.deepEqual(await cli(['redeem', TICKET], { env: { OP_BRIDGE_STATE_DIR: stateDir, CLAUDE_CODE_SESSION_ID: session } }), {
        code: EXIT_CODES.not_owner,
        stdout: '',
        errors: [
          'op-bridge: not_owner: CLAUDE_CODE_SESSION_ID is not a Claude Code session id; run op-bridge inside a Bash command of the Claude Code session that issued the ticket',
        ],
      });
    }
    await ioTurn();
    assert.equal(connections.length, 0);
    assert.equal(requests.length, 0);
  });

  test('a closed or /dev/null stdout is refused with exit 2, without a connection', LIMIT, async () => {
    const { requests } = await broker(async (_req, _lines, socket) => {
      socket.destroy();
    });
    assert.deepEqual(await cli(['redeem', TICKET], { discarded: true }), {
      code: EXIT_CODES.usage,
      stdout: '',
      errors: [STDOUT_DISCARDED],
    });
    await ioTurn();
    assert.equal(connections.length, 0);
    assert.equal(requests.length, 0);
  });

  const BROKER_DOWN = {
    code: EXIT_CODES.broker_down,
    stdout: '',
    errors: ['op-bridge: broker_down: The 1password-bridge broker is not reachable; if it stopped, its tickets are gone: call issue_tickets for a new one'],
  };

  test('no broker, or a broker closing without an answer line, is broker_down', LIMIT, async () => {
    assert.deepEqual(await cli(['redeem', TICKET]), BROKER_DOWN);
    await broker(async (_req, _lines, socket) => {
      socket.destroy();
    });
    assert.deepEqual(await cli(['redeem', TICKET]), BROKER_DOWN);
  });

  test('a socket directory open to other users is untrusted: exit 1, nothing sent', LIMIT, async () => {
    const { requests } = await broker(async () => {});
    const path = brokerSocketPath(stateDir, {});
    // Restored in finally: when the path falls back to <tmp>/1password-bridge-<uid>/, the directory is shared.
    chmodSync(dirname(path), 0o755);
    try {
      assert.deepEqual(await cli(['redeem', TICKET]), {
        code: OTHER_FAILURE_EXIT,
        stdout: '',
        errors: [`op-bridge: untrusted: Refusing to connect to the 1password-bridge broker socket ${path}: its directory is open to other users.`],
      });
      assert.equal(requests.length, 0);
    } finally {
      chmodSync(dirname(path), 0o700);
    }
  });

  const PROTOCOL = {
    code: OTHER_FAILURE_EXIT,
    stdout: '',
    errors: ['op-bridge: protocol: The broker sent an answer op-bridge does not understand'],
  };

  // Written raw: none of these is a Response the types allow.
  const unreadable: [string, string][] = [
    ['a line that is not JSON', 'not json'],
    ['an ok answer of another op, with a value', JSON.stringify({ ok: true, op: 'status', value: VALUE, accounts: [], exitsAt: '2026-10-31T00:00:00.000Z' })],
    ['an ok redeem answer without a value', JSON.stringify({ ok: true, op: 'redeem' })],
    ['a failure with a code the protocol does not have', JSON.stringify({ ok: false, code: 'no_such_code', message: 'the message' })],
  ];
  for (const [name, line] of unreadable) {
    test(`${name} is protocol, exit 1`, LIMIT, async () => {
      await broker(async (_req, _lines, socket) => {
        socket.end(`${line}\n`);
      });
      assert.deepEqual(await cli(['redeem', TICKET]), PROTOCOL);
    });
  }

  test('an answer line longer than the protocol allows is protocol, exit 1, and prints nothing', LIMIT, async () => {
    await broker(async (_req, _lines, socket) => {
      // A well-formed answer: read past the line limit, its value would be printed.
      answer(socket, { ok: true, op: 'redeem', value: 'x'.repeat(MAX_LINE_BYTES) });
    });
    assert.deepEqual(await cli(['redeem', TICKET]), PROTOCOL);
  });
});
