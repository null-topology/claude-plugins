/**
 * `op-bridge redeem <ticket>`: asks the broker for a ticket's value and
 * prints it once to stdout, exactly, with no newline, after the user has
 * approved the use in the broker's window.
 *
 * One connection: the request; the broker's answer (the value or a failure);
 * `received`; the value written to stdout; `delivered` once the write went
 * through, or `not_delivered`. A dying CLI closes the socket and the broker
 * takes the close as the cancel, so there are no signal handlers. stderr gets
 * one line per failure and never a value.
 */

import type { Socket } from 'node:net';
import type { Writable } from 'node:stream';
import { BrokerError, brokerSocketPath, connectSocket } from '../mcp/broker-client.ts';
import { isSessionId, resolveStateDir, type Environment } from '../paths.ts';
import { encodeAck, encodeLine, lineReader, parseResponse, TICKET_ID_PATTERN, type AckOp } from '../protocol.ts';
import { PROTOCOL_VERSION } from '../version.ts';

export const EXIT_CODES = {
  usage: 2,
  denied: 10,
  expired: 11,
  busy: 12,
  not_owner: 13,
  other_agent: 14,
  no_command: 15,
  unknown: 16,
  used: 17,
  voided: 18,
  field_gone: 19,
  broker_down: 20,
  not_delivered: 21,
} as const;

/**
 * Any other failure: no window backend, 1Password refused or timed out, an
 * internal error; and two of the CLI's own, `untrusted` (the socket or its
 * directory failed the owner and mode check, nothing was sent) and `protocol`
 * (an answer line that does not parse).
 */
export const OTHER_FAILURE_EXIT = 1;

export const USAGE = 'usage: op-bridge redeem <ticket>';

/** Nobody answers on the socket, or the connection closed with no answer line. */
const BROKER_DOWN_MESSAGE = 'The 1password-bridge broker is not reachable; if it stopped, its tickets are gone: call issue_tickets for a new one';
const PROTOCOL_MESSAGE = 'The broker sent an answer op-bridge does not understand';

export interface CliIo {
  readonly env: Environment;
  readonly stdout: Writable;
  /** True when stdout is closed or the null device, where a value written would be lost. */
  stdoutDiscarded(): boolean;
  writeError(line: string): void;
}

function exitFor(code: string): number {
  return Object.hasOwn(EXIT_CODES, code) ? EXIT_CODES[code as keyof typeof EXIT_CODES] : OTHER_FAILURE_EXIT;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Writes `text`; true once the write callback reports success. The 'error'
 * listener stays for the whole write and after it: a failed write calls back
 * first and emits 'error' afterwards, and on process.stdout an 'error' without
 * a listener (EPIPE once the reader has gone) would kill the CLI before it
 * sends not_delivered and exits 21.
 */
function writeOut(out: Writable, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    out.on('error', () => resolve(false));
    try {
      out.write(text, (err) => resolve(err === null || err === undefined));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Sends the last acknowledgement unless the broker has already gone, then
 * waits for the close. `closed` was created at connect time, so a close that
 * happened during the stdout write has already settled it.
 */
async function finish(socket: Socket, closed: Promise<void>, ack: AckOp): Promise<void> {
  if (!socket.destroyed) socket.end(encodeAck(ack));
  await closed;
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const failed = (code: string, message: string): number => {
    io.writeError(`op-bridge: ${code}: ${oneLine(message)}`);
    return exitFor(code);
  };
  const ticket = argv[1];
  if (argv.length !== 2 || argv[0] !== 'redeem' || ticket === undefined || !TICKET_ID_PATTERN.test(ticket)) {
    io.writeError(USAGE);
    return EXIT_CODES.usage;
  }
  const session = io.env['CLAUDE_CODE_SESSION_ID'];
  if (session === undefined || session === '') {
    return failed('not_owner', 'CLAUDE_CODE_SESSION_ID is not set; run op-bridge inside a Bash command of the Claude Code session that issued the ticket');
  }
  // The broker refuses a request with such an id, so nothing is sent; the message does not repeat it.
  if (!isSessionId(session)) {
    return failed('not_owner', 'CLAUDE_CODE_SESSION_ID is not a Claude Code session id; run op-bridge inside a Bash command of the Claude Code session that issued the ticket');
  }
  // A write to the null device succeeds, so the CLI would confirm delivery of a
  // value nobody received; refusing before the connection leaves the ticket unused.
  if (io.stdoutDiscarded()) {
    return failed('usage', 'stdout is closed or /dev/null, so the value would be lost; nothing was sent: capture it with "$(op-bridge redeem <ticket>)"');
  }
  let socket: Socket;
  try {
    const stateDir = io.env['OP_BRIDGE_STATE_DIR'] || resolveStateDir(io.env);
    socket = await connectSocket(brokerSocketPath(stateDir, io.env));
  } catch (err) {
    // BrokerError `untrusted` names only the socket path and the failed check; nothing was sent.
    if (err instanceof BrokerError && err.code === 'untrusted') return failed('untrusted', err.message);
    return failed('broker_down', BROKER_DOWN_MESSAGE);
  }
  socket.on('error', () => {});
  // Listened for from the start: the broker may close while the value is being written to stdout.
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const lines = lineReader(socket);
  socket.write(encodeLine({ v: PROTOCOL_VERSION, op: 'redeem', ticket, session }));
  // null: the connection closed or failed with no line. next() rejects only with FrameError, an
  // answer line too long to read, which is an answer op-bridge does not understand.
  const line = await lines.next().catch(() => undefined);
  if (line === null) {
    socket.destroy();
    return failed('broker_down', BROKER_DOWN_MESSAGE);
  }
  const response = line === undefined ? null : parseResponse(line, 'redeem');
  // parseResponse already refuses an answer of another op; the op check narrows the type.
  if (response === null || (response.ok && response.op !== 'redeem')) {
    socket.destroy();
    return failed('protocol', PROTOCOL_MESSAGE);
  }
  if (!response.ok) {
    socket.destroy();
    return failed(response.code, response.message);
  }
  socket.write(encodeAck('received'));
  const written = await writeOut(io.stdout, response.value);
  await finish(socket, closed, written ? 'delivered' : 'not_delivered');
  return written
    ? 0
    : failed('not_delivered', 'Delivering the value to stdout failed; the ticket can be redeemed again while its 10 minutes last and it was not released');
}
