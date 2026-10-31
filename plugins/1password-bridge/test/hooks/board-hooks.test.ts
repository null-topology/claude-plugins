import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BACKGROUND_PRUNE_MARGIN_MS, readBoard, writeEntry } from '../../src/board.ts';
import { backgroundTaskIds } from '../../src/hooks/board-hooks.ts';
import { hookLogPath } from '../../src/hooks/log.ts';
import type { AskBroker } from '../../src/hooks/broker.ts';
import { postToolUse, withheldNote } from '../../src/hooks/post-tool-use.ts';
import { postToolUseFailure } from '../../src/hooks/post-tool-use-failure.ts';
import { dispatch } from '../../src/hooks/run.ts';
import { BrokerError } from '../../src/mcp/broker-client.ts';
import { boardDir, sessionDir } from '../../src/paths.ts';
import { markTicket } from '../../src/session-files.ts';
import { context, sandbox, SECRET, SESSION_ID } from './helpers.ts';

const TICKET = 'tkt_aaaaaaaaaaaaaaaa';

/** A broker that masks SECRET the way the real one does. */
const masking: AskBroker = async (req) => {
  if (req.op !== 'mask') throw new Error(`unexpected ${req.op}`);
  const text = JSON.stringify(req.output);
  const masked = text.replaceAll(SECRET, `<masked ticket=${TICKET}>`);
  const changed = masked !== text;
  return { ok: true, op: 'mask', known: true, changed, output: changed ? (JSON.parse(masked) as unknown) : null, missing: [] };
};

const down: AskBroker = async () => {
  throw new BrokerError('unavailable', 'The 1password-bridge broker is not running.');
};

function bash(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: event,
    session_id: SESSION_ID,
    cwd: '/work/site',
    tool_name: 'Bash',
    tool_use_id: 'toolu_1',
    tool_input: { command: 'make deploy', timeout: 300_000 },
    ...extra,
  };
}

function files(stateDir: string): string[] {
  return readdirSync(boardDir(stateDir, SESSION_ID)).sort();
}

describe('board hooks', () => {
  test('PreToolUse Bash puts the command on the board and outputs nothing', async () => {
    const box = sandbox();
    try {
      assert.equal(await dispatch(context(box.stateDir, bash('PreToolUse'))), undefined);
      const [entry] = readBoard(box.stateDir, SESSION_ID, Date.now());
      assert.equal(entry?.agent_id, 'main');
      assert.equal(entry?.command, 'make deploy');
      assert.equal(entry?.cwd, '/work/site');
      assert.equal(entry?.timeoutMs, 300_000);
      assert.equal(entry?.background, false);
    } finally {
      box.cleanup();
    }
  });

  test('a subagent\'s command carries its agent id and type', async () => {
    const box = sandbox();
    try {
      await dispatch(context(box.stateDir, bash('PreToolUse', { agent_id: 'agent-1', agent_type: 'general-purpose' })));
      const [entry] = readBoard(box.stateDir, SESSION_ID, Date.now());
      assert.equal(entry?.agent_id, 'agent-1');
      assert.equal(entry?.agent_type, 'general-purpose');
    } finally {
      box.cleanup();
    }
  });

  test('without a timeout in the tool input, BASH_MAX_TIMEOUT_MS sets the entry\'s timeout', async () => {
    const box = sandbox();
    try {
      await dispatch(context(box.stateDir, bash('PreToolUse', { tool_input: { command: 'make deploy' } }), { BASH_MAX_TIMEOUT_MS: '900000' }));
      const [entry] = readBoard(box.stateDir, SESSION_ID, Date.now());
      assert.equal(entry?.timeoutMs, 900_000);
    } finally {
      box.cleanup();
    }
  });

  test('PostToolUse removes the entry, or renames it when the command went to the background', async () => {
    const box = sandbox();
    try {
      await dispatch(context(box.stateDir, bash('PreToolUse')));
      await dispatch(context(box.stateDir, bash('PostToolUse', { tool_response: { stdout: '', backgroundTaskId: 'task_9' } })));
      assert.deepEqual(files(box.stateDir), ['bg-task_9.json']);
      await dispatch(context(box.stateDir, bash('PreToolUse', { tool_use_id: 'toolu_2' })));
      await dispatch(context(box.stateDir, bash('PostToolUse', { tool_use_id: 'toolu_2', tool_response: { stdout: 'ok' } })));
      assert.deepEqual(files(box.stateDir), ['bg-task_9.json']);
    } finally {
      box.cleanup();
    }
  });

  test('without a backgroundTaskId PostToolUse removes the entry, also when tool_response is not an object', async () => {
    const box = sandbox();
    try {
      const responses: Record<string, unknown>[] = [{ tool_response: { stdout: 'ok' } }, { tool_response: 'ok' }, {}];
      for (const [i, response] of responses.entries()) {
        await dispatch(context(box.stateDir, bash('PreToolUse', { tool_use_id: `toolu_${i}` })));
        await dispatch(context(box.stateDir, bash('PostToolUse', { tool_use_id: `toolu_${i}`, ...response })));
        assert.deepEqual(files(box.stateDir), [], JSON.stringify(response));
      }
      assert.equal(existsSync(hookLogPath(box.stateDir)), false);
    } finally {
      box.cleanup();
    }
  });

  test('a numeric backgroundTaskId is used as text', async () => {
    const box = sandbox();
    try {
      await dispatch(context(box.stateDir, bash('PreToolUse')));
      await dispatch(context(box.stateDir, bash('PostToolUse', { tool_response: { stdout: '', backgroundTaskId: 42 } })));
      assert.deepEqual(files(box.stateDir), ['bg-42.json']);
      assert.equal(existsSync(hookLogPath(box.stateDir)), false);
    } finally {
      box.cleanup();
    }
  });

  test('a backgroundTaskId the board cannot use keeps the foreground entry and logs step board', async () => {
    const box = sandbox();
    try {
      await dispatch(context(box.stateDir, bash('PreToolUse')));
      const unusable: unknown[] = ['../task_9', 'task 9', '', 1.5, true, null, { id: 'task_9' }];
      for (const backgroundTaskId of unusable) {
        await dispatch(context(box.stateDir, bash('PostToolUse', { tool_response: { stdout: '', backgroundTaskId } })));
        assert.deepEqual(files(box.stateDir), ['toolu_1.json'], JSON.stringify(backgroundTaskId));
      }
      assert.deepEqual(
        logged(box.stateDir),
        unusable.map(() => ({ event: 'PostToolUse', step: 'board', code: 'UNUSABLE_TASK_ID' })),
      );
    } finally {
      box.cleanup();
    }
  });

  test('PostToolUseFailure removes the entry', async () => {
    const box = sandbox();
    try {
      await dispatch(context(box.stateDir, bash('PreToolUse')));
      await dispatch(context(box.stateDir, bash('PostToolUseFailure', { error: 'boom' })));
      assert.deepEqual(files(box.stateDir), []);
    } finally {
      box.cleanup();
    }
  });

  test('Stop prunes the main agent\'s foreground entries and finished background ones moved over 10 s before it; SubagentStop prunes that agent\'s', async () => {
    const box = sandbox();
    const entry = (id: string, agent: string) => ({ agent_id: agent, tool_use_id: id, command: 'x', cwd: '/', startedAt: Date.now(), timeoutMs: 600_000 });
    const toBackground = (id: string, task: string) =>
      dispatch(context(box.stateDir, bash('PostToolUse', { tool_use_id: id, tool_response: { backgroundTaskId: task } })));
    try {
      writeEntry(box.stateDir, SESSION_ID, entry('toolu_main', 'main'));
      writeEntry(box.stateDir, SESSION_ID, entry('toolu_sub', 'agent-1'));
      writeEntry(box.stateDir, SESSION_ID, entry('toolu_bg', 'main'));
      writeEntry(box.stateDir, SESSION_ID, entry('toolu_fresh', 'main'));
      await toBackground('toolu_bg', 'task_1');
      await toBackground('toolu_fresh', 'task_2');
      // The hook counts the margin back from its process start, here the test
      // process's: task_1 is aged past it, task_2 moved just now.
      const aged = new Date(performance.timeOrigin - BACKGROUND_PRUNE_MARGIN_MS - 1000);
      utimesSync(join(boardDir(box.stateDir, SESSION_ID), 'bg-task_1.json'), aged, aged);
      await dispatch(context(box.stateDir, { hook_event_name: 'Stop', session_id: SESSION_ID, background_tasks: [] }));
      // task_2 moved less than 10 s before the hook started, so its task may postdate the list.
      assert.deepEqual(files(box.stateDir), ['bg-task_2.json', 'toolu_sub.json']);
      await dispatch(context(box.stateDir, { hook_event_name: 'SubagentStop', session_id: SESSION_ID, agent_id: 'agent-1' }));
      // No background_tasks in the payload: nothing in the background is pruned on a guess.
      assert.deepEqual(files(box.stateDir), ['bg-task_2.json']);
    } finally {
      box.cleanup();
    }
  });

  test('background_tasks: ids from strings or objects; anything else prunes nothing', () => {
    assert.deepEqual(backgroundTaskIds(['a', { id: 'b' }, { task_id: 'c' }, { taskId: 'd' }]), new Set(['a', 'b', 'c', 'd']));
    assert.equal(backgroundTaskIds(undefined), undefined);
    assert.equal(backgroundTaskIds([{ name: 'x' }]), undefined);
  });

  test('a background entry whose task is still listed stays, however old its move', async () => {
    const box = sandbox();
    try {
      await dispatch(context(box.stateDir, bash('PreToolUse')));
      await dispatch(context(box.stateDir, bash('PostToolUse', { tool_response: { backgroundTaskId: 'task_9' } })));
      const aged = new Date(performance.timeOrigin - BACKGROUND_PRUNE_MARGIN_MS - 1000);
      utimesSync(join(boardDir(box.stateDir, SESSION_ID), 'bg-task_9.json'), aged, aged);
      await dispatch(context(box.stateDir, { hook_event_name: 'Stop', session_id: SESSION_ID, background_tasks: [{ id: 'task_9' }] }));
      assert.deepEqual(files(box.stateDir), ['bg-task_9.json']);
      await dispatch(context(box.stateDir, { hook_event_name: 'SubagentStop', session_id: SESSION_ID, agent_id: 'agent-1', background_tasks: [] }));
      assert.deepEqual(files(box.stateDir), []);
    } finally {
      box.cleanup();
    }
  });

  test('a SubagentStop without an agent id prunes no foreground entry', async () => {
    const box = sandbox();
    try {
      await dispatch(context(box.stateDir, bash('PreToolUse')));
      await dispatch(context(box.stateDir, bash('PreToolUse', { tool_use_id: 'toolu_2', agent_id: 'agent-1' })));
      await dispatch(context(box.stateDir, { hook_event_name: 'SubagentStop', session_id: SESSION_ID }));
      await dispatch(context(box.stateDir, { hook_event_name: 'SubagentStop', session_id: SESSION_ID, agent_id: '' }));
      assert.deepEqual(files(box.stateDir), ['toolu_1.json', 'toolu_2.json']);
    } finally {
      box.cleanup();
    }
  });

  test('a SubagentStop leaves the main agent\'s foreground entries alone', async () => {
    const box = sandbox();
    try {
      await dispatch(context(box.stateDir, bash('PreToolUse')));
      await dispatch(context(box.stateDir, bash('PreToolUse', { tool_use_id: 'toolu_2', agent_id: 'agent-1' })));
      await dispatch(context(box.stateDir, { hook_event_name: 'SubagentStop', session_id: SESSION_ID, agent_id: 'agent-1', background_tasks: [] }));
      assert.deepEqual(files(box.stateDir), ['toolu_1.json']);
    } finally {
      box.cleanup();
    }
  });

  test('a tool_use_id starting with bg- never writes, removes or moves a background entry', async () => {
    const box = sandbox();
    try {
      await dispatch(context(box.stateDir, bash('PreToolUse')));
      await dispatch(context(box.stateDir, bash('PostToolUse', { tool_response: { backgroundTaskId: 'task_9' } })));
      const before = readFileSync(join(boardDir(box.stateDir, SESSION_ID), 'bg-task_9.json'), 'utf8');
      const spoof = { tool_use_id: 'bg-task_9', tool_input: { command: 'other' } };
      assert.equal(await dispatch(context(box.stateDir, bash('PreToolUse', spoof))), undefined);
      await dispatch(context(box.stateDir, bash('PostToolUse', { ...spoof, tool_response: { stdout: '' } })));
      await dispatch(context(box.stateDir, bash('PostToolUse', { ...spoof, tool_response: { backgroundTaskId: 'task_10' } })));
      await dispatch(context(box.stateDir, bash('PostToolUseFailure', { ...spoof, error: 'boom' })));
      assert.deepEqual(files(box.stateDir), ['bg-task_9.json']);
      assert.equal(readFileSync(join(boardDir(box.stateDir, SESSION_ID), 'bg-task_9.json'), 'utf8'), before);
      const refused = { step: 'board', code: 'BACKGROUND_TOOL_USE_ID' };
      assert.deepEqual(logged(box.stateDir), [
        { event: 'PreToolUse', ...refused },
        { event: 'PostToolUse', ...refused },
        { event: 'PostToolUse', ...refused },
        { event: 'PostToolUseFailure', ...refused },
      ]);
    } finally {
      box.cleanup();
    }
  });

  test('only Bash goes on and off the board', async () => {
    const box = sandbox();
    try {
      await dispatch(context(box.stateDir, bash('PreToolUse', { tool_name: 'Monitor' })));
      assert.deepEqual(readBoard(box.stateDir, SESSION_ID, Date.now()), []);
      await dispatch(context(box.stateDir, bash('PreToolUse')));
      await dispatch(context(box.stateDir, bash('PostToolUse', { tool_name: 'Monitor', tool_response: { stdout: '' } })));
      await dispatch(context(box.stateDir, bash('PostToolUseFailure', { tool_name: 'Monitor', error: 'boom' })));
      assert.deepEqual(files(box.stateDir), ['toolu_1.json']);
    } finally {
      box.cleanup();
    }
  });
});

/** The event, step and code of each line in the hook log. */
function logged(stateDir: string): { event: unknown; step: unknown; code: unknown }[] {
  return readFileSync(hookLogPath(stateDir), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const { event, step, code } = JSON.parse(line) as Record<string, unknown>;
      return { event, step, code };
    });
}

/**
 * A regular file where the board directory belongs: every board operation
 * fails, root or not. A write's mkdir fails with EEXIST, the others with ENOTDIR.
 */
function breakBoard(stateDir: string): void {
  mkdirSync(sessionDir(stateDir, SESSION_ID), { recursive: true });
  writeFileSync(boardDir(stateDir, SESSION_ID), '');
}

describe('a board that fails', () => {
  test('PreToolUse Bash still outputs nothing and logs step board', async () => {
    const box = sandbox();
    try {
      breakBoard(box.stateDir);
      assert.equal(await dispatch(context(box.stateDir, bash('PreToolUse'))), undefined);
      assert.deepEqual(logged(box.stateDir), [{ event: 'PreToolUse', step: 'board', code: 'EEXIST' }]);
    } finally {
      box.cleanup();
    }
  });

  test('PostToolUse still masks the output through the broker, after a failed removal and a failed move alike', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      breakBoard(box.stateDir);
      for (const response of [{ stdout: `TOKEN=${SECRET}` }, { stdout: `TOKEN=${SECRET}`, backgroundTaskId: 'task_9' }]) {
        const out = await postToolUse(context(box.stateDir, bash('PostToolUse', { tool_response: response })), masking);
        assert.deepEqual(out, {
          hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...response, stdout: `TOKEN=<masked ticket=${TICKET}>` } },
        });
      }
      assert.deepEqual(logged(box.stateDir), [
        { event: 'PostToolUse', step: 'board', code: 'ENOTDIR' },
        { event: 'PostToolUse', step: 'board', code: 'ENOTDIR' },
      ]);
    } finally {
      box.cleanup();
    }
  });

  test('PostToolUse still withholds the output when the broker cannot be reached, after a failed removal and a failed move alike', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      breakBoard(box.stateDir);
      const note = withheldNote([TICKET]);
      // Every string is withheld, the background task id too; the keys stay.
      for (const [response, expected] of [
        [{ stdout: `TOKEN=${SECRET}` }, { stdout: note }],
        [{ stdout: `TOKEN=${SECRET}`, backgroundTaskId: 'task_9' }, { stdout: note, backgroundTaskId: note }],
      ] as const) {
        const out = await postToolUse(context(box.stateDir, bash('PostToolUse', { tool_response: response })), down);
        assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: expected } });
      }
      assert.deepEqual(logged(box.stateDir), [
        { event: 'PostToolUse', step: 'board', code: 'ENOTDIR' },
        { event: 'PostToolUse', step: 'mask', code: 'UNAVAILABLE' },
        { event: 'PostToolUse', step: 'board', code: 'ENOTDIR' },
        { event: 'PostToolUse', step: 'mask', code: 'UNAVAILABLE' },
      ]);
    } finally {
      box.cleanup();
    }
  });

  test('PostToolUseFailure still names the ticket whose value the error holds, or warns when the broker cannot check', async () => {
    const box = sandbox();
    try {
      markTicket(box.stateDir, SESSION_ID, TICKET);
      breakBoard(box.stateDir);
      const failed = bash('PostToolUseFailure', { error: `failed: ${SECRET}` });
      const named = await postToolUseFailure(context(box.stateDir, failed), masking);
      assert.match(named?.hookSpecificOutput?.additionalContext ?? '', new RegExp(`unmasked value of ticket ${TICKET}`));
      const unchecked = await postToolUseFailure(context(box.stateDir, failed), down);
      assert.match(unchecked?.hookSpecificOutput?.additionalContext ?? '', /may contain an unmasked secret value/);
      assert.deepEqual(logged(box.stateDir), [
        { event: 'PostToolUseFailure', step: 'board', code: 'ENOTDIR' },
        { event: 'PostToolUseFailure', step: 'board', code: 'ENOTDIR' },
        { event: 'PostToolUseFailure', step: 'scan', code: 'UNAVAILABLE' },
      ]);
    } finally {
      box.cleanup();
    }
  });

  test('Stop and SubagentStop output nothing and log step board for each prune that fails', async () => {
    const box = sandbox();
    try {
      breakBoard(box.stateDir);
      assert.equal(await dispatch(context(box.stateDir, { hook_event_name: 'Stop', session_id: SESSION_ID, background_tasks: [] })), undefined);
      assert.equal(await dispatch(context(box.stateDir, { hook_event_name: 'SubagentStop', session_id: SESSION_ID, agent_id: 'agent-1' })), undefined);
      // Stop: the foreground prune, then the background one; SubagentStop has no task list, so no background prune.
      assert.deepEqual(logged(box.stateDir), [
        { event: 'Stop', step: 'board', code: 'ENOTDIR' },
        { event: 'Stop', step: 'board', code: 'ENOTDIR' },
        { event: 'SubagentStop', step: 'board', code: 'ENOTDIR' },
      ]);
    } finally {
      box.cleanup();
    }
  });

  test('a foreground prune that fails does not skip the background prune', async () => {
    const box = sandbox();
    try {
      const fresh = { agent_id: 'main', command: 'x', cwd: '/', startedAt: Date.now(), timeoutMs: 600_000 };
      writeEntry(box.stateDir, SESSION_ID, { ...fresh, tool_use_id: 'toolu_main' });
      writeEntry(box.stateDir, SESSION_ID, { ...fresh, tool_use_id: 'toolu_bg' });
      await dispatch(context(box.stateDir, bash('PostToolUse', { tool_use_id: 'toolu_bg', tool_response: { backgroundTaskId: 'task_1' } })));
      const aged = new Date(performance.timeOrigin - BACKGROUND_PRUNE_MARGIN_MS - 1000);
      utimesSync(join(boardDir(box.stateDir, SESSION_ID), 'bg-task_1.json'), aged, aged);
      const listings = await withFirstListingFailing(box.stateDir, () =>
        dispatch(context(box.stateDir, { hook_event_name: 'Stop', session_id: SESSION_ID, background_tasks: [] })),
      );
      assert.ok(listings > 1, `listings: ${listings}`);
      // The foreground prune failed on its first listing and left main's entry; the background prune still ran.
      assert.deepEqual(files(box.stateDir), ['toolu_main.json']);
      assert.deepEqual(logged(box.stateDir), [{ event: 'Stop', step: 'board', code: 'EIO' }]);
    } finally {
      box.cleanup();
    }
  });
});

/**
 * Runs `body` while the first listing of the session's board fails with EIO;
 * later listings pass. Returns the number of board listings.
 */
async function withFirstListingFailing(stateDir: string, body: () => Promise<unknown>): Promise<number> {
  const dir = boardDir(stateDir, SESSION_ID);
  const target = fs as unknown as { readdirSync: (...args: unknown[]) => unknown };
  const real = target.readdirSync;
  let calls = 0;
  target.readdirSync = (...args: unknown[]): unknown => {
    if (args[0] === dir && ++calls === 1) throw Object.assign(new Error('EIO: listing refused'), { code: 'EIO' });
    return real(...args);
  };
  // src/board.ts holds a named import of readdirSync; this rebinds it.
  syncBuiltinESMExports();
  try {
    await body();
  } finally {
    target.readdirSync = real;
    syncBuiltinESMExports();
  }
  return calls;
}
