/**
 * The approval window: a native panel on macOS (JXA, `dialog/macos-window.js`),
 * a zenity question on Linux, nothing elsewhere.
 *
 * An Approval holds metadata only (session, agent, account, vault, item,
 * field, type, ticket id, the reason and the commands the redeem was
 * attributed to), never a field value, so the command line of the window
 * process carries no secret. One window shows at a time; a window has no
 * timeout and closes when its ask is cancelled, and a cancelled queued ask
 * leaves the queue without a window.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { typeLabel, type Kind } from '../classify.ts';
import { strings } from '../strings.ts';
import type { AttributedCommand } from './attribution.ts';

export interface ApprovalCommand {
  /** The first line, up to 100 characters; `…` marks a cut. */
  short: string;
  full: string;
  cwd: string;
  /** The command names the ticket id. */
  literal: boolean;
}

export interface Approval {
  title: string;
  reason: string;
  rows: [label: string, value: string, mono?: boolean][];
  commands: ApprovalCommand[];
  labels: { command: string; literal: string; expand: string };
  /** Button labels. */
  approve: string;
  deny: string;
}

export type Answer = 'approve' | 'deny' | 'unavailable' | 'cancelled';

export interface Dialog {
  /** Shows `a` once the windows before it are done; an abort of `signal` closes it, or drops it from the queue, and answers `cancelled`. */
  ask(a: Approval, signal?: AbortSignal): Promise<Answer>;
  /**
   * Stops showing windows for good: the open window's process is killed, and
   * every queued or later `ask` answers `unavailable` without starting one. A
   * broker that stops serving calls it, so no window outlives the broker that
   * would act on its answer.
   */
  close(): void;
}

/** How a command ended: its exit code and stdout, not installed, killed at the timeout, or otherwise failed. */
export type RunResult = { kind: 'exit'; code: number; stdout: string } | { kind: 'missing' } | { kind: 'timeout' } | { kind: 'error' };

/** Runs a command, killed at `timeoutMs` when given; an abort of `signal` kills it at once (or starts nothing) and answers `error`. */
export type Runner = (command: string, args: string[], timeoutMs: number | undefined, signal?: AbortSignal) => Promise<RunResult>;

const MAX_STDOUT_BYTES = 64 * 1024;

export const COMMAND_PREVIEW_CHARS = 100;
export const ZENITY_COMMAND_LINES = 40;

/** A command collapsed to its first line, up to 100 characters; `…` marks anything left out. */
export function commandPreview(command: string): string {
  const lines = command.split('\n');
  const first = Array.from(lines[0] ?? '');
  const cut = first.length > COMMAND_PREVIEW_CHARS;
  const shown = cut ? first.slice(0, COMMAND_PREVIEW_CHARS).join('') : first.join('');
  return cut || lines.length > 1 ? `${shown}…` : shown;
}

/** `text` cut to `max` lines, a last line `…` marking the cut. */
export function cappedLines(text: string, max: number = ZENITY_COMMAND_LINES): string {
  const lines = text.split('\n');
  return lines.length <= max ? text : [...lines.slice(0, max), '…'].join('\n');
}

/** Which text of the window `shownText` prepares; each keeps different whitespace. */
export type ShownField = 'reason' | 'command' | 'cwd' | 'line';

const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const LINE_BREAKS = /\r\n|[\r\n\u{2028}\u{2029}]/gu;

/**
 * `text` as the window shows it, so it can neither draw lines of its own nor hide or reorder
 * characters: every control, format (bidi, zero-width, BOM), line or paragraph separator
 * character becomes a visible `\u{XXXX}`. A command keeps its LF and TAB, a cwd its TAB, a
 * one-line field (the agent) none; a reason first turns each line break and TAB into one space.
 */
export function shownText(text: string, field: ShownField): string {
  const flat = field === 'reason' ? text.replace(LINE_BREAKS, ' ').replace(/\t/g, ' ') : text;
  const keep = field === 'command' ? '\n\t' : field === 'cwd' ? '\t' : '';
  return flat.replace(HIDDEN_CHARS, (c) =>
    keep.includes(c) ? c : `\\u{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}}`,
  );
}

/** Runs `command` without a shell; stderr is discarded, so nothing it prints reaches a log. */
export const runCommand: Runner = (command, args, timeoutMs, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve({ kind: 'error' });
      return;
    }
    let settled = false;
    let timedOut = false;
    let stdout = '';
    const settle = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs);
    // SIGKILL is sent before this returns, so the window is gone even if the broker exits right after.
    const onAbort = (): void => {
      child.kill('SIGKILL');
      settle({ kind: 'error' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk;
    });
    child.on('error', (err: NodeJS.ErrnoException) => settle(err.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error' }));
    child.on('close', (code) => {
      if (timedOut) settle({ kind: 'timeout' });
      else if (code !== null) settle({ kind: 'exit', code, stdout });
      else settle({ kind: 'error' });
    });
  });

/** `s` safe inside Pango markup. */
export function pangoEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** zenity reads `--text` through `g_strcompress`, so a backslash must be doubled to stay one. */
function zenityEscape(s: string): string {
  return pangoEscape(s).replace(/\\/g, '\\\\');
}

function zenityText(a: Approval): string {
  const rows = a.rows.map(([label, value, mono]) => {
    const shown = zenityEscape(value);
    return `<b>${zenityEscape(label)}</b>  ${mono === true ? `<tt>${shown}</tt>` : shown}`;
  });
  const commands = a.commands.map((c) => {
    const heading = zenityEscape(c.literal ? a.labels.literal : a.labels.command);
    return `<b>${heading}</b>  ${zenityEscape(c.cwd)}\n<tt>${zenityEscape(cappedLines(c.full))}</tt>`;
  });
  return [rows.join('\n'), zenityEscape(a.reason), ...commands].join('\n\n');
}

async function askMac(run: Runner, pluginRoot: string, a: Approval, signal: AbortSignal): Promise<Answer> {
  const script = join(pluginRoot, 'dialog', 'macos-window.js');
  const result = await run('osascript', ['-l', 'JavaScript', script, JSON.stringify(a)], undefined, signal);
  if (result.kind === 'exit' && result.code === 0) {
    const answer = result.stdout.trim();
    if (answer === 'approve' || answer === 'deny') return answer;
  }
  // The window did not come up or did not answer: no backend, no GUI session, a script error.
  return 'unavailable';
}

async function askZenity(run: Runner, a: Approval, signal: AbortSignal): Promise<Answer> {
  const args = ['--question', `--title=${a.title}`, `--text=${zenityText(a)}`, `--ok-label=${a.approve}`, `--cancel-label=${a.deny}`, '--width=520'];
  const result = await run('zenity', args, undefined, signal);
  // zenity exits 1 for the deny button, Escape and closing the window alike. Any other end (another
  // code, a failure, a kill by a signal) is no answer, and only an answer may burn the ticket.
  if (result.kind === 'exit' && result.code === 0) return 'approve';
  if (result.kind === 'exit' && result.code === 1) return 'deny';
  return 'unavailable';
}

/** The approval window of `platform`; windows are shown one at a time until `close`. */
export function platformDialog(run: Runner, platform: NodeJS.Platform, pluginRoot: string): Dialog {
  const closing = new AbortController();
  const show = (a: Approval, signal: AbortSignal): Promise<Answer> => {
    if (signal.aborted) return Promise.resolve('unavailable');
    if (platform === 'darwin') return askMac(run, pluginRoot, a, signal);
    if (platform === 'linux') return askZenity(run, a, signal);
    return Promise.resolve('unavailable');
  };
  let tail: Promise<unknown> = Promise.resolve();
  return {
    ask(a, signal) {
      if (closing.signal.aborted) return Promise.resolve('unavailable');
      if (signal?.aborted === true) return Promise.resolve('cancelled');
      const both = signal === undefined ? closing.signal : AbortSignal.any([closing.signal, signal]);
      // A window killed by `close` answers `unavailable`, one killed by its own signal `cancelled`, whatever its process reported.
      const settle = (result: Answer): Answer => (closing.signal.aborted ? 'unavailable' : signal?.aborted === true ? 'cancelled' : result);
      const answer = tail
        .then((): Answer | Promise<Answer> => (both.aborted ? 'cancelled' : show(a, both)))
        .then(settle)
        .catch((): Answer => 'unavailable');
      tail = answer;
      if (signal === undefined) return answer;
      // A queued ask that is cancelled answers now; its turn in the queue then starts nothing.
      let onAbort = (): void => {};
      const cancelled = new Promise<Answer>((resolve) => {
        onAbort = () => resolve(settle('cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      // Once either side wins, the caller's signal keeps no listener of this ask.
      return Promise.race([answer, cancelled]).finally(() => signal.removeEventListener('abort', onAbort));
    },
    close() {
      closing.abort();
    },
  };
}

export interface TicketApprovalDetails {
  session: { id: string; title?: string | undefined; startDir?: string | undefined };
  agent: { id: string; type?: string | undefined };
  /** The account label shown to the user. */
  account: string;
  vault: string;
  item: string;
  category: string;
  /** The section title; undefined for an untitled section or none. */
  section?: string | undefined;
  field: string;
  /** The type shown before the mask note, such as `Concealed` or `Totp (otp)`. */
  fieldType: string;
  kind: Kind;
  ticket: string;
  reason: string;
  commands: readonly AttributedCommand[];
}

/** The window for one `redeem`, labelled in `lang`; the reason, commands, directories and agent go through `shownText`. */
export function ticketApproval(d: TicketApprovalDetails, lang: string | undefined): Approval {
  const t = strings(lang);
  const rows: Approval['rows'] = [];
  if (d.session.title !== undefined && d.session.title !== '') rows.push([t.session, d.session.title]);
  rows.push([t.sessionId, d.session.id, true]);
  rows.push([t.agent, d.agent.id === 'main' ? 'main' : shownText(`subagent · ${d.agent.type ?? d.agent.id}`, 'line')]);
  if (d.session.startDir !== undefined && d.session.startDir !== '') rows.push([t.startDir, shownText(d.session.startDir, 'cwd'), true]);
  rows.push([t.account, d.account]);
  rows.push([t.vault, d.vault]);
  rows.push([t.item, `${d.item} · ${d.category}`]);
  if (d.section !== undefined && d.section !== '') rows.push([t.section, d.section]);
  rows.push([t.field, d.field]);
  rows.push([t.type, typeLabel(d.fieldType, d.kind, lang)]);
  rows.push([t.ticket, d.ticket, true]);
  return {
    title: t.windowTitle,
    reason: shownText(d.reason, 'reason'),
    rows,
    commands: d.commands.map((c) => {
      const command = shownText(c.command, 'command');
      return { short: commandPreview(command), full: command, cwd: shownText(c.cwd, 'cwd'), literal: c.literal };
    }),
    labels: { command: t.command, literal: t.commandLiteral, expand: t.expand },
    approve: t.approve,
    deny: t.deny,
  };
}
