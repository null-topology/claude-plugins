import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { KiroAcpClient } from '../../src/acp/client.ts';
import type { ProcessExit, ProcessHandle } from '../../src/acp/process.ts';

// Config snapshots are applied in the order Kiro wrote them: a session/new,
// session/load or session/set_config_option answer and a config_option_update
// written right next to it, in one chunk or in two writes of one tick. Measured
// with kiro-cli 2.32.0 on a cold start: the session/new answer lacks `model`
// and an update offering it follows about 200 ms later; these scripts put the
// two frames side by side, the tightest order the wire allows.

const SESSION = 'sess_00000000-0000-4000-8000-200000000001';

function select(id: string, currentValue: string, values: readonly string[]): SessionConfigOption {
  return { id, name: id, type: 'select', currentValue, options: values.map((value) => ({ value, name: value })) };
}

const MODE = select('mode', 'default', ['default']);
const MODEL_AUTO = select('model', 'auto', ['auto', 'other']);
const MODEL_OTHER = select('model', 'other', ['auto', 'other']);
const EFFORT = select('effortLevel', 'medium', ['low', 'medium', 'high']);

type Method = 'session/new' | 'session/load' | 'session/set_config_option';
type Order = 'after' | 'before';
type Delivery = 'one chunk' | 'two writes in one tick';

interface Request {
  readonly id: number;
  readonly method: string;
}

/** Per method: the list without the option, the list offering it, and the option. */
const CASES: Record<Method, { readonly lacking: SessionConfigOption[]; readonly offering: SessionConfigOption[]; readonly option: string }> = {
  'session/new': { lacking: [MODE], offering: [MODE, MODEL_AUTO], option: 'model' },
  'session/load': { lacking: [MODE], offering: [MODE, MODEL_AUTO], option: 'model' },
  'session/set_config_option': { lacking: [MODE, MODEL_OTHER], offering: [MODE, MODEL_OTHER, EFFORT], option: 'effortLevel' },
};

function answer(request: Request, result: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id: request.id, result };
}

function configUpdate(configOptions: SessionConfigOption[]): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: SESSION, update: { sessionUpdate: 'config_option_update', configOptions } },
  };
}

/**
 * A client over an in-process agent: each request of the client is answered
 * with the frames `script` returns, written in one chunk or one write each.
 */
function scriptedClient(t: TestContext, delivery: Delivery, script: (request: Request) => Record<string, unknown>[]) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let exit: ProcessExit | undefined;
  let resolveExit: (value: ProcessExit) => void = () => {};
  const exited = new Promise<ProcessExit>((resolve) => {
    resolveExit = resolve;
  });
  const handle = {
    pid: undefined,
    stdin,
    stdout,
    exited,
    get exit() {
      return exit;
    },
    kill: async (): Promise<ProcessExit> => {
      if (exit === undefined) {
        exit = { code: 0, signal: null };
        resolveExit(exit);
        stdout.end();
      }
      return exit;
    },
  };
  let pending = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    pending += chunk;
    for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
      const message = JSON.parse(pending.slice(0, end)) as Partial<Request>;
      pending = pending.slice(end + 1);
      if (typeof message.id !== 'number' || typeof message.method !== 'string') {
        continue;
      }
      const lines = script({ id: message.id, method: message.method }).map((frame) => `${JSON.stringify(frame)}\n`);
      if (delivery === 'one chunk') {
        stdout.write(lines.join(''));
      } else {
        for (const line of lines) {
          stdout.write(line);
        }
      }
    }
  });
  const client = new KiroAcpClient(handle as unknown as ProcessHandle, { decidePermission: () => 'deny' });
  t.after(() => client.terminate(0));
  return client;
}

const STEP = { timeoutMs: 5_000 } as const;

describe('KiroAcpClient: config snapshots in wire order (scripted transport)', () => {
  for (const method of Object.keys(CASES) as Method[]) {
    for (const order of ['after', 'before'] as Order[]) {
      for (const delivery of ['one chunk', 'two writes in one tick'] as Delivery[]) {
        const { lacking, offering, option } = CASES[method];
        const name =
          order === 'after'
            ? `${method}: an update offering ${option} right after the answer that lacks it is kept (${delivery})`
            : `${method}: an answer offering ${option} right after an update that lacks it supersedes it (${delivery})`;
        test(name, async (t) => {
          const client = scriptedClient(t, delivery, (request) => {
            if (request.method === 'initialize') {
              return [answer(request, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] })];
            }
            if (request.method !== method) {
              // The session the config change is made in.
              return [answer(request, { sessionId: SESSION, configOptions: [MODE, MODEL_AUTO] })];
            }
            const result = (configOptions: SessionConfigOption[]) =>
              answer(request, method === 'session/new' ? { sessionId: SESSION, configOptions } : { configOptions });
            return order === 'after'
              ? [result(lacking), configUpdate(offering)]
              : [configUpdate(lacking), result(offering)];
          });
          await client.initialize(STEP);
          if (method === 'session/load') {
            await client.loadSession({ sessionId: SESSION, cwd: '/work' }, STEP);
          } else {
            const { sessionId } = await client.newSession({ cwd: '/work' }, STEP);
            assert.equal(sessionId, SESSION);
            if (method === 'session/set_config_option') {
              await client.setConfig(SESSION, 'model', 'other', STEP);
            }
          }
          assert.deepEqual(
            client.configOptions(SESSION)?.map((offered) => offered.id),
            offering.map((offered) => offered.id),
          );
          assert.deepEqual(client.configOptions(SESSION), offering);
          const waited = await client.waitForConfigOption(SESSION, option, { timeoutMs: 200 });
          assert.equal(waited.id, option);
        });
      }
    }
  }
});
