import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { writeEntry } from '../../src/board.ts';
import { dispatch, keepSession, runHook } from '../../src/hooks/run.ts';
import { hookLogPath } from '../../src/hooks/log.ts';
import { postToolUse as postToolUseHook, withheldNote } from '../../src/hooks/post-tool-use.ts';
import { brokerAsk } from '../../src/hooks/broker.ts';
import { BrokerError, brokerSocketPath } from '../../src/mcp/broker-client.ts';
import { boardDir, lastSeenPath } from '../../src/paths.ts';
import { MAX_LINE_BYTES, MAX_OUTPUT_BYTES } from '../../src/protocol.ts';
import { markTicket } from '../../src/session-files.ts';
import { PROTOCOL_VERSION } from '../../src/version.ts';
import { context, sandbox, SECRET, SESSION_ID, type Sandbox } from './helpers.ts';

const TICKET = 'tkt_aaaaaaaaaaaaaaaa';

let box: Sandbox;
let servers: Server[];
let sockets: Socket[];

beforeEach(() => {
  box = sandbox('op-run-');
  servers = [];
  sockets = [];
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  box.cleanup();
});

async function run(stdin: string): Promise<string[]> {
  const written: string[] = [];
  await runHook({
    stdin: Readable.from([Buffer.from(stdin)]),
    env: { CLAUDE_PLUGIN_DATA: box.stateDir, CLAUDE_PLUGIN_ROOT: '/plugin-root' },
    write: (text) => written.push(text),
  });
  return written;
}

function postToolUse(stdout: string) {
  return {
    hook_event_name: 'PostToolUse',
    session_id: SESSION_ID,
    transcript_path: '/t.jsonl',
    cwd: '/work',
    tool_name: 'Bash',
    tool_input: { command: 'env' },
    tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
  };
}

/**
 * A broker on the sandbox socket that masks SECRET the way the real one
 * does; records each request it reads.
 */
async function maskingBroker(): Promise<Record<string, unknown>[]> {
  const path = brokerSocketPath(box.stateDir, {});
  assert.ok(path.startsWith(box.stateDir), 'the test socket must live in the sandbox');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const req = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
      requests.push(req);
      const text = JSON.stringify(req['output']);
      const masked = text.replaceAll(SECRET, `<masked ticket=${TICKET}>`);
      const changed = masked !== text;
      socket.end(`${JSON.stringify({ ok: true, op: 'mask', known: true, changed, output: changed ? JSON.parse(masked) : null, missing: [] })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return requests;
}

/** A broker on the sandbox socket that answers with a line longer than MAX_OUTPUT_BYTES. */
async function oversizedBroker(): Promise<void> {
  const path = brokerSocketPath(box.stateDir, {});
  assert.ok(path.startsWith(box.stateDir), 'the test socket must live in the sandbox');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.once('data', () => socket.end(Buffer.alloc(MAX_OUTPUT_BYTES + 1, 0x78)));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

/** A broker on the sandbox socket that reads requests and never answers. */
async function silentBroker(): Promise<void> {
  const path = brokerSocketPath(box.stateDir, {});
  assert.ok(path.startsWith(box.stateDir), 'the test socket must live in the sandbox');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.resume();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

describe('dispatch', () => {
  test('an unknown or missing event: nothing', async () => {
    markTicket(box.stateDir, SESSION_ID, TICKET);
    assert.equal(await dispatch(context(box.stateDir, { hook_event_name: 'Notification', session_id: SESSION_ID })), undefined);
    assert.equal(await dispatch(context(box.stateDir, { session_id: SESSION_ID })), undefined);
  });

  test('routes PostToolUse to the broker masking', async () => {
    markTicket(box.stateDir, SESSION_ID, TICKET);
    const requests = await maskingBroker();
    const out = await dispatch(context(box.stateDir, postToolUse(SECRET)));
    assert.equal(out?.hookSpecificOutput?.hookEventName, 'PostToolUse');
    assert.equal(requests[0]?.['op'], 'mask');
  });
});

describe('runHook', () => {
  test('no marker: writes nothing, asks no broker and logs nothing', async () => {
    const requests = await maskingBroker();
    assert.deepEqual(await run(JSON.stringify(postToolUse(SECRET))), []);
    assert.equal(requests.length, 0);
    assert.equal(existsSync(hookLogPath(box.stateDir)), false);
  });

  test('a marker: writes one JSON document with the output the broker masked', async () => {
    markTicket(box.stateDir, SESSION_ID, TICKET);
    const requests = await maskingBroker();
    const written = await run(JSON.stringify(postToolUse(`TOKEN=${SECRET}`)));
    assert.equal(written.length, 1);
    assert.ok(!written.join('').includes(SECRET));
    const out = JSON.parse(written[0] ?? '') as { hookSpecificOutput: { updatedToolOutput: { stdout: string } } };
    assert.equal(out.hookSpecificOutput.updatedToolOutput.stdout, `TOKEN=<masked ticket=${TICKET}>`);
    assert.deepEqual(requests[0]?.['tickets'], [TICKET]);
  });

  test('a marker and no broker running: the output is withheld', async () => {
    markTicket(box.stateDir, SESSION_ID, TICKET);
    const written = await run(JSON.stringify(postToolUse(`TOKEN=${SECRET}`)));
    assert.equal(written.length, 1);
    assert.ok(!written.join('').includes(SECRET));
    const out = JSON.parse(written[0] ?? '') as { hookSpecificOutput: { updatedToolOutput: { stdout: string } } };
    assert.equal(out.hookSpecificOutput.updatedToolOutput.stdout, withheldNote([TICKET]));
  });

  test('a mask answer past MAX_OUTPUT_BYTES: the output is withheld, naming every marker ticket', { timeout: 30_000 }, async () => {
    const other = 'tkt_bbbbbbbbbbbbbbbb';
    markTicket(box.stateDir, SESSION_ID, TICKET);
    markTicket(box.stateDir, SESSION_ID, other);
    await oversizedBroker();
    const written = await run(JSON.stringify(postToolUse(`TOKEN=${SECRET}`)));
    assert.equal(written.length, 1);
    assert.ok(!written.join('').includes(SECRET));
    const out = JSON.parse(written[0] ?? '') as { hookSpecificOutput: { updatedToolOutput: { stdout: string } } };
    assert.equal(out.hookSpecificOutput.updatedToolOutput.stdout, withheldNote([TICKET, other]));
    assert.deepEqual(logged(), [{ event: 'PostToolUse', step: 'mask', code: 'PROTOCOL' }]);
    // The cause is the answer size, not a broker that closed early.
    const ask = brokerAsk(context(box.stateDir, postToolUse('x')));
    await assert.rejects(
      ask({ v: PROTOCOL_VERSION, op: 'mask', session: SESSION_ID, tickets: [TICKET], output: 'x' }),
      (err: unknown) => err instanceof BrokerError && err.code === 'protocol',
    );
  });

  test('a mask answer past MAX_LINE_BYTES but within MAX_OUTPUT_BYTES: the output comes back masked, not withheld', { timeout: 30_000 }, async () => {
    markTicket(box.stateDir, SESSION_ID, TICKET);
    await maskingBroker();
    const filler = 'x'.repeat(2 * MAX_LINE_BYTES);
    const written = await run(JSON.stringify(postToolUse(`${filler}TOKEN=${SECRET}`)));
    assert.ok(!written.join('').includes(SECRET));
    assert.equal(maskedStdout(written), `${filler}TOKEN=<masked ticket=${TICKET}>`);
    assert.equal(existsSync(hookLogPath(box.stateDir)), false);
  });

  test('a broker that does not answer in time: the output is withheld and the log records TIMEOUT', async () => {
    markTicket(box.stateDir, SESSION_ID, TICKET);
    await silentBroker();
    const ctx = context(box.stateDir, postToolUse(`TOKEN=${SECRET}`));
    const out = await postToolUseHook(ctx, brokerAsk(ctx, 100));
    const updated = out?.hookSpecificOutput?.updatedToolOutput as { stdout: string };
    assert.equal(updated.stdout, withheldNote([TICKET]));
    assert.deepEqual(logged(), [{ event: 'PostToolUse', step: 'mask', code: 'TIMEOUT' }]);
  });

  test('input that is not JSON: writes nothing and logs a code without the input', async () => {
    assert.deepEqual(await run(`{"tool_response": "${SECRET}"`), []);
    const log = readFileSync(hookLogPath(box.stateDir), 'utf8');
    assert.ok(!log.includes(SECRET));
    const line = JSON.parse(log.trim()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(line).sort(), ['at', 'code', 'event', 'step']);
    assert.equal(line['code'], 'SyntaxError');
    assert.equal(line['event'], 'unknown');
  });

  test('JSON that is not an object, or empty input: writes nothing', async () => {
    assert.deepEqual(await run('[1,2]'), []);
    assert.deepEqual(await run('null'), []);
    assert.deepEqual(await run(''), []);
  });

  test('input spread over many chunks is read to the end', async () => {
    markTicket(box.stateDir, SESSION_ID, TICKET);
    const requests = await maskingBroker();
    const text = JSON.stringify(postToolUse(`${'x'.repeat(200_000)}${SECRET}`));
    const chunks = [];
    for (let i = 0; i < text.length; i += 1000) chunks.push(Buffer.from(text.slice(i, i + 1000)));
    const written: string[] = [];
    await runHook({ stdin: Readable.from(chunks), env: { CLAUDE_PLUGIN_DATA: box.stateDir }, write: (t) => written.push(t) });
    assert.equal(written.length, 1);
    assert.ok(!written.join('').includes(SECRET));
    assert.equal(requests.length, 1);
  });
});

/** A foreground entry long past its age limit. */
const STALE_ENTRY = { agent_id: 'main', tool_use_id: 'toolu_old', command: 'x', cwd: '/', startedAt: 0, timeoutMs: 1000 };

/** The stdout of the one masked document a run wrote. */
function maskedStdout(written: readonly string[]): string {
  assert.equal(written.length, 1);
  const out = JSON.parse(written[0] ?? '') as { hookSpecificOutput: { updatedToolOutput: { stdout: string } } };
  return out.hookSpecificOutput.updatedToolOutput.stdout;
}

/** The event, step and code of each line in the hook log. */
function logged(): { event: unknown; step: unknown; code: unknown }[] {
  const text = readFileSync(hookLogPath(box.stateDir), 'utf8');
  return text
    .trim()
    .split('\n')
    .map((line) => {
      const { event, step, code } = JSON.parse(line) as Record<string, unknown>;
      return { event, step, code };
    });
}

describe('every hook run', () => {
  test('touches last-seen and deletes board entries past their age limit', () => {
    writeEntry(box.stateDir, SESSION_ID, STALE_ENTRY);
    keepSession(context(box.stateDir, { hook_event_name: 'PostToolUse', session_id: SESSION_ID }), 5_000_000);
    assert.equal(statSync(lastSeenPath(box.stateDir, SESSION_ID)).mtimeMs, 5_000_000);
    assert.deepEqual(readdirSync(boardDir(box.stateDir, SESSION_ID)), []);
  });

  test('SessionEnd is not touched, so the directory it removes is not recreated', () => {
    keepSession(context(box.stateDir, { hook_event_name: 'SessionEnd', session_id: SESSION_ID }), 1000);
    assert.equal(existsSync(lastSeenPath(box.stateDir, SESSION_ID)), false);
  });

  test('Stop and SubagentStop are dispatched without output', async () => {
    for (const event of ['Stop', 'SubagentStop']) {
      assert.equal(await dispatch(context(box.stateDir, { hook_event_name: event, session_id: SESSION_ID })), undefined);
    }
  });

  test('runHook creates last-seen and deletes a stale board entry', async () => {
    writeEntry(box.stateDir, SESSION_ID, STALE_ENTRY);
    assert.equal(existsSync(lastSeenPath(box.stateDir, SESSION_ID)), false);
    assert.deepEqual(await run(JSON.stringify(postToolUse('plain output'))), []);
    assert.ok(statSync(lastSeenPath(box.stateDir, SESSION_ID)).isFile());
    assert.deepEqual(readdirSync(boardDir(box.stateDir, SESSION_ID)), []);
    assert.equal(existsSync(hookLogPath(box.stateDir)), false);
  });

  test('a board that cannot be read logs step prune, and the output is still masked', async () => {
    markTicket(box.stateDir, SESSION_ID, TICKET);
    await maskingBroker();
    // A regular file where the board directory belongs: readdir fails with ENOTDIR, root or not.
    writeFileSync(boardDir(box.stateDir, SESSION_ID), '');
    const written = await run(JSON.stringify(postToolUse(`TOKEN=${SECRET}`)));
    assert.equal(maskedStdout(written), `TOKEN=<masked ticket=${TICKET}>`);
    assert.ok(statSync(lastSeenPath(box.stateDir, SESSION_ID)).isFile());
    assert.deepEqual(logged(), [{ event: 'PostToolUse', step: 'prune', code: 'ENOTDIR' }]);
  });

  test('a last-seen that cannot be touched logs step touch, the board is still pruned and the output still masked', async () => {
    markTicket(box.stateDir, SESSION_ID, TICKET);
    await maskingBroker();
    writeEntry(box.stateDir, SESSION_ID, STALE_ENTRY);
    // A symlink to itself: utimes fails with ELOOP, root or not.
    symlinkSync('last-seen', lastSeenPath(box.stateDir, SESSION_ID));
    const written = await run(JSON.stringify(postToolUse(`TOKEN=${SECRET}`)));
    assert.equal(maskedStdout(written), `TOKEN=<masked ticket=${TICKET}>`);
    assert.deepEqual(readdirSync(boardDir(box.stateDir, SESSION_ID)), []);
    assert.deepEqual(logged(), [{ event: 'PostToolUse', step: 'touch', code: 'ELOOP' }]);
  });
});
