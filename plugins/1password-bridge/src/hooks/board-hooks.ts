/**
 * The hooks' side of the board (`src/board.ts`): a Bash command goes on it
 * at PreToolUse and leaves at PostToolUse or PostToolUseFailure, or moves to
 * a background entry; Stop and SubagentStop clear what their agent left, and
 * background entries whose task is no longer listed, once they moved over
 * BACKGROUND_PRUNE_MARGIN_MS before the hook process started (`pruneBackground`
 * counts from `performance.timeOrigin`).
 *
 * PreToolUse, PostToolUse and PostToolUseFailure keep their board call in its
 * own try/catch, and `stop` keeps each of its two prunes in its own: a board
 * failure, or an id the board refuses (thrown here as a `BoardRefusal`), is
 * logged as step `board` and never blocks a command, skips the masking that
 * follows, or skips the other prune.
 */

import {
  commandTimeoutMs,
  hasBackgroundPrefix,
  isTaskId,
  moveToBackground,
  pruneBackground,
  pruneForeground,
  removeEntry,
  writeEntry,
  type BoardEntry,
} from '../board.ts';
import { isPlainObject, liveSessionId, type HookContext, type HookOutput } from './common.ts';
import { logHookError } from './log.ts';

/** What the board refused; the hook log records it as the line's code. */
export type RefusalCode = 'BACKGROUND_TOOL_USE_ID' | 'UNUSABLE_TASK_ID';

/** An id the board will not use. It changes nothing on the board; the caller's catch logs it. */
export class BoardRefusal extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode) {
    super(code);
    this.name = 'BoardRefusal';
    this.code = code;
  }
}

function agentOf(ctx: HookContext): string {
  const agent = ctx.input['agent_id'];
  return typeof agent === 'string' && agent !== '' ? agent : 'main';
}

/** Throws for a tool_use_id with the background prefix, which the board refuses so it never names a background entry. */
function refuseBackgroundPrefix(toolUseId: string): void {
  if (hasBackgroundPrefix(toolUseId)) throw new BoardRefusal('BACKGROUND_TOOL_USE_ID');
}

/** PreToolUse Bash: puts the command on the board under its tool_use_id. */
export function boardBefore(ctx: HookContext, now: number = Date.now()): void {
  const id = liveSessionId(ctx.input);
  const toolUseId = ctx.input['tool_use_id'];
  const toolInput = ctx.input['tool_input'];
  if (id === undefined || typeof toolUseId !== 'string' || !isPlainObject(toolInput)) return;
  const command = toolInput['command'];
  if (typeof command !== 'string') return;
  refuseBackgroundPrefix(toolUseId);
  const cwd = ctx.input['cwd'];
  const type = ctx.input['agent_type'];
  const entry: BoardEntry = {
    agent_id: agentOf(ctx),
    tool_use_id: toolUseId,
    command,
    cwd: typeof cwd === 'string' ? cwd : '',
    startedAt: now,
    timeoutMs: commandTimeoutMs(toolInput, ctx.env),
  };
  if (typeof type === 'string' && type !== '') entry.agent_type = type;
  writeEntry(ctx.stateDir, id, entry);
}

/**
 * PostToolUse Bash: without `tool_response.backgroundTaskId` takes the command
 * off the board; with it moves the entry to `bg-<backgroundTaskId>`, a number
 * taken as text. An id the board cannot use as a file name throws and leaves
 * the foreground entry: the command goes on running, and deleting the entry
 * would hide it from attribution; its agent's Stop or SubagentStop, or its age
 * limit, takes it off.
 */
export function boardAfter(ctx: HookContext): void {
  const id = liveSessionId(ctx.input);
  const toolUseId = ctx.input['tool_use_id'];
  if (id === undefined || typeof toolUseId !== 'string') return;
  refuseBackgroundPrefix(toolUseId);
  const response = ctx.input['tool_response'];
  const taskId = isPlainObject(response) ? response['backgroundTaskId'] : undefined;
  if (taskId === undefined) {
    removeEntry(ctx.stateDir, id, toolUseId);
    return;
  }
  const name = typeof taskId === 'number' ? String(taskId) : taskId;
  if (typeof name !== 'string' || !isTaskId(name)) throw new BoardRefusal('UNUSABLE_TASK_ID');
  moveToBackground(ctx.stateDir, id, toolUseId, name);
}

/** PostToolUseFailure Bash: takes the command off the board. */
export function boardFailed(ctx: HookContext): void {
  const id = liveSessionId(ctx.input);
  const toolUseId = ctx.input['tool_use_id'];
  if (id === undefined || typeof toolUseId !== 'string') return;
  refuseBackgroundPrefix(toolUseId);
  removeEntry(ctx.stateDir, id, toolUseId);
}

/**
 * The task ids of the payload's `background_tasks`; undefined when the list is
 * missing or holds an entry without a recognizable id, so nothing is pruned
 * on a guess.
 */
export function backgroundTaskIds(v: unknown): Set<string> | undefined {
  if (!Array.isArray(v)) return undefined;
  const ids = new Set<string>();
  for (const task of v as unknown[]) {
    const id = typeof task === 'string' ? task : isPlainObject(task) ? (task['id'] ?? task['task_id'] ?? task['taskId']) : undefined;
    if (typeof id !== 'string' || id === '') return undefined;
    ids.add(id);
  }
  return ids;
}

/**
 * Stop (the main agent) and SubagentStop (that subagent): the foreground prune
 * and the background prune each run in their own try/catch, so one failing
 * does not skip the other. A SubagentStop without an agent id prunes no
 * foreground entry, since it cannot name main's.
 */
export function stop(ctx: HookContext): HookOutput | undefined {
  const id = liveSessionId(ctx.input);
  if (id === undefined) return undefined;
  const event = ctx.input['hook_event_name'] === 'SubagentStop' ? 'SubagentStop' : 'Stop';
  const agent = event === 'Stop' ? 'main' : agentOf(ctx);
  if (event === 'Stop' || agent !== 'main') {
    try {
      pruneForeground(ctx.stateDir, id, agent);
    } catch (err) {
      logHookError(ctx.stateDir, event, 'board', err);
    }
  }
  const live = backgroundTaskIds(ctx.input['background_tasks']);
  if (live !== undefined) {
    try {
      pruneBackground(ctx.stateDir, id, live);
    } catch (err) {
      logHookError(ctx.stateDir, event, 'board', err);
    }
  }
  return undefined;
}
