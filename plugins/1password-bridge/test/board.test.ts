import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import {
  BACKGROUND_PRUNE_MARGIN_MS,
  commandTimeoutMs,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_SCAN_ATTEMPTS,
  moveToBackground,
  pruneBackground,
  pruneForeground,
  pruneStale,
  readBoard,
  removeEntry,
  STALE_GRACE_MS,
  writeEntry,
  type BoardEntry,
} from '../src/board.ts';
import { TICKET_TTL_MS } from '../src/broker/tickets.ts';
import { boardDir } from '../src/paths.ts';
import { sandbox, SESSION_ID } from './hooks/helpers.ts';

/** A fixed wall-clock time for moves to the background, so prunes need no real clock. */
const MOVED_AT = 1_700_000_000_000;

function entry(overrides: Partial<BoardEntry> = {}): BoardEntry {
  return { agent_id: 'main', tool_use_id: 'toolu_01', command: 'make deploy', cwd: '/work', startedAt: 1000, timeoutMs: 120_000, ...overrides };
}

function files(stateDir: string): string[] {
  return readdirSync(boardDir(stateDir, SESSION_ID)).sort();
}

/**
 * Runs `body` while every listing of the session's board goes through
 * `onList`, which gets the real listing and the call number (from 1) and
 * returns what the scan sees: a hook can rename or add an entry right after
 * the listing, before the scan reads it. Returns the number of board listings.
 */
function withBoardListing(stateDir: string, onList: (names: string[], call: number) => string[], body: () => void): number {
  const dir = boardDir(stateDir, SESSION_ID);
  const target = fs as unknown as { readdirSync: (...args: unknown[]) => unknown };
  const real = target.readdirSync;
  let calls = 0;
  target.readdirSync = (...args: unknown[]): unknown => {
    if (args[0] !== dir) return real(...args);
    calls += 1;
    return onList(real(dir) as string[], calls);
  };
  // src/board.ts holds a named import of readdirSync; this rebinds it.
  syncBuiltinESMExports();
  try {
    body();
  } finally {
    target.readdirSync = real;
    syncBuiltinESMExports();
  }
  return calls;
}

/** Runs `body` while every `utimesSync` call fails with `code`; returns the number of calls. */
function withFailingUtimes(code: string, body: () => void): number {
  const target = fs as unknown as { utimesSync: (...args: unknown[]) => unknown };
  const real = target.utimesSync;
  let calls = 0;
  target.utimesSync = (): never => {
    calls += 1;
    throw Object.assign(new Error(`${code}: utimes refused`), { code });
  };
  // src/board.ts holds a named import of utimesSync; this rebinds it.
  syncBuiltinESMExports();
  try {
    body();
  } finally {
    target.utimesSync = real;
    syncBuiltinESMExports();
  }
  return calls;
}

describe('board', () => {
  test('the timeout comes from the tool input, then BASH_MAX_TIMEOUT_MS, then 600 s', () => {
    assert.equal(commandTimeoutMs({ command: 'x', timeout: 5000 }, { BASH_MAX_TIMEOUT_MS: '900000' }), 5000);
    assert.equal(commandTimeoutMs({ command: 'x' }, { BASH_MAX_TIMEOUT_MS: '900000' }), 900_000);
    assert.equal(commandTimeoutMs({ command: 'x' }, { BASH_MAX_TIMEOUT_MS: 'soon' }), DEFAULT_COMMAND_TIMEOUT_MS);
    assert.equal(commandTimeoutMs(undefined, {}), DEFAULT_COMMAND_TIMEOUT_MS);
  });

  test('write, read, remove; an unsafe tool_use_id writes nothing', () => {
    const box = sandbox();
    try {
      writeEntry(box.stateDir, SESSION_ID, entry());
      writeEntry(box.stateDir, SESSION_ID, entry({ tool_use_id: '../escape' }));
      assert.deepEqual(files(box.stateDir), ['toolu_01.json']);
      assert.deepEqual(readBoard(box.stateDir, SESSION_ID, 2000), [{ ...entry(), background: false }]);
      removeEntry(box.stateDir, SESSION_ID, 'toolu_01');
      assert.deepEqual(readBoard(box.stateDir, SESSION_ID, 2000), []);
    } finally {
      box.cleanup();
    }
  });

  test('a background entry is renamed and has no age limit', () => {
    const box = sandbox();
    try {
      writeEntry(box.stateDir, SESSION_ID, entry());
      moveToBackground(box.stateDir, SESSION_ID, 'toolu_01', 'task_7');
      assert.deepEqual(files(box.stateDir), ['bg-task_7.json']);
      // Past the age limit a foreground entry with this timeout would have.
      const late = 1000 + Math.max(120_000, TICKET_TTL_MS) + STALE_GRACE_MS + 1;
      assert.deepEqual(readBoard(box.stateDir, SESSION_ID, late), [{ ...entry(), background: true }]);
    } finally {
      box.cleanup();
    }
  });

  test('a foreground entry past the larger of its timeout and the ticket lifetime, plus 30 s, is ignored, then pruned', () => {
    const box = sandbox();
    try {
      // A short timeout: the ticket lifetime is the floor, since a permission prompt can hold the command that long.
      writeEntry(box.stateDir, SESSION_ID, entry({ tool_use_id: 'toolu_short', timeoutMs: 5000 }));
      // A timeout longer than the ticket lifetime counts as it is.
      writeEntry(box.stateDir, SESSION_ID, entry({ tool_use_id: 'toolu_long', timeoutMs: 900_000 }));
      const live = (now: number): string[] => readBoard(box.stateDir, SESSION_ID, now).map((e) => e.tool_use_id).sort();
      const shortEdge = 1000 + TICKET_TTL_MS + STALE_GRACE_MS;
      const longEdge = 1000 + 900_000 + STALE_GRACE_MS;
      assert.deepEqual(live(1000 + 40_000), ['toolu_long', 'toolu_short']);
      assert.deepEqual(live(shortEdge), ['toolu_long', 'toolu_short']);
      pruneStale(box.stateDir, SESSION_ID, shortEdge);
      assert.deepEqual(files(box.stateDir), ['toolu_long.json', 'toolu_short.json']);
      assert.deepEqual(live(shortEdge + 1), ['toolu_long']);
      pruneStale(box.stateDir, SESSION_ID, shortEdge + 1);
      assert.deepEqual(files(box.stateDir), ['toolu_long.json']);
      assert.deepEqual(live(longEdge), ['toolu_long']);
      assert.deepEqual(live(longEdge + 1), []);
      pruneStale(box.stateDir, SESSION_ID, longEdge + 1);
      assert.deepEqual(files(box.stateDir), []);
    } finally {
      box.cleanup();
    }
  });

  test('pruneForeground removes one agent\'s foreground entries; pruneBackground keeps live tasks', () => {
    const box = sandbox();
    try {
      writeEntry(box.stateDir, SESSION_ID, entry({ tool_use_id: 'toolu_main' }));
      writeEntry(box.stateDir, SESSION_ID, entry({ tool_use_id: 'toolu_sub', agent_id: 'agent-1' }));
      writeEntry(box.stateDir, SESSION_ID, entry({ tool_use_id: 'toolu_bg1' }));
      writeEntry(box.stateDir, SESSION_ID, entry({ tool_use_id: 'toolu_bg2' }));
      moveToBackground(box.stateDir, SESSION_ID, 'toolu_bg1', 'task_1', MOVED_AT);
      moveToBackground(box.stateDir, SESSION_ID, 'toolu_bg2', 'task_2', MOVED_AT);
      pruneForeground(box.stateDir, SESSION_ID, 'main');
      assert.deepEqual(files(box.stateDir), ['bg-task_1.json', 'bg-task_2.json', 'toolu_sub.json']);
      pruneBackground(box.stateDir, SESSION_ID, new Set(['task_2']), MOVED_AT + BACKGROUND_PRUNE_MARGIN_MS + 1000);
      assert.deepEqual(files(box.stateDir), ['bg-task_2.json', 'toolu_sub.json']);
    } finally {
      box.cleanup();
    }
  });

  test('a background entry that moved after the prune\'s task list was taken survives that prune', () => {
    const box = sandbox();
    try {
      // Started long before the move: a command that reaches its timeout goes on in the background.
      writeEntry(box.stateDir, SESSION_ID, entry({ startedAt: MOVED_AT - DEFAULT_COMMAND_TIMEOUT_MS }));
      // The Stop payload's list, taken while the command was still in the foreground.
      const live = new Set<string>();
      moveToBackground(box.stateDir, SESSION_ID, 'toolu_01', 'task_7', MOVED_AT);
      pruneBackground(box.stateDir, SESSION_ID, live, MOVED_AT + 1000);
      assert.deepEqual(files(box.stateDir), ['bg-task_7.json']);
      pruneBackground(box.stateDir, SESSION_ID, live, MOVED_AT + BACKGROUND_PRUNE_MARGIN_MS + 1000);
      assert.deepEqual(files(box.stateDir), []);
    } finally {
      box.cleanup();
    }
  });

  test('by default the prune margin counts back from the hook process start, not from the call', () => {
    const box = sandbox();
    try {
      writeEntry(box.stateDir, SESSION_ID, entry({ tool_use_id: 'toolu_early' }));
      writeEntry(box.stateDir, SESSION_ID, entry({ tool_use_id: 'toolu_late' }));
      const edge = Math.ceil(performance.timeOrigin) - BACKGROUND_PRUNE_MARGIN_MS;
      moveToBackground(box.stateDir, SESSION_ID, 'toolu_early', 'task_early', edge - 1000);
      // Inside the margin counted from this process's start, outside it counted from now.
      moveToBackground(box.stateDir, SESSION_ID, 'toolu_late', 'task_late', edge + 1);
      pruneBackground(box.stateDir, SESSION_ID, new Set());
      assert.deepEqual(files(box.stateDir), ['bg-task_late.json']);
    } finally {
      box.cleanup();
    }
  });

  test('a failing utimes does not keep a command from moving to the background', () => {
    const box = sandbox();
    try {
      writeEntry(box.stateDir, SESSION_ID, entry());
      const calls = withFailingUtimes('EPERM', () => moveToBackground(box.stateDir, SESSION_ID, 'toolu_01', 'task_7', MOVED_AT));
      assert.equal(calls, 1);
      assert.deepEqual(files(box.stateDir), ['bg-task_7.json']);
      assert.deepEqual(readBoard(box.stateDir, SESSION_ID, 2000), [{ ...entry(), background: true }]);
      // A missing entry is still left alone.
      moveToBackground(box.stateDir, SESSION_ID, 'toolu_gone', 'task_8');
      assert.deepEqual(files(box.stateDir), ['bg-task_7.json']);
    } finally {
      box.cleanup();
    }
  });

  test('a foreground id with the background prefix is refused', () => {
    const box = sandbox();
    try {
      writeEntry(box.stateDir, SESSION_ID, entry());
      moveToBackground(box.stateDir, SESSION_ID, 'toolu_01', 'task_7');
      writeEntry(box.stateDir, SESSION_ID, entry({ tool_use_id: 'bg-task_8' }));
      removeEntry(box.stateDir, SESSION_ID, 'bg-task_7');
      moveToBackground(box.stateDir, SESSION_ID, 'bg-task_7', 'task_9');
      assert.deepEqual(files(box.stateDir), ['bg-task_7.json']);
    } finally {
      box.cleanup();
    }
  });

  test('an entry renamed to the background between the listing and its read is still read', () => {
    const box = sandbox();
    try {
      writeEntry(box.stateDir, SESSION_ID, entry());
      const listings = withBoardListing(
        box.stateDir,
        (names, call) => {
          if (call === 1) moveToBackground(box.stateDir, SESSION_ID, 'toolu_01', 'task_7');
          return names;
        },
        () => assert.deepEqual(readBoard(box.stateDir, SESSION_ID, 2000), [{ ...entry(), background: true }]),
      );
      assert.ok(listings > 2, `listings: ${listings}`);
    } finally {
      box.cleanup();
    }
  });

  test('a listing that shows neither name while the rename lands is repeated', () => {
    const box = sandbox();
    try {
      writeEntry(box.stateDir, SESSION_ID, entry());
      withBoardListing(
        box.stateDir,
        (names, call) => {
          if (call !== 1) return names;
          // A listing read in several steps can miss both names of a file renamed meanwhile.
          moveToBackground(box.stateDir, SESSION_ID, 'toolu_01', 'task_7');
          return names.filter((name) => name !== 'toolu_01.json');
        },
        () => assert.deepEqual(readBoard(box.stateDir, SESSION_ID, 2000), [{ ...entry(), background: true }]),
      );
    } finally {
      box.cleanup();
    }
  });

  test('a scan that never settles returns every entry it saw, each once', () => {
    const box = sandbox();
    try {
      writeEntry(box.stateDir, SESSION_ID, entry({ tool_use_id: 'toolu_a' }));
      writeEntry(box.stateDir, SESSION_ID, entry({ tool_use_id: 'toolu_b' }));
      const listings = withBoardListing(
        box.stateDir,
        (names, call) => {
          if (call === 1) moveToBackground(box.stateDir, SESSION_ID, 'toolu_b', 'task_b');
          // A new command starts after every listing, so no two listings match.
          writeEntry(box.stateDir, SESSION_ID, entry({ tool_use_id: `toolu_new${call}` }));
          return names;
        },
        () => {
          const board = readBoard(box.stateDir, SESSION_ID, 2000);
          assert.deepEqual(board.filter((e) => e.tool_use_id === 'toolu_a'), [{ ...entry({ tool_use_id: 'toolu_a' }), background: false }]);
          assert.deepEqual(board.filter((e) => e.tool_use_id === 'toolu_b'), [{ ...entry({ tool_use_id: 'toolu_b' }), background: true }]);
        },
      );
      // Every pass lists once, and once more unless a file vanished; then the scan stops.
      assert.ok(listings >= MAX_SCAN_ATTEMPTS && listings <= 2 * MAX_SCAN_ATTEMPTS, `listings: ${listings}`);
    } finally {
      box.cleanup();
    }
  });

  test('a missing board reads empty and prunes nothing', () => {
    const box = sandbox();
    try {
      assert.deepEqual(readBoard(box.stateDir, SESSION_ID, 0), []);
      pruneStale(box.stateDir, SESSION_ID, 0);
      pruneForeground(box.stateDir, SESSION_ID, 'main');
      pruneBackground(box.stateDir, SESSION_ID, new Set());
    } finally {
      box.cleanup();
    }
  });
});
