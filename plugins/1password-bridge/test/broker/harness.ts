/** A broker on a temporary socket, with a fake 1Password account, and a line client for it. */

import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEntry } from '../../src/board.ts';
import type { Answer, Approval, Dialog } from '../../src/broker/dialog.ts';
import { startBroker, type Broker, type BrokerOptions } from '../../src/broker/service.ts';
import { encodeLine, lineReader, parseResponse, type LineReader, type Request, type Response } from '../../src/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/version.ts';
import { fakeAccount, type FakeAccount } from './fixtures.ts';

export const SESSION = 'session-0000-test';
export const OTHER_SESSION = 'session-1111-test';
export const TOKEN_REF = 'op://Deploy/Deploy server/api token';

export interface Harness {
  readonly stateDir: string;
  readonly account: FakeAccount;
  readonly options: BrokerOptions;
  readonly exits: number[];
  start(): Promise<Broker>;
  cleanup(): void;
}

export function harness(over: Partial<BrokerOptions> = {}): Harness {
  const stateDir = mkdtempSync(join(tmpdir(), 'op-tickets-'));
  const account = fakeAccount();
  const exits: number[] = [];
  const options: BrokerOptions = {
    socketPath: join(stateDir, 'run', `broker-v${PROTOCOL_VERSION}.sock`),
    stateDir,
    connect: async () => account,
    dialog: { ask: () => Promise.reject(new Error('no window expected')), close() {} },
    idleMs: 60_000,
    exit: (code) => {
      exits.push(code);
    },
    log: () => {},
    watchMs: 20,
    probeTimeoutMs: 200,
    stuckExitMs: 20,
    ...over,
  };
  let broker: Broker | null = null;
  return {
    stateDir,
    account,
    options,
    exits,
    async start() {
      broker = await startBroker(options);
      if (broker === null) throw new Error('the broker did not start');
      return broker;
    },
    cleanup() {
      broker?.server.close();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

export async function open(path: string): Promise<{ socket: Socket; lines: LineReader }> {
  const socket = connect(path);
  socket.on('error', () => {});
  await once(socket, 'connect');
  return { socket, lines: lineReader(socket) };
}

/** One request, one answer; null when the broker closed without one. */
export async function call(path: string, req: Request): Promise<Response | null> {
  const { socket, lines } = await open(path);
  socket.write(encodeLine(req));
  const line = await lines.next();
  socket.destroy();
  return line === null ? null : parseResponse(line, req.op);
}

export function issueRequest(over: Partial<Extract<Request, { op: 'issue_tickets' }>> = {}): Request {
  return {
    v: PROTOCOL_VERSION,
    op: 'issue_tickets',
    account: 'example.1password.test',
    accountLabel: 'Work',
    ref: TOKEN_REF,
    reason: 'deploy the staging site',
    count: 1,
    session: { id: SESSION, title: 'Deploy' },
    agent: { id: 'main' },
    ...over,
  };
}

/** Issues tickets and returns their ids. */
export async function issue(path: string, over: Partial<Extract<Request, { op: 'issue_tickets' }>> = {}): Promise<string[]> {
  const res = await call(path, issueRequest(over));
  if (res === null || !res.ok || res.op !== 'issue_tickets') throw new Error(`issue failed: ${JSON.stringify(res)}`);
  return res.tickets;
}

export interface Shown {
  approval: Approval;
  signal: AbortSignal | undefined;
  answer(a: Answer): void;
}

/** Windows that stay open until the test answers them; a cancel answers `cancelled`. */
export function scriptedDialog(): { dialog: Dialog; shown: Shown[] } {
  const shown: Shown[] = [];
  return {
    shown,
    dialog: {
      ask(approval, signal) {
        return new Promise<Answer>((resolve) => {
          if (signal?.aborted === true) {
            resolve('cancelled');
            return;
          }
          signal?.addEventListener('abort', () => resolve('cancelled'), { once: true });
          shown.push({ approval, signal, answer: resolve });
        });
      },
      close() {},
    },
  };
}

let toolUses = 0;

/** Puts a running command on the session's board; returns its tool_use_id. */
export function running(stateDir: string, command: string, agent = 'main', session = SESSION): string {
  const id = `toolu_${++toolUses}`;
  writeEntry(stateDir, session, { agent_id: agent, tool_use_id: id, command, cwd: '/work/site', startedAt: Date.now(), timeoutMs: 120_000 });
  return id;
}

export function redeemRequest(ticket: string, session = SESSION): Request {
  return { v: PROTOCOL_VERSION, op: 'redeem', ticket, session };
}

/** A redeem connection left open for the test to drive. */
export async function redeemOpen(path: string, ticket: string, session = SESSION): Promise<{ socket: Socket; lines: LineReader }> {
  const c = await open(path);
  c.socket.write(encodeLine(redeemRequest(ticket, session)));
  return c;
}

export async function waitFor(what: string, condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
