/**
 * One hook run: read the input to the end, mark the session live
 * (`keepSession`), dispatch on `hook_event_name`, write the handler's JSON,
 * if any.
 *
 * It never throws and never writes anything but a handler's output: an error
 * becomes a line in the hook log (a code, never a message or the input), and
 * the run ends with nothing written, which Claude Code reads as "no change".
 * The input is not size-capped: a capped PostToolUse would let a large
 * output through unmasked.
 */

import { pruneStale } from '../board.ts';
import { resolveStateDir, type Environment } from '../paths.ts';
import { touchLastSeen } from '../session-files.ts';
import { stop } from './board-hooks.ts';
import { isPlainObject, liveSessionId, type HookContext, type HookInput, type HookOutput } from './common.ts';
import { logHookError } from './log.ts';
import { postToolUseFailure } from './post-tool-use-failure.ts';
import { postToolUse } from './post-tool-use.ts';
import { preToolUse } from './pre-tool-use.ts';
import { sessionEnd } from './session-end.ts';
import { sessionStart } from './session-start.ts';

export interface HookIo {
  readonly stdin: AsyncIterable<Buffer | string>;
  readonly env: Environment;
  write(text: string): void;
}

export async function dispatch(ctx: HookContext): Promise<HookOutput | undefined> {
  switch (ctx.input['hook_event_name']) {
    case 'SessionStart':
      return sessionStart(ctx);
    case 'PreToolUse':
      return preToolUse(ctx);
    case 'PostToolUse':
      return postToolUse(ctx);
    case 'PostToolUseFailure':
      return postToolUseFailure(ctx);
    case 'Stop':
    case 'SubagentStop':
      return stop(ctx);
    case 'SessionEnd':
      return sessionEnd(ctx);
    default:
      return undefined;
  }
}

/** A `keepSession` step, as the hook log names it. */
export type KeepStep = 'touch' | 'prune';

/**
 * Every hook run but SessionEnd marks its session live (the SessionStart sweep
 * keys on `last-seen`) and deletes board entries past their age limit.
 *
 * It never throws: each step that fails goes to `fail`, by default a line in
 * the hook log, and the other step still runs.
 */
export function keepSession(
  ctx: HookContext,
  now: number = Date.now(),
  fail: (step: KeepStep, err: unknown) => void = (step, err) => logHookError(ctx.stateDir, ctx.input['hook_event_name'], step, err),
): void {
  const id = liveSessionId(ctx.input);
  if (id === undefined || ctx.input['hook_event_name'] === 'SessionEnd') return;
  try {
    touchLastSeen(ctx.stateDir, id, now);
  } catch (err) {
    fail('touch', err);
  }
  try {
    pruneStale(ctx.stateDir, id, now);
  } catch (err) {
    fail('prune', err);
  }
}

async function readAll(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function runHook(io: HookIo): Promise<void> {
  let stateDir: string;
  try {
    stateDir = resolveStateDir(io.env);
  } catch {
    // No state directory means no tickets, no board and nowhere to log.
    return;
  }
  let event: unknown;
  try {
    const parsed: unknown = JSON.parse(await readAll(io.stdin));
    if (!isPlainObject(parsed)) return;
    const input: HookInput = parsed;
    event = input['hook_event_name'];
    const ctx: HookContext = { input, stateDir, pluginRoot: io.env['CLAUDE_PLUGIN_ROOT'] ?? '', env: io.env };
    keepSession(ctx);
    const output = await dispatch(ctx);
    if (output !== undefined) io.write(`${JSON.stringify(output)}\n`);
  } catch (err) {
    logHookError(stateDir, event, 'run', err);
  }
}
