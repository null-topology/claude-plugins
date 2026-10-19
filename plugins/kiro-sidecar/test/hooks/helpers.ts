import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { errorCode } from '../../src/store/files.ts';
import { hooksLogPath } from '../../src/hooks/log.ts';
import type { PollClock } from '../../src/hooks/turn.ts';

export const SESSION_ID = 'b6f0d2a4-5c1e-4f8e-9a3b-2d7c8e1f0a9b';
export const TOOL_USE_ID = 'toolu_01ABCdefGHIjklMNOpqrSTUv';
export const START_TOOL = 'mcp__plugin_kiro-sidecar_kiro__start';
export const SEND_TOOL = 'mcp__plugin_kiro-sidecar_kiro__send';

/** A clock that moves only when the code under test sleeps. */
export class FakeClock implements PollClock {
  time = Date.UTC(2026, 9, 18, 1, 0, 0);
  readonly sleeps: number[] = [];
  /** Called after each sleep with the number of sleeps so far. */
  onSleep: ((count: number) => Promise<void> | void) | undefined;

  readonly now = (): number => this.time;

  readonly sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.time += ms;
    await this.onSleep?.(this.sleeps.length);
  };

  get slept(): number {
    return this.sleeps.reduce((total, ms) => total + ms, 0);
  }
}

/** A start or send reply as the server renders it: JSON fields, then the trailer when given. */
export function replyText(trailer: string | null, fields: object = { state: 'running' }): string {
  const lines = [JSON.stringify(fields, null, 2)];
  if (trailer !== null) {
    lines.push(trailer);
  }
  return lines.join('\n');
}

/** A PostToolUse input of an MCP call, with its reply as one text block. */
export function postToolUse(
  reply: string | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: SESSION_ID,
    transcript_path: `/home/user/.claude/projects/-work-app/${SESSION_ID}.jsonl`,
    cwd: '/work/app',
    hook_event_name: 'PostToolUse',
    tool_name: START_TOOL,
    tool_input: { prompt: 'Review the parser module' },
    tool_use_id: TOOL_USE_ID,
    tool_response: reply === null ? [] : [{ type: 'text', text: reply }],
    duration_ms: 1234,
    mcp_server: { name: 'kiro', source: 'plugin' },
    ...overrides,
  };
}

export function inputStream(value: unknown): Readable {
  return Readable.from([Buffer.from(JSON.stringify(value), 'utf8')]);
}

/** The parsed lines of `$STATE/hooks.log`; empty when there is none. */
export async function hookLogLines(stateDir: string): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await readFile(hooksLogPath(stateDir), 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The files under `dir` whose path or content holds `text`, relative to `dir` and sorted. */
export async function filesHolding(dir: string, text: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      if (relative(dir, path).includes(text) || (await readFile(path, 'utf8')).includes(text)) {
        found.push(relative(dir, path));
      }
    }
  }
  return found.sort();
}
