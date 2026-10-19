/**
 * The input schema of every tool: one zod schema per tool gives both the JSON
 * Schema listed by `tools/list` and the check of a call's arguments. Each
 * rule carries its own message, so a rejected argument is reported as
 * `E_INVALID <field> <rule>`; an unknown parameter is rejected too.
 */

import { z } from 'zod';
import { EFFORT_LEVELS } from '../session/manager.ts';
import { WAIT_TIMEOUT_MAX_S } from '../session/queries.ts';
import { InvalidInputError } from '../text/errors.ts';
import { PAGE_LIMIT_MAX } from '../text/limits.ts';

function text(description: string) {
  return z.string({ error: 'must be a string' }).describe(description);
}

function nonEmptyText(description: string) {
  return text(description).min(1, { error: 'must not be empty' });
}

function oneOf<const T extends readonly string[]>(values: T, description: string) {
  return z.enum(values, { error: `must be one of ${values.join(', ')}` }).describe(description);
}

function integer(min: number, max: number | null, description: string) {
  const rule = max === null ? `must be an integer of at least ${min}` : `must be an integer from ${min} to ${max}`;
  const value = z.int({ error: rule }).min(min, { error: rule });
  return (max === null ? value : value.max(max, { error: rule })).describe(description);
}

function flag(description: string) {
  return z.boolean({ error: 'must be true or false' }).describe(description);
}

function names(description: string) {
  return z.array(z.string({ error: 'must hold strings only' }), { error: 'must be an array of strings' }).describe(description);
}

const SESSION = 'A launch id (ks_...), a Kiro session id or a label.';

export const START_SCHEMA = z.strictObject({
  dir: nonEmptyText(
    'Absolute path of the work directory Kiro runs in. Docker mode: mounted at the same path; "path:ro" mounts it read-only.',
  ),
  mode: oneOf(['local', 'docker'], 'Where Kiro runs; default: the default_mode setting.').optional(),
  prompt: nonEmptyText('The first prompt; opens turn 1. Omit it to start an idle session.').optional(),
  prompt_file: nonEmptyText(
    'Instead of prompt: absolute path of a file with the first prompt, copied into the run. Docker mode: mounted read-only at /home/agent/task.md and Kiro is asked to read it.',
  ).optional(),
  label: text('A name for the session: 1-40 characters from A-Z, a-z, 0-9, ".", "_" and "-".').optional(),
  preset: text('Not available in this version.').optional(),
  home: text('Kiro home name; default: the home setting, else one home per startup directory.').optional(),
  model: text('Kiro model id; default: Kiro\'s default model.').optional(),
  effort: oneOf(EFFORT_LEVELS, 'Reasoning effort, when the model offers it.').optional(),
  skills: names(
    'Docker mode only in this version: Claude skill names ("name" or "plugin:name", never a path), each copied ' +
      'into the run so that Kiro sees it as a skill. A name is looked up in the project\'s .claude/skills, then ' +
      '~/.claude/skills, then the synced skills of the signed-in account, then the enabled plugins.',
  ).optional(),
  steering: names(
    'Docker mode only in this version: absolute paths of markdown (.md) files, each copied into the run as a ' +
      'Kiro steering file under its file name; the names must be unique and sidecar-protocol.md is reserved.',
  ).optional(),
  mounts: names('Docker mode only: absolute host paths, each mounted at the same path; "path:ro" mounts one read-only.').optional(),
  permissions: oneOf(
    ['allow', 'deny'],
    "How Kiro's permission requests are answered. allow (default) is the plugin's autopilot: every request " +
      'is approved at once and Claude is not asked; deny refuses them. Neither is a security boundary.',
  ).optional(),
  kiro_mode: text(
    'Kiro session mode (spec, plan, ...), checked against the modes Kiro offers. In plan Kiro has no tool ' +
      'channel: no messages, no completion.',
  ).optional(),
  image: text('Docker image; docker mode only.').optional(),
});

export const RESUME_SCHEMA = z.strictObject({
  session: nonEmptyText(SESSION),
});

export const SEND_SCHEMA = z.strictObject({
  session: nonEmptyText(SESSION),
  text: nonEmptyText('The next prompt; opens the next turn.'),
  interrupt: flag('End the running turn first and return its result; default false.').optional(),
});

export const WAIT_SCHEMA = z.strictObject({
  session: nonEmptyText(SESSION),
  turn: integer(1, null, 'Turn number; default: the latest turn.').optional(),
  timeout_s: integer(1, WAIT_TIMEOUT_MAX_S, 'How long to block on a running turn; default 600.').optional(),
  offset: integer(0, null, 'First character of the text page; default 0.').optional(),
  limit: integer(1, PAGE_LIMIT_MAX, 'Characters in the text page; default 20000.').optional(),
});

export const STATUS_SCHEMA = z.strictObject({
  session: nonEmptyText(`${SESSION} Omit it for every own session.`).optional(),
});

export const CANCEL_SCHEMA = z.strictObject({
  session: nonEmptyText(SESSION),
});

export const STOP_SCHEMA = z.strictObject({
  session: nonEmptyText(SESSION),
  purge: flag('Also delete the run directory; default false.').optional(),
});

export const LIST_SCHEMA = z.strictObject({
  history: flag('Also list the home\'s earlier sessions; default false.').optional(),
});

export type ToolSchema = z.ZodObject;

/** The JSON Schema of a tool's input, as `tools/list` shows it. */
export function inputJsonSchema(schema: ToolSchema): { type: 'object'; [key: string]: unknown } {
  const json = z.toJSONSchema(schema, { io: 'input', target: 'draft-7' }) as Record<string, unknown>;
  return { ...json, type: 'object' };
}

/**
 * Checks a call's arguments; throws `InvalidInputError` for the first
 * rejected one, naming its field.
 */
export function parseArgs<S extends ToolSchema>(schema: S, args: unknown): z.output<S> {
  const input = args ?? {};
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  if (issue === undefined) {
    throw new InvalidInputError('arguments', 'are not valid');
  }
  if (issue.code === 'unrecognized_keys') {
    throw new InvalidInputError(issue.keys[0] ?? 'arguments', 'is not a parameter of this tool');
  }
  const field = issue.path[0];
  if (field === undefined) {
    throw new InvalidInputError('arguments', 'must be an object');
  }
  const name = String(field);
  const given = typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[name] : undefined;
  if (issue.code === 'invalid_type' && given === undefined && issue.path.length === 1) {
    throw new InvalidInputError(name, 'is required');
  }
  throw new InvalidInputError(name, issue.message);
}
