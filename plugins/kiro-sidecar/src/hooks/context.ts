/**
 * The SessionStart hook in the Claude process that already owns sessions:
 * after a clear, a resume, a fork or a compaction the new conversation is
 * told which Kiro sessions this process owns.
 *
 * 1. The input is read from stdin; it needs a `session_id` matching the id
 *    pattern and a `source` such as `clear`. Anything else is one
 *    `hooks.log` line and no output, and so is a `session_id` or a `source`
 *    the secret set, built before anything is written, would redact.
 * 2. The owner key is that of the hook's own parent, the Claude process.
 * 3. The own live sessions are the runs with that owner key, a live state
 *    (`starting`, `idle` or `running`, after a dead driver turns `idle` or
 *    `running` into `lost`) and a driver that is alive on this host.
 * 4. The new session id is appended to each one's `claude-sessions.jsonl`,
 *    with the source as the event.
 * 5. The output is one JSON object whose `additionalContext` lists them, one
 *    line each, then one line on how to read and continue:
 *
 *      [kiro-sidecar] Live Kiro sessions owned by this Claude process: <n>.
 *      - "<label>" (<launchId>, Kiro <id>): dir <dir>, mode <mode>, state <state>, current turn <t> (<delivery>).
 *      Read a turn with wait {session, turn}; continue a session with send {session, text}.
 *
 *    The delivery of the current turn is `pushed to session <id>` (a
 *    `.pushed` marker), `returned by a tool` (a `.returned` marker),
 *    `running` (no result yet, the run `starting` or `running`), `no result`
 *    (none while the run is in another state: its result was not written;
 *    also one `hooks.log` line) or `not delivered` (a result and no marker,
 *    also one with `endedBy`: it is not pushed and may be in no reply),
 *    checked in that order. An
 *    absent value leaves its part out, as in the wake message: no label, no
 *    Kiro id, no current turn before the first one, no delivery when the
 *    result cannot be read. Every value is redacted, put on one line, cut
 *    and neutralised as a wake message header value is.
 *
 * The text is at most `CONTEXT_MAX_CHARS` long: the newest sessions (the runs
 * created last) that fit are kept whole, still listed oldest first, and a
 * line before the last one says how many more there are and that `list`
 * shows them.
 *
 * No own live session: no output. Nothing here waits or polls, and nothing
 * throws: an unexpected error is an `internal` line with its code only.
 */

import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { isoSeconds } from '../session/claims.ts';
import { isLiveState, scanVisibleRuns } from '../session/resolve.ts';
import type { VisibleRun } from '../session/resolve.ts';
import { parseTurnResult } from '../session/turn-result.ts';
import type { LiveRegistry } from '../session/types.ts';
import type { Environment } from '../settings.ts';
import { errorCode, readJsonIfExists } from '../store/files.ts';
import { currentOwner, liveness, ownerKey } from '../store/identity.ts';
import type { ProcessIdentity } from '../store/identity.ts';
import { turnPaths } from '../store/paths.ts';
import { appendClaudeSession, readTurnResult } from '../store/runs.ts';
import type { RunMeta, RunState } from '../store/runs.ts';
import { headerValue } from '../text/field.ts';
import { SecretSet } from '../text/redact.ts';
import { ID_PATTERN, readHookInput } from './input.ts';
import { appendHookLog } from './log.ts';
import type { HookLogIds, HookStep } from './log.ts';
import { redactionChanges, waiterSecrets } from './waiter-loop.ts';
import { present } from './wake.ts';
import type { Redactor } from './wake.ts';

/** The `additionalContext` text is at most this many characters long. */
export const CONTEXT_MAX_CHARS = 2_000;

export const CONTEXT_HOW_TO =
  'Read a turn with wait {session, turn}; continue a session with send {session, text}.';

/** SessionStart sources such as `clear`, `resume`, `fork` or `compact`. */
const SOURCE_PATTERN = /^[a-z][a-z_-]{0,31}$/;

/** Only own runs are kept, and the live registry is the server's: the hook has none. */
const NO_LIVE_SESSIONS: LiveRegistry = { get: () => undefined, list: () => [] };

export interface SessionStartInput {
  readonly sessionId: string;
  readonly source: string;
}

export type ParsedSessionStart =
  | { readonly kind: 'input'; readonly input: SessionStartInput }
  | { readonly kind: 'skip'; readonly reason: 'input-invalid' };

/** Skips unless the input is an object with a valid `session_id` and `source`. */
export function parseSessionStartInput(value: unknown): ParsedSessionStart {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'skip', reason: 'input-invalid' };
  }
  const { session_id: sessionId, source } = value as Record<string, unknown>;
  if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
    return { kind: 'skip', reason: 'input-invalid' };
  }
  if (typeof source !== 'string' || !SOURCE_PATTERN.test(source)) {
    return { kind: 'skip', reason: 'input-invalid' };
  }
  return { kind: 'input', input: { sessionId, source } };
}

/** The own live runs, oldest first: owner key matched, live state, driver alive here. */
export async function ownLiveRuns(stateDir: string, owner: string): Promise<VisibleRun[]> {
  const runs = await scanVisibleRuns({ stateDir, home: '', owner, live: NO_LIVE_SESSIONS });
  const own = runs.filter((run) => run.relation === 'own' && isLiveState(run.state));
  const alive = await Promise.all(own.map(async (run) => (await liveness(run.meta.driver)) === 'alive'));
  return own.filter((_, index) => alive[index] === true);
}

export type Delivery =
  | { readonly kind: 'pushed'; readonly sessionId: string | null }
  | { readonly kind: 'returned' }
  | { readonly kind: 'running' }
  /** No result while the run is neither starting nor running: it will not come. */
  | { readonly kind: 'no-result' }
  | { readonly kind: 'not-delivered' };

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** The session id in a `.pushed` marker: undefined without the marker, null when it names none. */
async function pushedTo(path: string): Promise<string | null | undefined> {
  let value: unknown;
  try {
    value = await readJsonIfExists(path);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
  if (value === undefined) {
    return undefined;
  }
  const id = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).sessionId : undefined;
  return typeof id === 'string' && ID_PATTERN.test(id) ? id : null;
}

/** Where the turn's result went; throws when a marker or the result cannot be read. */
export async function turnDelivery(
  stateDir: string,
  launchId: string,
  turn: number,
  state: RunState,
): Promise<Delivery> {
  const paths = turnPaths(stateDir, launchId, turn);
  const pushed = await pushedTo(paths.pushed);
  if (pushed !== undefined) {
    return { kind: 'pushed', sessionId: pushed };
  }
  if (await fileExists(paths.returned)) {
    return { kind: 'returned' };
  }
  const value = await readTurnResult(stateDir, launchId, turn);
  if (value === undefined) {
    return state === 'running' || state === 'starting' ? { kind: 'running' } : { kind: 'no-result' };
  }
  // Parsed only to throw on an invalid result; with `endedBy` too it is not delivered.
  parseTurnResult(value, launchId, turn);
  return { kind: 'not-delivered' };
}

export interface ContextSession {
  readonly meta: RunMeta;
  readonly state: RunState;
  /** The current turn's delivery; null when the run has no turn yet or it could not be read. */
  readonly delivery: Delivery | null;
}

function deliveryText(delivery: Delivery, secrets: Redactor): string {
  switch (delivery.kind) {
    case 'pushed':
      return delivery.sessionId === null
        ? 'pushed to a session'
        : `pushed to session ${headerValue(delivery.sessionId, secrets)}`;
    case 'returned':
      return 'returned by a tool';
    case 'running':
      return 'running';
    case 'no-result':
      return 'no result';
    case 'not-delivered':
      return 'not delivered';
  }
}

/** One `- <name>: <facts>.` line, absent parts left out. */
export function sessionEntry(session: ContextSession, secrets: Redactor): string {
  const { meta } = session;
  const kiro = present(meta.kiroSessionId) ? `Kiro ${headerValue(meta.kiroSessionId, secrets)}` : null;
  const name = present(meta.label)
    ? `"${headerValue(meta.label, secrets)}" (${kiro === null ? meta.launchId : `${meta.launchId}, ${kiro}`})`
    : kiro === null
      ? meta.launchId
      : `${meta.launchId} (${kiro})`;
  const facts = [
    `dir ${headerValue(meta.dir, secrets)}`,
    `mode ${headerValue(meta.mode, secrets)}`,
    // Kiro called `complete_task`: never resumed or sent to (4.11).
    session.state === 'completed' ? 'state completed (completed by itself; start a new session)' : `state ${session.state}`,
  ];
  if (meta.currentTurn > 0) {
    const delivery = session.delivery === null ? '' : ` (${deliveryText(session.delivery, secrets)})`;
    facts.push(`current turn ${meta.currentTurn}${delivery}`);
  }
  return `- ${name}: ${facts.join(', ')}.`;
}

function moreLine(count: number): string {
  return `${count} more ${count === 1 ? 'session is' : 'sessions are'} not shown; list shows them.`;
}

/**
 * The `additionalContext` text; at most `CONTEXT_MAX_CHARS` long, with no line
 * break at its end. `sessions` come oldest first, as `ownLiveRuns` gives them;
 * past the limit the oldest entries give way, so the last ones are kept whole.
 */
export function buildContextText(sessions: readonly ContextSession[], secrets: Redactor): string {
  const header = `[kiro-sidecar] Live Kiro sessions owned by this Claude process: ${sessions.length}.`;
  const entries = sessions.map((session) => sessionEntry(session, secrets));
  const assemble = (kept: number): string =>
    [
      header,
      ...entries.slice(entries.length - kept),
      ...(kept < entries.length ? [moreLine(entries.length - kept)] : []),
      CONTEXT_HOW_TO,
    ].join('\n');
  let kept = entries.length;
  let text = assemble(kept);
  while (text.length > CONTEXT_MAX_CHARS && kept > 0) {
    kept -= 1;
    text = assemble(kept);
  }
  return text;
}

/** The hook's stdout: one JSON object carrying the text. */
export function contextOutput(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  });
}

export interface ContextHookOptions {
  readonly stdin: Readable;
  /** Null when no state directory could be resolved: then there is nothing to tell. */
  readonly stateDir: string | null;
  /** Read for the secret set; `process.env` when not given. */
  readonly env?: Environment;
  /** The Claude process; the hook's parent when not given. */
  readonly owner?: () => Promise<ProcessIdentity>;
  readonly secrets?: () => Redactor;
  readonly now?: () => Date;
}

/** Runs the hook; resolves to the stdout text, or null when nothing is to be written. Never rejects. */
export async function runContextHook(options: ContextHookOptions): Promise<string | null> {
  const { stateDir } = options;
  if (stateDir === null) {
    return null;
  }
  const now = options.now ?? (() => new Date());
  let ids: HookLogIds = {};
  let step: HookStep = 'input';
  const log = (logStep: HookStep, reason: string, error?: unknown, extra: HookLogIds = {}): Promise<void> =>
    appendHookLog(
      stateDir,
      { hook: 'context', step: logStep, reason, ...ids, ...extra, ...(error === undefined ? {} : { error }) },
      now(),
    );

  try {
    // Built before anything is written, as the session id is checked against it.
    let secrets: Redactor;
    try {
      secrets = (options.secrets ?? (() => waiterSecrets(options.env ?? process.env)))();
    } catch (error) {
      await log('input', 'secrets-invalid', error);
      secrets = new SecretSet();
    }
    const read = await readHookInput(options.stdin);
    if (read.kind === 'skip') {
      await log('input', read.reason, read.error);
      return null;
    }
    const parsed = parseSessionStartInput(read.value);
    if (parsed.kind === 'skip') {
      await log('input', parsed.reason);
      return null;
    }
    const { sessionId, source } = parsed.input;
    if (redactionChanges(secrets, [sessionId, source])) {
      // The line carries no ids.
      await log('input', 'input-secret');
      return null;
    }
    ids = { sessionId };

    step = 'owner';
    let owner: string;
    try {
      owner = ownerKey(await (options.owner ?? currentOwner)());
    } catch (error) {
      await log('owner', 'owner-unknown', error);
      return null;
    }

    step = 'session';
    const runs = await ownLiveRuns(stateDir, owner);
    if (runs.length === 0) {
      return null;
    }
    const at = isoSeconds(now());
    for (const run of runs) {
      try {
        await appendClaudeSession(stateDir, run.launchId, { id: sessionId, event: source, at });
      } catch (error) {
        // The sessions can still be listed without this line.
        await log('session', 'session-log-failed', error, { launchId: run.launchId });
      }
    }

    step = 'turn';
    const sessions: ContextSession[] = [];
    for (const run of runs) {
      const turn = run.meta.currentTurn;
      let delivery: Delivery | null = null;
      if (turn > 0) {
        try {
          delivery = await turnDelivery(stateDir, run.launchId, turn, run.state);
        } catch (error) {
          await log('turn', 'result-unreadable', error, { launchId: run.launchId, turn });
        }
        if (delivery?.kind === 'no-result') {
          await log('turn', 'result-missing', undefined, { launchId: run.launchId, turn });
        }
      }
      sessions.push({ meta: run.meta, state: run.state, delivery });
    }

    return contextOutput(buildContextText(sessions, secrets));
  } catch (error) {
    await log(step, 'internal', error);
    return null;
  }
}
