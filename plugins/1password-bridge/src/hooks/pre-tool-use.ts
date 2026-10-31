/**
 * PreToolUse: hands the plugin's own session-bound tools the live session id,
 * transcript path, agent id (`main` for the main agent), agent type and cwd.
 *
 * The MCP server's `CLAUDE_CODE_SESSION_ID` goes stale after /clear, and the
 * server cannot tell agents apart, so it takes all of this from the tool
 * input, and this hook is what sets it. Bash is not rewritten (rewriting a
 * command breaks permission allow rules): the command goes on the session's
 * board and the hook outputs nothing, even when the board write fails.
 */

import { boardBefore } from './board-hooks.ts';
import { isPlainObject, liveSessionId, type HookContext, type HookOutput } from './common.ts';
import { logHookError } from './log.ts';

export const BRIDGE_TOOL = /^mcp__plugin_1password-bridge_op__(fields|issue_tickets|release)$/;

/** Bash commands go on the session's board (`src/board.ts`); their input is never rewritten. */
export const BASH_TOOL = /^Bash$/;

/** The input keys this hook owns: a value the model wrote for one never survives. */
const INJECTED: readonly string[] = ['session_id', 'transcript_path', 'agent_id', 'agent_type', 'cwd'];

export function preToolUse(ctx: HookContext): HookOutput | undefined {
  const tool = ctx.input['tool_name'];
  if (typeof tool === 'string' && BASH_TOOL.test(tool)) {
    try {
      boardBefore(ctx);
    } catch (err) {
      logHookError(ctx.stateDir, 'PreToolUse', 'board', err);
    }
    return undefined;
  }
  const toolInput = ctx.input['tool_input'];
  if (typeof tool !== 'string' || !BRIDGE_TOOL.test(tool) || !isPlainObject(toolInput)) return undefined;

  // `updatedInput` replaces the whole input, so every other field is kept.
  const updatedInput: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(toolInput)) {
    if (!INJECTED.includes(key)) updatedInput[key] = value;
  }
  const sessionId = liveSessionId(ctx.input);
  if (sessionId !== undefined) updatedInput['session_id'] = sessionId;
  for (const key of ['transcript_path', 'agent_type', 'cwd']) {
    const value = ctx.input[key];
    if (typeof value === 'string' && value !== '') updatedInput[key] = value;
  }
  const agent = ctx.input['agent_id'];
  updatedInput['agent_id'] = typeof agent === 'string' && agent !== '' ? agent : 'main';

  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } };
}
