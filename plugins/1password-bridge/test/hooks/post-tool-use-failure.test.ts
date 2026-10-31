import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { postToolUseFailure } from '../../src/hooks/post-tool-use-failure.ts';
import { createMaskBook } from '../../src/broker/masks.ts';
import type { AskBroker } from '../../src/hooks/broker.ts';
import { hookLogPath } from '../../src/hooks/log.ts';
import { BrokerError, type BrokerErrorCode } from '../../src/mcp/broker-client.ts';
import { maskedMarkerPath } from '../../src/paths.ts';
import type { Response } from '../../src/protocol.ts';
import { markTicket } from '../../src/session-files.ts';
import { context, sandbox, SECRET, SESSION_ID } from './helpers.ts';

const TICKET = 'tkt_aaaaaaaaaaaaaaaa';
const HELD = 'tkt_bbbbbbbbbbbbbbbb';
// One text for a check that could not run, a broker lacking a mask and a change no ticket accounts for: true in each.
const MAY_HOLD = new RegExp(
  '^' +
    'The failed output above may contain an unmasked secret value of this session, and no ticket could be named for it ' +
    '\\(failed Bash output cannot be rewritten\\)\\. Do not repeat anything that looks like a secret; tell the user\\.' +
    '$',
);
const OTHER_SECRET = 'other-fake-value-two';

function input(error: unknown, sessionId: unknown = SESSION_ID): Record<string, unknown> {
  return { hook_event_name: 'PostToolUseFailure', session_id: sessionId, tool_name: 'Bash', error };
}

/** A broker answering `mask` from a real mask book holding `values` (ticket id to value), as the broker service does. */
function maskingBroker(values: Record<string, string>): AskBroker {
  const book = createMaskBook();
  let issuedAt = 0;
  for (const [ticket, value] of Object.entries(values)) book.arm(SESSION_ID, ticket, issuedAt++, value);
  return async (req) => {
    if (req.op !== 'mask') throw new Error(`unexpected op ${req.op}`);
    const { known, changed, output } = book.apply(req.session, req.output);
    return { ok: true, op: 'mask', known, changed, output: changed ? output : null, missing: [] };
  };
}

describe('PostToolUseFailure', () => {
  test('names the ticket whose value the failed output holds', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      const ask: AskBroker = async () => ({ ok: true, op: 'mask', known: true, changed: true, output: `failed: <masked ticket=${TICKET}>`, missing: [] });
      const out = await postToolUseFailure(context(box.stateDir, input(`failed: ${SECRET}`)), ask);
      assert.match(out?.hookSpecificOutput?.additionalContext ?? '', new RegExp(`unmasked value of ticket ${TICKET}`));
    } finally {
      box.cleanup();
    }
  });

  test('a tool other than Bash is ignored: no broker request and no warning', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      let asked = 0;
      const ask: AskBroker = async () => {
        asked++;
        throw new BrokerError('unavailable', 'The 1password-bridge broker is not running.');
      };
      for (const tool of ['WebFetch', 'Monitor', 'mcp__example__lookup', undefined]) {
        const out = await postToolUseFailure(context(box.stateDir, { ...input(`failed: ${SECRET}`), tool_name: tool }), ask);
        assert.equal(out, undefined, String(tool));
      }
      assert.equal(asked, 0);
    } finally {
      box.cleanup();
    }
  });

  test('names only the tickets whose labels the masking added, not a label the error already quoted', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      markTicket(box.stateDir, SESSION_ID, HELD);
      const ask: AskBroker = async () => ({
        ok: true,
        op: 'mask',
        known: true,
        changed: true,
        output: `failed: <masked ticket=${HELD}> <masked ticket=${TICKET}>`,
        missing: [],
      });
      const out = await postToolUseFailure(context(box.stateDir, input(`failed: <masked ticket=${HELD}> ${SECRET}`)), ask);
      const text = out?.hookSpecificOutput?.additionalContext ?? '';
      assert.match(text, new RegExp(`unmasked value of ticket ${TICKET} \\(`));
      assert.ok(!text.includes(HELD), text);
    } finally {
      box.cleanup();
    }
  });

  test('names a ticket whose label the error already quoted when the masking found its value again', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, HELD);
      const ask = maskingBroker({ [HELD]: SECRET });
      const out = await postToolUseFailure(context(box.stateDir, input(`failed: <masked ticket=${HELD}> ${SECRET}`)), ask);
      assert.match(out?.hookSpecificOutput?.additionalContext ?? '', new RegExp(`unmasked value of ticket ${HELD} \\(`));
    } finally {
      box.cleanup();
    }
  });

  test('names every ticket whose value the masking found, one whose label the error already quoted included', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, HELD);
      markTicket(box.stateDir, SESSION_ID, TICKET);
      const ask = maskingBroker({ [HELD]: SECRET, [TICKET]: OTHER_SECRET });
      const error = `failed: <masked ticket=${HELD}> ${SECRET} ${OTHER_SECRET}`;
      const out = await postToolUseFailure(context(box.stateDir, input(error)), ask);
      assert.match(out?.hookSpecificOutput?.additionalContext ?? '', new RegExp(`unmasked value of ticket ${HELD}, ${TICKET} \\(`));
    } finally {
      box.cleanup();
    }
  });

  test('a broker error or a failure answer logs its code at step scan, never its message', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      const asks: AskBroker[] = [
        async () => {
          throw new BrokerError('timeout', `broker timeout near ${SECRET}`);
        },
        async () => ({ ok: false, code: 'displaced', message: `another broker took the socket near ${SECRET}` }),
        async () => ({ ok: false, code: 'internal', message: 'The broker could not apply the masks' }),
      ];
      for (const ask of asks) {
        const out = await postToolUseFailure(context(box.stateDir, input(`failed: ${SECRET}`)), ask);
        assert.match(out?.hookSpecificOutput?.additionalContext ?? '', MAY_HOLD);
      }
      const log = readFileSync(hookLogPath(box.stateDir), 'utf8');
      assert.ok(!log.includes(SECRET));
      const lines = log
        .trim()
        .split('\n')
        .map((line) => {
          const { event, step, code } = JSON.parse(line) as Record<string, unknown>;
          return { event, step, code };
        });
      assert.deepEqual(
        lines,
        ['TIMEOUT', 'DISPLACED', 'INTERNAL'].map((code) => ({ event: 'PostToolUseFailure', step: 'scan', code })),
      );
    } finally {
      box.cleanup();
    }
  });

  test('nothing when the output holds no value or there is no marker', async () => {
    const box = sandbox();
    try {
      const clean: AskBroker = async () => ({ ok: true, op: 'mask', known: true, changed: false, output: null, missing: [] });
      assert.equal(await postToolUseFailure(context(box.stateDir, input('failed')), clean), undefined);
      markTicket(box.stateDir, SESSION_ID, TICKET);
      assert.equal(await postToolUseFailure(context(box.stateDir, input('failed')), clean), undefined);
    } finally {
      box.cleanup();
    }
  });

  test('a warning that it may hold one when the broker cannot check', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      const down: AskBroker = async () => {
        throw new Error('down');
      };
      const out = await postToolUseFailure(context(box.stateDir, input('failed')), down);
      assert.match(out?.hookSpecificOutput?.additionalContext ?? '', MAY_HOLD);
    } finally {
      box.cleanup();
    }
  });

  test('the same warning for every broker error, a displaced answer, a broker lacking a mask, and a change without a label', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      const codes: readonly BrokerErrorCode[] = ['unavailable', 'untrusted', 'closed', 'timeout', 'protocol'];
      const asks: [string, AskBroker][] = codes.map((code) => [
        code,
        async () => {
          throw new BrokerError(code, code);
        },
      ]);
      const answers: [string, Response][] = [
        ['displaced', { ok: false, code: 'displaced', message: 'another broker took the socket' }],
        ['unknown', { ok: true, op: 'mask', known: false, changed: false, output: null, missing: [TICKET] }],
        ['no label', { ok: true, op: 'mask', known: true, changed: true, output: 'failed: <masked>', missing: [] }],
      ];
      for (const [name, answer] of answers) asks.push([name, async () => answer]);
      for (const [name, ask] of asks) {
        const out = await postToolUseFailure(context(box.stateDir, input(`failed: ${SECRET}`)), ask);
        assert.match(out?.hookSpecificOutput?.additionalContext ?? '', MAY_HOLD, name);
      }
    } finally {
      box.cleanup();
    }
  });

  test('the same warning, without asking the broker, when the marker cannot be read', async () => {
    const box = sandbox();
    try {
      mkdirSync(maskedMarkerPath(box.stateDir, SESSION_ID), { recursive: true });
      let asked = 0;
      const ask: AskBroker = async () => {
        asked++;
        return { ok: true, op: 'mask', known: true, changed: false, output: null, missing: [] };
      };
      const out = await postToolUseFailure(context(box.stateDir, input(`failed: ${SECRET}`)), ask);
      assert.match(out?.hookSpecificOutput?.additionalContext ?? '', MAY_HOLD);
      assert.equal(asked, 0);
    } finally {
      box.cleanup();
    }
  });

  test('nothing for a missing or non-string error, or an invalid session id', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      let asked = 0;
      const ask: AskBroker = async () => {
        asked++;
        throw new Error('down');
      };
      for (const error of [undefined, '', 42, { message: SECRET }]) {
        assert.equal(await postToolUseFailure(context(box.stateDir, input(error)), ask), undefined, JSON.stringify(error));
      }
      assert.equal(await postToolUseFailure(context(box.stateDir, input(`failed: ${SECRET}`, '../..')), ask), undefined);
      assert.equal(asked, 0);
    } finally {
      box.cleanup();
    }
  });
});
