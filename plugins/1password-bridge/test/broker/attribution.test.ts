import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { attribute, attributeWaiting, ATTRIBUTION_WAIT_MS, RECHECK_MS, type Attribution } from '../../src/broker/attribution.ts';
import { readBoard, writeEntry, type LiveEntry } from '../../src/board.ts';
import { sandbox, SESSION_ID } from '../hooks/helpers.ts';
import { FakeClock, flush } from './clock.ts';

const TICKET = 'tkt_abcdefghijklmnop';

function entry(agent: string, command: string, toolUseId = `toolu_${agent}_${command.length}`): LiveEntry {
  return { agent_id: agent, tool_use_id: toolUseId, command, cwd: `/work/${agent}`, startedAt: 0, timeoutMs: 120_000, background: false };
}

/** An entry PostToolUse moved to the background: a command that keeps running after its tool call. */
function backgroundEntry(agent: string, command: string): LiveEntry {
  return { ...entry(agent, command, `bg-${agent}-${command.length}`), background: true };
}

/** A FakeClock that also tracks the one-shot timers still pending. */
class TrackingClock extends FakeClock {
  readonly pending = new Set<unknown>();

  override setTimeout(fn: () => void, ms: number): unknown {
    const handle: unknown = super.setTimeout(() => {
      this.pending.delete(handle);
      fn();
    }, ms);
    this.pending.add(handle);
    return handle;
  }

  override clearTimeout(handle: unknown): void {
    this.pending.delete(handle);
    super.clearTimeout(handle);
  }
}

/** Runs `attributeWaiting` over a fixed board to its deadline; it must not settle a moment earlier. */
async function waitOut(board: readonly LiveEntry[], owner: string): Promise<{ result: Attribution | null; reads: number }> {
  const clock = new FakeClock();
  let reads = 0;
  let settled = false;
  const done = attributeWaiting(() => (reads++, board), owner, TICKET, clock, new AbortController().signal);
  void done.then(() => {
    settled = true;
  });
  await clock.advance(ATTRIBUTION_WAIT_MS - 1);
  assert.equal(settled, false);
  await clock.advance(1);
  return { result: await done, reads };
}

/** One read at the start and one after each re-check, up to the deadline. */
const READS_TO_DEADLINE = ATTRIBUTION_WAIT_MS / RECHECK_MS + 1;

describe('attribution rules', () => {
  const cases: [string, LiveEntry[], Attribution['kind'], string | undefined][] = [
    ['the owner alone runs one command', [entry('main', 'make deploy')], 'attributed', undefined],
    ['another agent names the ticket', [entry('main', 'x'), entry('agent-1', `echo ${TICKET}`)], 'refused', 'not_owner'],
    ['another agent names the ticket while the owner runs nothing', [entry('agent-1', `run ${TICKET}`)], 'refused', 'not_owner'],
    ['another agent runs something else', [entry('main', 'x'), entry('agent-1', 'npm test')], 'pending', 'other_agent'],
    ['only another agent runs something', [entry('agent-1', 'npm test')], 'pending', 'other_agent'],
    ['nothing runs', [], 'pending', 'no_command'],
  ];
  for (const [name, entries, kind, code] of cases) {
    test(name, () => {
      const result = attribute(entries, 'main', TICKET);
      assert.equal(result.kind, kind);
      if (result.kind !== 'attributed') assert.equal(result.code, code);
    });
  }

  test('lists every owner command, those naming the ticket first and marked', () => {
    const result = attribute([entry('main', './deploy.sh'), entry('main', `T="$(op-bridge redeem ${TICKET})" && curl`)], 'main', TICKET);
    assert.deepEqual(result, {
      kind: 'attributed',
      commands: [
        { command: `T="$(op-bridge redeem ${TICKET})" && curl`, cwd: '/work/main', literal: true },
        { command: './deploy.sh', cwd: '/work/main', literal: false },
      ],
    });
  });
});

describe('attributeWaiting', () => {
  test('re-checks every 500 ms and attributes once the other agent is done', async () => {
    const clock = new FakeClock();
    let board = [entry('main', 'x'), entry('agent-1', 'npm test')];
    let reads = 0;
    const done = attributeWaiting(() => (reads++, board), 'main', TICKET, clock, new AbortController().signal);
    await clock.advance(RECHECK_MS);
    board = [entry('main', 'x')];
    await clock.advance(RECHECK_MS);
    const result = await done;
    assert.equal(result?.kind, 'attributed');
    assert.equal(reads, 3);
  });

  test('gives up after 30 s with the last pending code', async () => {
    const clock = new FakeClock();
    const done = attributeWaiting(() => [], 'main', TICKET, clock, new AbortController().signal);
    await clock.advance(ATTRIBUTION_WAIT_MS - 1);
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    await flush();
    assert.equal(settled, false);
    await clock.advance(1);
    assert.deepEqual(await done, { kind: 'pending', code: 'no_command' });
  });

  test('a ticket named by another agent refuses at once, without waiting', async () => {
    const clock = new FakeClock();
    const result = await attributeWaiting(() => [entry('agent-1', TICKET)], 'main', TICKET, clock, new AbortController().signal);
    assert.deepEqual(result, { kind: 'refused', code: 'not_owner' });
  });

  test('an abort ends the wait with null', async () => {
    const clock = new FakeClock();
    const abort = new AbortController();
    const done = attributeWaiting(() => [], 'main', TICKET, clock, abort.signal);
    await clock.advance(RECHECK_MS);
    abort.abort();
    assert.equal(await done, null);
  });
});

describe('attribution security regressions', () => {
  const ownerRedeem = `T="$(op-bridge redeem ${TICKET})" && curl -H "Authorization: $T" https://api`;

  test('the owner naming the ticket does not outweigh another agent whose command hides it', async () => {
    const board = [entry('main', ownerRedeem), entry('agent-1', './sync.sh')];
    assert.deepEqual(attribute(board, 'main', TICKET), { kind: 'pending', code: 'other_agent' });
    const { result, reads } = await waitOut(board, 'main');
    assert.deepEqual(result, { kind: 'pending', code: 'other_agent' });
    assert.equal(reads, READS_TO_DEADLINE);
  });

  test('a subagent owner is not attributed while main runs a command', async () => {
    const board = [entry('agent-1', `op-bridge redeem ${TICKET}`), entry('main', 'npm test')];
    assert.deepEqual(attribute(board, 'agent-1', TICKET), { kind: 'pending', code: 'other_agent' });
    const { result, reads } = await waitOut(board, 'agent-1');
    assert.deepEqual(result, { kind: 'pending', code: 'other_agent' });
    assert.equal(reads, READS_TO_DEADLINE);
  });

  test('main naming a subagent owner\'s ticket refuses at once', () => {
    const board = [entry('agent-1', './deploy.sh'), entry('main', `echo ${TICKET}`)];
    assert.deepEqual(attribute(board, 'agent-1', TICKET), { kind: 'refused', code: 'not_owner' });
  });

  test('a subagent owner running the only live commands is attributed, without waiting', async () => {
    const board = [entry('agent-1', './deploy.sh'), entry('agent-1', `op-bridge redeem ${TICKET}`)];
    const expected: Attribution = {
      kind: 'attributed',
      commands: [
        { command: `op-bridge redeem ${TICKET}`, cwd: '/work/agent-1', literal: true },
        { command: './deploy.sh', cwd: '/work/agent-1', literal: false },
      ],
    };
    assert.deepEqual(attribute(board, 'agent-1', TICKET), expected);
    let reads = 0;
    const result = await attributeWaiting(() => (reads++, board), 'agent-1', TICKET, new FakeClock(), new AbortController().signal);
    assert.deepEqual(result, expected);
    assert.equal(reads, 1);
  });

  test('a background command of another agent blocks attribution until the deadline', async () => {
    const board = [entry('main', ownerRedeem), backgroundEntry('agent-1', 'npm run watch')];
    assert.deepEqual(attribute(board, 'main', TICKET), { kind: 'pending', code: 'other_agent' });
    const { result, reads } = await waitOut(board, 'main');
    assert.deepEqual(result, { kind: 'pending', code: 'other_agent' });
    assert.equal(reads, READS_TO_DEADLINE);
  });

  test('a background command of another agent naming the ticket refuses at once', () => {
    const board = [entry('main', ownerRedeem), backgroundEntry('agent-1', `./poll.sh ${TICKET}`)];
    assert.deepEqual(attribute(board, 'main', TICKET), { kind: 'refused', code: 'not_owner' });
  });

  test('an owner\'s background command alone counts as a live owner entry', () => {
    assert.deepEqual(attribute([backgroundEntry('main', 'npm run dev')], 'main', TICKET), {
      kind: 'attributed',
      commands: [{ command: 'npm run dev', cwd: '/work/main', literal: false }],
    });
  });

  test('an abort during the wait returns null and leaves no timer pending', async () => {
    const clock = new TrackingClock();
    const abort = new AbortController();
    let reads = 0;
    const done = attributeWaiting(() => (reads++, [entry('main', 'x'), entry('agent-1', 'npm test')]), 'main', TICKET, clock, abort.signal);
    await clock.advance(RECHECK_MS);
    assert.equal(clock.pending.size, 1);
    abort.abort();
    assert.equal(await done, null);
    assert.equal(clock.pending.size, 0);
    const readsAtAbort = reads;
    await clock.advance(ATTRIBUTION_WAIT_MS);
    assert.equal(reads, readsAtAbort);
  });

  test('a short-timeout command of another agent naming the ticket, still waiting 40 s on, refuses instead of attributing', () => {
    const box = sandbox();
    try {
      const now = 1_000_000;
      writeEntry(box.stateDir, SESSION_ID, { ...entry('main', './deploy.sh', 'toolu_main'), startedAt: now - 1000 });
      // PreToolUse wrote it before the permission prompt, which may still be open.
      writeEntry(box.stateDir, SESSION_ID, { ...entry('agent-1', `op-bridge redeem ${TICKET}`, 'toolu_sub'), startedAt: now - 40_000, timeoutMs: 5000 });
      const board = readBoard(box.stateDir, SESSION_ID, now);
      assert.deepEqual(board.map((e) => e.tool_use_id).sort(), ['toolu_main', 'toolu_sub']);
      assert.deepEqual(attribute(board, 'main', TICKET), { kind: 'refused', code: 'not_owner' });
    } finally {
      box.cleanup();
    }
  });

  test('the owner\'s own short-timeout command, still waiting 40 s on, is attributed', () => {
    const box = sandbox();
    try {
      const now = 1_000_000;
      const redeem = `op-bridge redeem ${TICKET}`;
      writeEntry(box.stateDir, SESSION_ID, { ...entry('main', redeem, 'toolu_main'), startedAt: now - 40_000, timeoutMs: 5000 });
      assert.deepEqual(attribute(readBoard(box.stateDir, SESSION_ID, now), 'main', TICKET), {
        kind: 'attributed',
        commands: [{ command: redeem, cwd: '/work/main', literal: true }],
      });
    } finally {
      box.cleanup();
    }
  });

  test('a signal aborted before the call returns null without reading the board or arming a timer', async () => {
    const clock = new TrackingClock();
    const abort = new AbortController();
    abort.abort();
    let reads = 0;
    assert.equal(await attributeWaiting(() => (reads++, [entry('main', 'x')]), 'main', TICKET, clock, abort.signal), null);
    assert.equal(reads, 0);
    assert.equal(clock.pending.size, 0);
  });
});
