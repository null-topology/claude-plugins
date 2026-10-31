import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { OpListing } from '../../src/mcp/accounts.ts';
import { brokerSocketPath } from '../../src/mcp/broker-client.ts';
import { createMcpServer, createTools, INSTRUCTIONS, TOOL_NAMES, type ToolDeps, type Tools } from '../../src/mcp/tools.ts';
import type { FieldMeta, Response } from '../../src/protocol.ts';
import { PROTOCOL_VERSION } from '../../src/version.ts';
import { SESSION_ID } from '../hooks/helpers.ts';

/** Synthetic accounts; none of them exists. */
const UUID = 'AAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_UUID = 'BBBBBBBBBBBBBBBBBBBBBBBBBB';
const LABEL = 'my.1password.test · someone@example.test';
const ONE_ACCOUNT: OpListing = { ok: true, accounts: [{ uuid: UUID, url: 'my.1password.test', email: 'someone@example.test' }] };
const TWO_ACCOUNTS: OpListing = {
  ok: true,
  accounts: [...(ONE_ACCOUNT.ok ? ONE_ACCOUNT.accounts : []), { uuid: OTHER_UUID, url: 'work.1password.test', email: 'someone@work.example.test' }],
};

function failure(code: Extract<Response, { ok: false }>['code'], message: string): Response {
  return { ok: false, code, message };
}

type Answer = Response | 'close';
type Handler = (req: Record<string, unknown>, connection: number) => Answer | Promise<Answer>;

let root: string;
let stateDir: string;
let servers: Server[];
let sockets: Socket[];
let spawns: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'op-tools-'));
  stateDir = join(root, 'state');
  assert.ok(brokerSocketPath(stateDir).startsWith(stateDir), 'the test socket must live in the test state directory');
  servers = [];
  sockets = [];
  spawns = 0;
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  rmSync(root, { recursive: true, force: true });
});

/** A fake broker on the test socket; records each request it reads. */
async function broker(handler: Handler): Promise<Record<string, unknown>[]> {
  const path = brokerSocketPath(stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const requests: Record<string, unknown>[] = [];
  let connections = 0;
  const server = createServer((socket) => {
    sockets.push(socket);
    const connection = ++connections;
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const req = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
      requests.push(req);
      void Promise.resolve(handler(req, connection)).then((answer) => {
        if (answer === 'close') socket.destroy();
        else socket.end(`${JSON.stringify(answer)}\n`);
      });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return requests;
}

function tools(overrides: Partial<ToolDeps> = {}): Tools {
  return createTools({
    stateDir,
    accountsSetting: undefined,
    listOpAccounts: async () => ONE_ACCOUNT,
    broker: {
      stateDir,
      spawnBroker: () => {
        spawns++;
      },
      startTimeoutMs: 300,
      retryIntervalMs: 20,
    },
    ...overrides,
  });
}

// Typed as the Response member, not `as const`: a readonly tuple does not fit its `tickets: string[]`.
const ISSUED: Extract<Response, { ok: true; op: 'issue_tickets' }> = {
  ok: true,
  op: 'issue_tickets',
  tickets: ['tkt_aaaaaaaaaaaaaaaa', 'tkt_bbbbbbbbbbbbbbbb'],
  expiresAt: '2026-10-29T12:10:00.000Z',
  field: { vault: 'Deploy', item: 'Deploy server', field: 'api token', type: 'Concealed', masked: true, short: false },
};

const issueArgs = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ref: 'op://Deploy/Deploy server/api token',
  reason: ' deploy the staging site ',
  session_id: SESSION_ID,
  agent_id: 'agent-1',
  agent_type: 'general-purpose',
  ...extra,
});

describe('issue_tickets', () => {
  test('sends the field, the trimmed reason, the session and the agent; answers ids, never a value', async () => {
    const requests = await broker(() => ISSUED);
    const result = await tools().call('issue_tickets', issueArgs({ count: 2 }));
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /^Issued 2 tickets for "api token" \(Concealed, masked in Bash output as <masked ticket=…>\) of item "Deploy server" in vault "Deploy", valid until 2026-10-29T12:10:00.000Z, one use each:/);
    assert.match(result.text, /\n- tkt_aaaaaaaaaaaaaaaa\n- tkt_bbbbbbbbbbbbbbbb\n/);
    assert.match(result.text, /TOKEN="\$\(op-bridge redeem tkt_aaaaaaaaaaaaaaaa\)"/);
    const req = requests[0] ?? {};
    assert.equal(req['op'], 'issue_tickets');
    assert.equal(req['count'], 2);
    assert.equal(req['reason'], 'deploy the staging site');
    assert.deepEqual(req['session'], { id: SESSION_ID });
    assert.deepEqual(req['agent'], { id: 'agent-1', type: 'general-purpose' });
  });

  test('count defaults to 1 and stops at 5', async () => {
    const requests = await broker(() => ({ ...ISSUED, tickets: ['tkt_aaaaaaaaaaaaaaaa'] }));
    assert.equal((await tools().call('issue_tickets', issueArgs())).isError, false);
    assert.equal(requests[0]?.['count'], 1);
    const tooMany = await tools().call('issue_tickets', issueArgs({ count: 6 }));
    assert.equal(tooMany.isError, true);
    assert.match(tooMany.text, /^invalid_arguments: count/);
  });

  test('says when a value will not be masked', async () => {
    await broker(() => ({ ...ISSUED, tickets: ['tkt_aaaaaaaaaaaaaaaa'], field: { ...ISSUED.field, masked: false, short: true } }));
    assert.match((await tools().call('issue_tickets', issueArgs())).text, /a secret shorter than 8 characters: NOT masked/);
  });

  test('needs the session and the agent the hook injects; without them it asks the broker nothing', async () => {
    const requests = await broker(() => ISSUED);
    for (const sessionId of [undefined, '', '../escape', 'session-1111-test/..']) {
      const result = await tools().call('issue_tickets', issueArgs({ session_id: sessionId }));
      assert.equal(result.isError, true, String(sessionId));
      assert.match(result.text, /^no_session: No session id reached the server\. /, String(sessionId));
    }
    for (const agentId of [undefined, '']) {
      const result = await tools().call('issue_tickets', issueArgs({ agent_id: agentId }));
      assert.equal(result.isError, true, String(agentId));
      assert.match(result.text, /^no_session: No agent id reached the server\. /, String(agentId));
    }
    assert.equal(requests.length, 0);
  });

  test('takes a reason of 500 characters and refuses 501 without asking the broker', async () => {
    const requests = await broker(() => ({ ...ISSUED, tickets: ['tkt_aaaaaaaaaaaaaaaa'] }));
    const atLimit = await tools().call('issue_tickets', issueArgs({ reason: 'r'.repeat(500) }));
    assert.equal(atLimit.isError, false, atLimit.text);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.['reason'], 'r'.repeat(500));
    const tooLong = await tools().call('issue_tickets', issueArgs({ reason: 'r'.repeat(501) }));
    assert.equal(tooLong.isError, true);
    assert.equal(tooLong.text, 'invalid_arguments: reason: must be at most 500 characters');
    assert.equal(requests.length, 1, 'a refused reason sends no broker request');
  });

  test('counts the reason limit in code points: 500 non-BMP characters pass, 501 are refused without asking the broker', async () => {
    const requests = await broker(() => ({ ...ISSUED, tickets: ['tkt_aaaaaaaaaaaaaaaa'] }));
    const grin = '\u{1F600}';
    const atLimit = await tools().call('issue_tickets', issueArgs({ reason: grin.repeat(500) }));
    assert.equal(atLimit.isError, false, atLimit.text);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.['reason'], grin.repeat(500));
    const tooLong = await tools().call('issue_tickets', issueArgs({ reason: grin.repeat(501) }));
    assert.equal(tooLong.isError, true);
    assert.equal(tooLong.text, 'invalid_arguments: reason: must be at most 500 characters');
    assert.equal(requests.length, 1, 'a refused reason sends no broker request');
  });

  test('a blank reason or a missing ref is rejected before asking the broker', async () => {
    const requests = await broker(() => ISSUED);
    for (const args of [issueArgs({ reason: '   ' }), issueArgs({ reason: undefined }), issueArgs({ ref: undefined })]) {
      const result = await tools().call('issue_tickets', args);
      assert.equal(result.isError, true);
      assert.ok(result.text.startsWith('invalid_arguments: '), result.text);
    }
    assert.equal(requests.length, 0);
  });

  test('`account` picks one of several accounts; without it several accounts are an error', async () => {
    const requests = await broker(() => ISSUED);
    const t = tools({ listOpAccounts: async () => TWO_ACCOUNTS });
    const missing = await t.call('issue_tickets', issueArgs());
    assert.equal(missing.isError, true);
    assert.ok(missing.text.startsWith('account: ') && missing.text.includes(UUID) && missing.text.includes(OTHER_UUID), missing.text);
    assert.equal(requests.length, 0);
    const chosen = await t.call('issue_tickets', issueArgs({ account: 'someone@work.example.test' }));
    assert.equal(chosen.isError, false, chosen.text);
    assert.equal(requests[0]?.['account'], OTHER_UUID);
    assert.equal(requests[0]?.['accountLabel'], 'work.1password.test · someone@work.example.test');
  });

  test('a broker failure is an error; one that cannot be started is too', async () => {
    const result = await tools().call('issue_tickets', issueArgs());
    assert.equal(result.isError, true);
    assert.ok(result.text.startsWith('broker_unavailable: '), result.text);
    assert.ok(spawns >= 1, 'the server tried to start the broker');
    await broker(() => failure('not_found', 'No field "api token" in item "Deploy server"'));
    assert.deepEqual(await tools().call('issue_tickets', issueArgs()), { isError: true, text: 'not_found: No field "api token" in item "Deploy server"' });
  });
});

describe('release', () => {
  test('sends the ticket ids and reports each result', async () => {
    const requests = await broker(() => ({
      ok: true,
      op: 'release',
      results: [
        { ticket: 'tkt_aaaaaaaaaaaaaaaa', result: 'voided' },
        { ticket: 'tkt_bbbbbbbbbbbbbbbb', result: 'unmasked' },
        { ticket: 'tkt_cccccccccccccccc', result: 'not_owner' },
        { ticket: 'tkt_dddddddddddddddd', result: 'in_flight' },
        { ticket: 'tkt_eeeeeeeeeeeeeeee', result: 'mask_kept' },
      ],
    }));
    const result = await tools().call('release', {
      tickets: ['tkt_aaaaaaaaaaaaaaaa', ' tkt_bbbbbbbbbbbbbbbb', 'tkt_cccccccccccccccc', 'tkt_aaaaaaaaaaaaaaaa', 'tkt_dddddddddddddddd', 'tkt_eeeeeeeeeeeeeeee'],
      session_id: SESSION_ID,
      agent_id: 'main',
    });
    assert.equal(result.isError, false);
    assert.deepEqual(requests[0]?.['tickets'], ['tkt_aaaaaaaaaaaaaaaa', 'tkt_bbbbbbbbbbbbbbbb', 'tkt_cccccccccccccccc', 'tkt_dddddddddddddddd', 'tkt_eeeeeeeeeeeeeeee']);
    assert.equal(
      result.text,
      [
        '- tkt_aaaaaaaaaaaaaaaa: voided; it can no longer be redeemed.',
        '- tkt_bbbbbbbbbbbbbbbb: mask dropped; at least one value this ticket held is no longer masked by any ticket, and copies of it written earlier to files or logs now show it in plain text.',
        '- tkt_cccccccccccccccc: belongs to another session; not released.',
        "- tkt_dddddddddddddddd: in flight; the value is on its way to the running command, the ticket will end used or voided, and it no longer masks that command's output; another ticket of this session may still mask the same value.",
        "- tkt_eeeeeeeeeeeeeeee: this ticket's mask dropped; every value it held stays masked under another ticket of this session.",
      ].join('\n'),
    );
  });

  test('without a session id it fails; an empty list is rejected; neither asks the broker', async () => {
    const requests = await broker(() => ({ ok: true, op: 'release', results: [] }));
    assert.match((await tools().call('release', { tickets: ['tkt_aaaaaaaaaaaaaaaa'] })).text, /^no_session: /);
    for (const sessionId of ['', '../escape', 'session-1111-test/..']) {
      const result = await tools().call('release', { tickets: ['tkt_aaaaaaaaaaaaaaaa'], session_id: sessionId });
      assert.equal(result.isError, true, sessionId);
      assert.match(result.text, /^no_session: No session id reached the server\. /, sessionId);
    }
    assert.match((await tools().call('release', { tickets: [], session_id: SESSION_ID })).text, /^invalid_arguments: /);
    assert.match((await tools().call('release', { tickets: ['  '], session_id: SESSION_ID })).text, /^invalid_arguments: tickets: /);
    assert.equal(requests.length, 0);
  });
});

describe('fields', () => {
  const FIELDS: FieldMeta[] = [
    { id: 'username', title: 'username', type: 'Text', masked: false },
    { id: 'f1', title: 'token', sectionId: 's1', section: 'API', type: 'Concealed', masked: true },
    { id: 'notes', title: 'notes', type: 'Notes', masked: true },
  ];

  test('lists titles, sections, types, masking and references, without a session', async () => {
    const requests = await broker(() => ({ ok: true, op: 'fields', vault: 'Vault', item: { title: 'Item', category: 'Login' }, fields: FIELDS }));
    const result = await tools().call('fields', { ref: 'op://Vault/Item' });
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(requests, [{ v: PROTOCOL_VERSION, op: 'fields', account: UUID, ref: 'op://Vault/Item' }]);
    const lines = result.text.split('\n');
    assert.ok(lines[0]?.includes('"Item" (Login) in vault "Vault"'), lines[0]);
    assert.ok(lines[0]?.endsWith('pass a ref below to issue_tickets.'), lines[0]);
    assert.ok(lines.includes('- username: Text, not masked; ref op://Vault/Item/username'), result.text);
    assert.ok(lines.includes('- API / token: Concealed, masked; ref op://Vault/Item/s1/f1'), result.text);
    assert.ok(lines.includes('- notes: Notes, masked; ref op://Vault/Item/notes'), result.text);
    assert.ok(!result.text.includes('$'), result.text);
  });

  test('a broker failure is an error', async () => {
    await broker(() => failure('not_found', 'No item "Item" in vault "Vault"'));
    assert.deepEqual(await tools().call('fields', { ref: 'op://Vault/Item' }), { isError: true, text: 'not_found: No item "Item" in vault "Vault"' });
  });
});

describe('accounts', () => {
  test('lists op and configured accounts and marks the warm ones from the broker status', async () => {
    const requests = await broker(() => ({
      ok: true,
      op: 'status',
      accounts: [{ account: UUID, warm: true }],
      exitsAt: '2026-10-28T13:30:00.000Z',
    }));
    const result = await tools({ accountsSetting: 'My Team, my.1password.test' }).call('accounts', {});
    assert.equal(result.isError, false, result.text);
    assert.deepEqual(requests, [{ v: PROTOCOL_VERSION, op: 'status' }]);
    const lines = result.text.split('\n');
    assert.ok(lines.includes(`- ${LABEL}: account ${UUID}, from op, also configured as my.1password.test; warm`), result.text);
    assert.ok(lines.includes('- My Team: account My Team, configured'), result.text);
    assert.ok(result.text.includes('Broker: running; 1Password access idles out around 2026-10-28T13:30:00.000Z.'), result.text);
  });

  test('falls back to the configured list when op is missing, and does not start the broker', async () => {
    const result = await tools({ listOpAccounts: async () => ({ ok: false, reason: 'missing' }), accountsSetting: 'My Team' }).call('accounts', {});
    assert.equal(result.isError, false, result.text);
    assert.ok(result.text.includes('- My Team: account My Team, configured'), result.text);
    assert.ok(result.text.includes('The op CLI is not installed'), result.text);
    assert.ok(result.text.includes('Broker: not running'), result.text);
    assert.equal(spawns, 0);
  });

  test('with no account known it says how to add one', async () => {
    const result = await tools({ listOpAccounts: async () => ({ ok: false, reason: 'failed' }) }).call('accounts', {});
    assert.equal(result.isError, false);
    assert.ok(result.text.includes('No 1Password account is known.'), result.text);
    assert.ok(result.text.includes('op account list failed'), result.text);
  });
});

describe('MCP server', () => {
  async function connected(): Promise<Client> {
    const server = createMcpServer({
      stateDir,
      accountsSetting: undefined,
      listOpAccounts: async () => ONE_ACCOUNT,
      broker: { stateDir, spawnBroker: () => {}, startTimeoutMs: 100 },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientSide);
    return client;
  }

  test('lists accounts, fields, issue_tickets and release; the hook-set fields are described as such', async () => {
    const client = await connected();
    const { tools: listed } = await client.listTools();
    assert.deepEqual(listed.map((t) => t.name), [...TOOL_NAMES]);
    assert.deepEqual(TOOL_NAMES, ['accounts', 'fields', 'issue_tickets', 'release']);
    for (const tool of listed.filter((t) => t.name !== 'accounts')) {
      const props = tool.inputSchema.properties as Record<string, { description?: string }>;
      for (const key of ['session_id', 'transcript_path', 'agent_id', 'agent_type', 'cwd']) {
        assert.equal(props[key]?.description, "Set by the plugin's hook; leave unset", `${tool.name} ${key}`);
      }
    }
    const issue = listed.find((t) => t.name === 'issue_tickets');
    assert.deepEqual([...(issue?.inputSchema.required ?? [])].sort(), ['reason', 'ref']);
    assert.equal((issue?.inputSchema.properties?.['reason'] as { maxLength?: number } | undefined)?.maxLength, 500);
    assert.ok(issue?.description?.includes('at most 500 characters'), issue?.description);
    assert.equal(
      listed.find((t) => t.name === 'release')?.description,
      "Release tickets: an unused ticket is voided, a used ticket's mask is dropped at once. A value delivered by several tickets stays masked until all of them are released. A ticket whose value is on its way to a running command ends used or voided and no longer masks that command's output, though another ticket of this session may still mask the same value. unmasked: at least one value the ticket held is no longer masked by any ticket, and copies of it written earlier to files or logs show it in plain text. mask_kept: every value the ticket held stays masked under another ticket of this session.",
    );
    await client.close();
  });

  test('sends the usage contract as server instructions', async () => {
    const client = await connected();
    assert.equal(client.getInstructions(), INSTRUCTIONS);
    for (const phrase of [
      'fields',
      'issue_tickets',
      'reason',
      'at most 500 characters',
      '"$(op-bridge redeem <ticket>)"',
      'approves that use in a window that shows the command',
      'cannot be matched by prefix allow rules',
      'one use',
      'other agents',
      'other_agent',
      'release',
      '[exit N]',
      '<masked ticket=tkt_…>',
      'Monitor',
      'tell the user',
      'deliberate',
    ]) {
      assert.ok(INSTRUCTIONS.includes(phrase), `the instructions mention ${phrase}`);
    }
    // The EXIT trap is set only while the session's masked marker holds a ticket (Task 15), and a command
    // can bypass it with its own EXIT trap, exec or a signal that kills its shell, so the line promises it for most commands only.
    assert.ok(INSTRUCTIONS.includes('While a masked value exists in this session, a failed shell command normally ends with a line [exit N]'));
    assert.ok(
      INSTRUCTIONS.includes(
        'A command that sets its own EXIT trap, uses exec, or whose shell is killed by a signal fails as usual, and its output is not masked.',
      ),
    );
    assert.ok(INSTRUCTIONS.includes('- Do not set an EXIT trap (trap … EXIT) and do not use exec in a command that redeems a ticket.'));
    // Only Bash output is masked: the instructions keep a value inside Bash and out of every other tool.
    assert.ok(INSTRUCTIONS.includes('- Secret values show as <masked ticket=tkt_…> in Bash output.'));
    assert.ok(
      INSTRUCTIONS.includes(
        '- Output of other tools (Read, Grep, MCP tools, Monitor and others) is not masked: use a value only inside Bash commands, do not open a file that may hold a value with another tool,',
      ),
    );
    assert.ok(
      INSTRUCTIONS.includes(
        "- When a mask gets in the way, call release with the ticket ids. A used ticket's mask is dropped at once, but a value delivered by several tickets stays masked until all of them are released. Release answers unmasked when at least one value the ticket held is no longer masked by any ticket (copies written earlier to files or logs then show it in plain text), mask_kept when every value it held stays masked under another ticket of this session.",
      ),
    );
    // A background command's output reaches Claude later through another tool, unmasked.
    assert.ok(
      INSTRUCTIONS.includes(
        '- Do not print a value in a command that runs in the background (run_in_background, or moved there by the timeout): its output is read later through another tool and is not masked.',
      ),
    );
    for (const gone of ['"$NAME"', 'call get', 'a repeat get', 'masked grant', 'unsets the variable', 'a failed shell command ends with a line [exit N]', 'tool output']) {
      assert.ok(!INSTRUCTIONS.includes(gone), `the instructions no longer mention ${gone}`);
    }
    await client.close();
  });

  test('a call answers with text and marks errors', async () => {
    const client = await connected();
    const result = await client.callTool({ name: 'release', arguments: { tickets: ['tkt_aaaaaaaaaaaaaaaa'] } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: 'text', text: (await tools().call('release', { tickets: ['tkt_aaaaaaaaaaaaaaaa'] })).text }]);
    await client.close();
  });
});
