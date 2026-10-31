import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AskBroker } from '../../src/hooks/broker.ts';
import { hookLogPath } from '../../src/hooks/log.ts';
import { postToolUse, withheldNote } from '../../src/hooks/post-tool-use.ts';
import { BrokerError, type BrokerErrorCode } from '../../src/mcp/broker-client.ts';
import { maskedMarkerPath } from '../../src/paths.ts';
import { encodeAck, parseResponse, type Request, type Response } from '../../src/protocol.ts';
import { markTicket } from '../../src/session-files.ts';
import { PROTOCOL_VERSION } from '../../src/version.ts';
import { ITEM_ID, TOKEN_ID, VAULT } from '../broker/fixtures.ts';
import { call, harness, issue, redeemOpen, running, scriptedDialog, waitFor, type Harness } from '../broker/harness.ts';
import { context, sandbox, SECRET, SESSION_ID } from './helpers.ts';

const TICKET = 'tkt_aaaaaaaaaaaaaaaa';
const HELD = 'tkt_bbbbbbbbbbbbbbbb';
const RESPONSE = { stdout: `token ${SECRET}`, stderr: '', interrupted: false };

function input(tool = 'Bash'): Record<string, unknown> {
  return { hook_event_name: 'PostToolUse', session_id: SESSION_ID, tool_name: tool, tool_use_id: 'toolu_1', tool_response: RESPONSE };
}

function broker(answer: (req: Request) => Response | Promise<Response>): { ask: AskBroker; requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    ask: async (req) => {
      requests.push(req);
      return answer(req);
    },
  };
}

/** The PostToolUse output that withholds RESPONSE behind `note`. */
function withholding(note: string) {
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { stdout: note, stderr: note, interrupted: false } } };
}

const BROKER_ERRORS: readonly BrokerErrorCode[] = ['unavailable', 'untrusted', 'closed', 'timeout', 'protocol'];

/** The note for a marker that cannot be read. */
const UNREADABLE_NOTE =
  '[1password-bridge: output withheld, the masking marker of this session cannot be read; the Bash output stays withheld until the session ends, or, when the marker is only empty, until the next redeem delivers a masked value]';

describe('PostToolUse masking', () => {
  test('without a marker the broker is not asked and the output stays', async () => {
    const box = sandbox();
    try {
      const b = broker(() => ({ ok: true, op: 'mask', known: true, changed: false, output: null, missing: [] }));
      assert.equal(await postToolUse(context(box.stateDir, input()), b.ask), undefined);
      assert.equal(b.requests.length, 0);
    } finally {
      box.cleanup();
    }
  });

  test('with a marker the broker\'s masked output replaces the output', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      const masked = { ...RESPONSE, stdout: `token <masked ticket=${TICKET}>` };
      const b = broker(() => ({ ok: true, op: 'mask', known: true, changed: true, output: masked, missing: [] }));
      const out = await postToolUse(context(box.stateDir, input()), b.ask);
      assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: masked } });
      assert.deepEqual(b.requests, [{ v: PROTOCOL_VERSION, op: 'mask', session: SESSION_ID, tickets: [TICKET], output: RESPONSE }]);
    } finally {
      box.cleanup();
    }
  });

  test('an unchanged output is left alone', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      const b = broker(() => ({ ok: true, op: 'mask', known: true, changed: false, output: null, missing: [] }));
      assert.equal(await postToolUse(context(box.stateDir, input()), b.ask), undefined);
    } finally {
      box.cleanup();
    }
  });

  test('withheld when the broker lacks a mask: the note names only the tickets it lacks', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      markTicket(box.stateDir, SESSION_ID, HELD);
      const note = withheldNote([TICKET]);
      assert.equal(note, `[1password-bridge: output withheld, masking failed; call release with ${TICKET} to stop masking]`);
      const unknown = broker(() => ({ ok: true, op: 'mask', known: false, changed: false, output: null, missing: [TICKET] }));
      assert.deepEqual(await postToolUse(context(box.stateDir, input()), unknown.ask), withholding(note), 'releasing HELD would lift a live mask');
      assert.deepEqual(unknown.requests, [{ v: PROTOCOL_VERSION, op: 'mask', session: SESSION_ID, tickets: [TICKET, HELD], output: RESPONSE }]);
    } finally {
      box.cleanup();
    }
  });

  test('withheld when the broker cannot be reached: the note names every ticket of the marker', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      markTicket(box.stateDir, SESSION_ID, HELD);
      const down = broker(() => {
        throw new BrokerError('unavailable', 'The 1password-bridge broker is not running.');
      });
      assert.deepEqual(await postToolUse(context(box.stateDir, input()), down.ask), withholding(withheldNote([TICKET, HELD])));
    } finally {
      box.cleanup();
    }
  });

  test('a response nested too deep to walk is withheld in the fixed Bash output shape, not as a bare note', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      let deep: unknown = `token ${SECRET}`;
      for (let i = 0; i < 200_000; i++) deep = { inner: deep };
      const down = broker(() => {
        throw new BrokerError('unavailable', 'The 1password-bridge broker is not running.');
      });
      const note = withheldNote([TICKET]);
      const out = await postToolUse(context(box.stateDir, { ...input(), tool_response: { stdout: deep, stderr: '', interrupted: false } }), down.ask);
      assert.deepEqual(out, {
        hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { stdout: note, stderr: note, interrupted: false, isImage: false } },
      });
      const steps = readFileSync(hookLogPath(box.stateDir), 'utf8')
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as Record<string, unknown>)['step']);
      assert.deepEqual(steps, ['mask', 'withhold']);
    } finally {
      box.cleanup();
    }
  });

  test('every broker error and a displaced answer withhold, naming every ticket of the marker, and log the broker code only', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      markTicket(box.stateDir, SESSION_ID, HELD);
      const expected = withholding(withheldNote([TICKET, HELD]));
      for (const code of BROKER_ERRORS) {
        const failing = broker(() => {
          throw new BrokerError(code, `broker ${code} near ${SECRET}`);
        });
        assert.deepEqual(await postToolUse(context(box.stateDir, input()), failing.ask), expected, code);
      }
      const displaced = broker(() => ({ ok: false, code: 'displaced', message: 'another broker took the socket' }));
      assert.deepEqual(await postToolUse(context(box.stateDir, input()), displaced.ask), expected, 'displaced');
      const log = readFileSync(hookLogPath(box.stateDir), 'utf8');
      assert.ok(!log.includes(SECRET));
      const lines = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(lines.length, BROKER_ERRORS.length + 1);
      for (const line of lines) {
        assert.deepEqual(Object.keys(line).sort(), ['at', 'code', 'event', 'step']);
        assert.deepEqual([line['event'], line['step']], ['PostToolUse', 'mask']);
      }
      assert.deepEqual(
        lines.map((line) => line['code']),
        [...BROKER_ERRORS.map((code) => code.toUpperCase()), 'DISPLACED'],
      );
    } finally {
      box.cleanup();
    }
  });

  test('an empty marker withholds until the next masked value is marked; one holding a line that is no ticket id stays withheld', async () => {
    const box = sandbox();
    try {
      const marker = maskedMarkerPath(box.stateDir, SESSION_ID);
      const masked = { ...RESPONSE, stdout: `token <masked ticket=${TICKET}>` };
      const b = broker(() => ({ ok: true, op: 'mask', known: true, changed: true, output: masked, missing: [] }));
      markTicket(box.stateDir, SESSION_ID, HELD);
      writeFileSync(marker, '');
      assert.deepEqual(await postToolUse(context(box.stateDir, input()), b.ask), withholding(UNREADABLE_NOTE), 'empty');
      // What the broker does when a redeem delivers a masked value (§9).
      markTicket(box.stateDir, SESSION_ID, TICKET);
      const out = await postToolUse(context(box.stateDir, input()), b.ask);
      assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: masked } }, 'rewritten');
      assert.deepEqual(b.requests, [{ v: PROTOCOL_VERSION, op: 'mask', session: SESSION_ID, tickets: [TICKET], output: RESPONSE }]);
      writeFileSync(marker, 'garbage\n');
      markTicket(box.stateDir, SESSION_ID, HELD);
      assert.deepEqual(await postToolUse(context(box.stateDir, input()), b.ask), withholding(UNREADABLE_NOTE), 'garbage');
      assert.equal(b.requests.length, 1);
    } finally {
      box.cleanup();
    }
  });

  test('a marker that exists but cannot be read or holds no ticket id withholds, without asking the broker', async () => {
    const box = sandbox();
    try {
      const marker = maskedMarkerPath(box.stateDir, SESSION_ID);
      const b = broker(() => ({ ok: true, op: 'mask', known: true, changed: false, output: null, missing: [] }));
      // release cannot clear such a marker, so the note does not advise it.
      const expected = withholding(UNREADABLE_NOTE);
      // A directory where the marker file should be: reading it fails (EISDIR), whoever runs the test.
      mkdirSync(marker, { recursive: true });
      assert.deepEqual(await postToolUse(context(box.stateDir, input()), b.ask), expected, 'unreadable');
      rmSync(marker, { recursive: true });
      for (const text of ['\n', 'not a ticket\n', `${TICKET}\ngarbage\n`]) {
        writeFileSync(marker, text);
        assert.deepEqual(await postToolUse(context(box.stateDir, input()), b.ask), expected, JSON.stringify(text));
      }
      assert.equal(b.requests.length, 0);
    } finally {
      box.cleanup();
    }
  });

  test('a tool other than Bash is ignored: no broker request and no output, even when Bash output would be withheld', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      const b = broker(() => ({ ok: true, op: 'mask', known: false, changed: false, output: null, missing: [TICKET] }));
      const tools: unknown[] = ['Read', 'Grep', 'Monitor', 'ToolSearch', 'mcp__example__lookup', 'bash', undefined];
      for (const tool of tools) {
        assert.equal(await postToolUse(context(box.stateDir, { ...input(), tool_name: tool }), b.ask), undefined, String(tool));
      }
      writeFileSync(maskedMarkerPath(box.stateDir, SESSION_ID), 'garbage\n');
      for (const tool of tools) {
        assert.equal(await postToolUse(context(box.stateDir, { ...input(), tool_name: tool }), b.ask), undefined, `${String(tool)}, unreadable marker`);
      }
      assert.equal(b.requests.length, 0);
    } finally {
      box.cleanup();
    }
  });
});

describe('PostToolUse masking with the broker', () => {
  // A delivered value made of digits, masked by a real broker through its socket.
  const DIGITS = '31415926535';
  let h: Harness | undefined;

  afterEach(() => h?.cleanup());

  /** A real broker holding one ticket's mask on DIGITS; the hook asks it through the socket. */
  async function brokerMasking(): Promise<{ stateDir: string; ticket: string; ask: AskBroker }> {
    const w = scriptedDialog();
    h = harness({ dialog: w.dialog, attributionWaitMs: 200, recheckMs: 20 });
    await h.start();
    const path = h.options.socketPath;
    h.account.items.set(
      VAULT.id,
      (h.account.items.get(VAULT.id) ?? []).map((item) =>
        item.id === ITEM_ID ? { ...item, fields: item.fields.map((f) => (f.id === TOKEN_ID ? { ...f, value: DIGITS } : f)) } : item,
      ),
    );
    const [ticket = ''] = await issue(path);
    running(h.stateDir, 'make deploy');
    const { socket, lines } = await redeemOpen(path, ticket);
    await waitFor('the window', () => w.shown.length === 1);
    w.shown[0]?.answer('approve');
    assert.deepEqual(parseResponse((await lines.next()) ?? '', 'redeem'), { ok: true, op: 'redeem', value: DIGITS });
    socket.write(encodeAck('received'));
    socket.end(encodeAck('delivered'));
    await once(socket, 'close');
    const ask: AskBroker = async (req) => {
      const res = await call(path, req);
      assert.ok(res !== null, 'the broker answers');
      return res;
    };
    return { stateDir: h.stateDir, ticket, ask };
  }

  function postInput(tool: string, response: unknown): Record<string, unknown> {
    return { hook_event_name: 'PostToolUse', session_id: SESSION_ID, tool_name: tool, tool_use_id: 'toolu_1', tool_response: response };
  }

  test('a Bash response gets the value masked in its strings; its booleans stay', async () => {
    const { stateDir, ticket, ask } = await brokerMasking();
    const response = { stdout: `id ${DIGITS}\n`, stderr: `warn ${DIGITS}`, interrupted: false, isImage: false };
    const out = await postToolUse(context(stateDir, postInput('Bash', response)), ask);
    const label = `<masked ticket=${ticket}>`;
    assert.deepEqual(out, {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: { stdout: `id ${label}\n`, stderr: `warn ${label}`, interrupted: false, isImage: false },
      },
    });
  });

  test('Read and MCP outputs holding the value are left alone', async () => {
    const { stateDir, ask } = await brokerMasking();
    const read = { type: 'text', file: { filePath: '/work/site/notes.txt', content: `id ${DIGITS}`, numLines: 1, startLine: 1, totalLines: 1 } };
    assert.equal(await postToolUse(context(stateDir, postInput('Read', read)), ask), undefined);
    const mcp = { content: [{ type: 'text', text: `id ${DIGITS}` }], isError: false };
    assert.equal(await postToolUse(context(stateDir, postInput('mcp__example__lookup', mcp)), ask), undefined);
  });
});
