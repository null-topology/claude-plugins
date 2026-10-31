/**
 * The MCP tools `accounts`, `fields`, `issue_tickets` and `release`, and the
 * server that lists them with the usage contract as its instructions.
 *
 * Several sessions run at once; each has its own server process and the
 * broker is shared. The session and the agent a call belongs to are the
 * `session_id` and `agent_id` the plugin's PreToolUse hook writes into the
 * call's input: the server's own environment keeps the id it started with,
 * which is stale after `/clear`, and cannot tell agents apart.
 *
 * Tickets live in the broker; this server keeps no state. No answer and no
 * error message carries a value.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { isSessionId } from '../paths.ts';
import { MAX_TICKETS, type AgentRef, type FieldMeta, type ReleaseResult, type Request, type Response } from '../protocol.ts';
import { sessionTitle } from '../store/title.ts';
import { PROTOCOL_VERSION, VERSION } from '../version.ts';
import {
  AccountError,
  knownAccounts,
  NO_ACCOUNT_HINT,
  parseConfigured,
  resolveAccount,
  type Account,
  type OpListing,
} from './accounts.ts';
import { BrokerError, request, type RequestOptions } from './broker-client.ts';

export const TOOL_NAMES = ['accounts', 'fields', 'issue_tickets', 'release'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** How long `accounts` waits for the broker's `status`. */
export const STATUS_TIMEOUT_MS = 2000;

export interface ToolDeps {
  readonly stateDir: string;
  /** The `accounts` option (`OP_BRIDGE_ACCOUNTS`). */
  readonly accountsSetting: string | undefined;
  listOpAccounts(): Promise<OpListing>;
  readonly broker: RequestOptions;
}

export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

export interface Tools {
  call(name: string, args: unknown): Promise<ToolResult>;
}

const HOOK_SET = "Set by the plugin's hook; leave unset";

const hookFields = {
  session_id: z.string().optional().describe(HOOK_SET),
  transcript_path: z.string().optional().describe(HOOK_SET),
  agent_id: z.string().optional().describe(HOOK_SET),
  agent_type: z.string().optional().describe(HOOK_SET),
  cwd: z.string().optional().describe(HOOK_SET),
};

const accountArg = z
  .string()
  .optional()
  .describe('The account: a UUID, sign-in URL, email or configured name from `accounts`. Optional when only one account is known.');

/** The longest `issue_tickets` reason (spec §5); checked here only, the broker does not. */
export const MAX_REASON_LENGTH = 500;

const SCHEMAS = {
  accounts: z.object({}),
  fields: z.object({
    ref: z.string().min(1).describe('The item: op://<vault>/<item>, each segment a title or an id.'),
    account: accountArg,
    ...hookFields,
  }),
  issue_tickets: z.object({
    ref: z
      .string()
      .min(1)
      .describe('The field: op://<vault>/<item>/[<section>/]<field>, optionally ?attribute=otp|public-key|fingerprint|private-key. `fields` lists ready references.'),
    reason: z
      .string()
      .regex(/\S/, 'must not be blank')
      .max(MAX_REASON_LENGTH, `must be at most ${MAX_REASON_LENGTH} characters`)
      .describe(`Why the value is needed, shown to the user in the approval window of every redeem. Be concrete; at most ${MAX_REASON_LENGTH} characters.`),
    count: z.number().int().min(1).max(MAX_TICKETS).default(1).describe(`How many one-use tickets to issue (1-${MAX_TICKETS}).`),
    account: accountArg,
    ...hookFields,
  }),
  release: z.object({
    tickets: z.array(z.string()).min(1).describe('The ticket ids to release, as issue_tickets returned them.'),
    ...hookFields,
  }),
} as const;

const DESCRIPTIONS: Record<ToolName, string> = {
  accounts:
    'List the 1Password accounts this plugin can address and which ones the broker has already authorized (warm). Shows no secrets and opens no window.',
  fields:
    'List the fields of a 1Password item: titles, sections, types, whether a value is masked in Bash output, and a reference to pass to issue_tickets. Shows no values and opens no window.',
  issue_tickets:
    'Issue one-use tickets for one 1Password field. Returns ticket ids and their expiry, never a value, and opens no window. A ticket belongs to the calling agent, is valid for 10 minutes and serves one use: put "$(op-bridge redeem <ticket>)" inside the command that needs the value, and the user approves that use in a window that shows the command. ' +
    `The reason is shown in that window and is at most ${MAX_REASON_LENGTH} characters; a longer one is refused and no ticket is issued.`,
  release:
    'Release tickets: an unused ticket is voided, a used ticket\'s mask is dropped at once. A value delivered by several tickets stays masked until all of them are released. A ticket whose value is on its way to a running command ends used or voided and no longer masks that command\'s output, though another ticket of this session may still mask the same value. unmasked: at least one value the ticket held is no longer masked by any ticket, and copies of it written earlier to files or logs show it in plain text. mask_kept: every value the ticket held stays masked under another ticket of this session.',
};

const READ_ONLY: ReadonlySet<ToolName> = new Set(['accounts', 'fields']);

export const INSTRUCTIONS = [
  '1password-bridge hands the value of a 1Password field to one approved command at a time and masks secret values in Bash output. The masking is a safety net against accidental exposure, not a barrier: deliberate evasion is out of scope, so never try to get around it.',
  '',
  `- Find a field with fields (no values, no window). Then call issue_tickets with its ref and a concrete reason of at most ${MAX_REASON_LENGTH} characters. It returns ticket ids, never a value, and opens no window. A ticket belongs to the agent that issued it, is valid for 10 minutes and serves one use.`,
  '- Use "$(op-bridge redeem <ticket>)" inside the command that needs the value, for example TOKEN="$(op-bridge redeem tkt_…)" && curl -H "Authorization: Bearer $TOKEN" …. The user approves that use in a window that shows the command. The value is printed once to the command\'s stdout, and the plugin stores it nowhere.',
  '- Never echo, print, decode, encode or copy the value, and never write it to a file, a log or a message.',
  '- A command that contains "$(op-bridge redeem …)" cannot be matched by prefix allow rules, so it may need the user\'s approval in default mode, besides the redeem window.',
  '- Do not hand ticket ids to other agents: their redeem is refused. A subagent issues its own tickets.',
  '- A redeem waits while another agent of this session is running a command, and fails with other_agent after 30 s; retry when that agent is done. A redeem that fails with expired, used, voided or unknown needs a new ticket.',
  '- Secret values show as <masked ticket=tkt_…> in Bash output. A secret shorter than 8 characters is delivered but not masked.',
  '- Output of other tools (Read, Grep, MCP tools, Monitor and others) is not masked: use a value only inside Bash commands, do not open a file that may hold a value with another tool, and do not watch a command whose output can contain a value.',
  '- Do not print a value in a command that runs in the background (run_in_background, or moved there by the timeout): its output is read later through another tool and is not masked.',
  '- While a masked value exists in this session, a failed shell command normally ends with a line [exit N] and is reported as a success; read that line before treating a command as successful. A command that sets its own EXIT trap, uses exec, or whose shell is killed by a signal fails as usual, and its output is not masked.',
  '- Do not set an EXIT trap (trap … EXIT) and do not use exec in a command that redeems a ticket.',
  '- When a mask gets in the way, call release with the ticket ids. A used ticket\'s mask is dropped at once, but a value delivered by several tickets stays masked until all of them are released. Release answers unmasked when at least one value the ticket held is no longer masked by any ticket (copies written earlier to files or logs then show it in plain text), mask_kept when every value it held stays masked under another ticket of this session.',
  '- If a warning says a value appeared unmasked, tell the user.',
].join('\n');

/** A refusal with a code; the answer is `<code>: <message>`. */
class ToolFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function parse<S extends z.ZodType>(schema: S, args: unknown): z.output<S> {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue === undefined || issue.path.length === 0 ? 'arguments' : issue.path.join('.');
  throw new ToolFailure('invalid_arguments', `${field}: ${issue?.message ?? 'invalid'}`);
}

const NO_HOOK = "The plugin's PreToolUse hook sets it; check that the 1password-bridge hooks are enabled, then restart Claude Code.";

function liveSession(id: string | undefined): string {
  if (id === undefined || !isSessionId(id)) throw new ToolFailure('no_session', `No session id reached the server. ${NO_HOOK}`);
  return id;
}

function liveAgent(id: string | undefined, type: string | undefined): AgentRef {
  if (id === undefined || id === '') throw new ToolFailure('no_session', `No agent id reached the server. ${NO_HOOK}`);
  return type === undefined || type === '' ? { id } : { id, type };
}

function brokerFailure(response: Extract<Response, { ok: false }>): ToolFailure {
  return new ToolFailure(response.code, response.message);
}

/** The answer of a successful `issue_tickets`. */
export function ticketsText(r: Extract<Response, { op: 'issue_tickets' }>): string {
  const f = r.field;
  const masking = f.masked
    ? 'masked in Bash output as <masked ticket=…>'
    : f.short
      ? 'a secret shorter than 8 characters: NOT masked'
      : 'not a secret: NOT masked';
  const noun = r.tickets.length === 1 ? 'ticket' : 'tickets';
  return [
    `Issued ${r.tickets.length} ${noun} for "${f.field}" (${f.type}, ${masking}) of item "${f.item}" in vault "${f.vault}", valid until ${r.expiresAt}, one use each:`,
    ...r.tickets.map((t) => `- ${t}`),
    `Redeem one inside the command that needs the value, for example TOKEN="$(op-bridge redeem ${r.tickets[0] ?? '<ticket>'})" && … The user approves each redeem in a window that shows the command. Masking follows the value fetched at approve.`,
  ].join('\n');
}

const RELEASE_TEXT: Record<ReleaseResult['result'], string> = {
  voided: 'voided; it can no longer be redeemed',
  in_flight:
    "in flight; the value is on its way to the running command, the ticket will end used or voided, and it no longer masks that command's output; another ticket of this session may still mask the same value",
  unmasked:
    'mask dropped; at least one value this ticket held is no longer masked by any ticket, and copies of it written earlier to files or logs now show it in plain text',
  mask_kept: "this ticket's mask dropped; every value it held stays masked under another ticket of this session",
  final: 'not voided (already used, denied, expired or voided); it held no mask',
  unknown: 'not known to the broker (never issued, or the broker restarted); no mask is left for it',
  not_owner: 'belongs to another session; not released',
};

function fieldLine(itemRef: string, field: FieldMeta): string {
  const title = field.section === undefined ? field.title : `${field.section} / ${field.title}`;
  const path = field.sectionId === undefined || field.sectionId === '' ? field.id : `${field.sectionId}/${field.id}`;
  return `- ${title}: ${field.type}, ${field.masked ? 'masked' : 'not masked'}; ref ${itemRef}/${path}`;
}

function accountLine(account: Account, warm: ReadonlySet<string>): string {
  let line = `- ${account.label}: account ${account.id}, ${account.source === 'op' ? 'from op' : 'configured'}`;
  if (account.aliases.length > 0) line += `, also configured as ${account.aliases.join(', ')}`;
  if (warm.has(account.id)) line += '; warm';
  return line;
}

export function createTools(deps: ToolDeps): Tools {
  let known: { accounts: Account[]; listing: OpListing } | undefined;

  async function discover(): Promise<{ accounts: Account[]; listing: OpListing }> {
    const listing = await deps.listOpAccounts();
    known = { accounts: knownAccounts(listing.ok ? listing.accounts : [], parseConfigured(deps.accountsSetting)), listing };
    return known;
  }

  /** The account a call names; a cached list that does not resolve is refreshed once. */
  async function pickAccount(wanted: string | undefined): Promise<Account> {
    const cached = known;
    const current = cached ?? (await discover());
    try {
      return resolveAccount(current.accounts, wanted);
    } catch (err) {
      if (!(err instanceof AccountError) || cached === undefined) throw err;
      return resolveAccount((await discover()).accounts, wanted);
    }
  }

  async function ask(req: Request): Promise<Exclude<Response, { ok: false }>> {
    const response = await request(req, deps.broker);
    if (!response.ok) throw brokerFailure(response);
    return response;
  }

  async function accounts(): Promise<string> {
    const { accounts: list, listing } = await discover();
    let status: Extract<Response, { op: 'status' }> | undefined;
    try {
      const answer = await request({ v: PROTOCOL_VERSION, op: 'status' }, { ...deps.broker, timeoutMs: STATUS_TIMEOUT_MS });
      if (answer.ok && answer.op === 'status') status = answer;
    } catch (err) {
      if (!(err instanceof BrokerError)) throw err;
    }
    const warm = new Set((status?.accounts ?? []).filter((a) => a.warm).map((a) => a.account));
    const lines: string[] = [];
    if (list.length === 0) {
      lines.push(`No 1Password account is known. ${NO_ACCOUNT_HINT}`);
    } else {
      lines.push('1Password accounts (pass one as "account" to fields and issue_tickets; leave it out when only one is listed):');
      for (const account of list) lines.push(accountLine(account, warm));
      if (warm.size > 0) lines.push('Warm: the broker holds a connection the 1Password app already authorized.');
    }
    if (!listing.ok) {
      lines.push(
        listing.reason === 'missing'
          ? 'The op CLI is not installed, so only the configured accounts are listed.'
          : 'op account list failed, so only the configured accounts are listed.',
      );
    }
    lines.push(status === undefined ? 'Broker: not running (the first fields or issue_tickets starts it).' : `Broker: running; 1Password access idles out around ${status.exitsAt}.`);
    return lines.join('\n');
  }

  async function fields(args: unknown): Promise<string> {
    const input = parse(SCHEMAS.fields, args);
    const account = await pickAccount(input.account);
    const response = await ask({ v: PROTOCOL_VERSION, op: 'fields', account: account.id, ref: input.ref });
    if (response.op !== 'fields') throw new ToolFailure('internal', 'The broker answered another operation');
    const lines = [
      `Item "${response.item.title}" (${response.item.category}) in vault "${response.vault}". Values are not shown; pass a ref below to issue_tickets.`,
    ];
    if (response.fields.length === 0) lines.push('The item has no fields.');
    for (const field of response.fields) lines.push(fieldLine(input.ref, field));
    return lines.join('\n');
  }

  async function issueTickets(args: unknown): Promise<string> {
    const input = parse(SCHEMAS.issue_tickets, args);
    const id = liveSession(input.session_id);
    const agent = liveAgent(input.agent_id, input.agent_type);
    const account = await pickAccount(input.account);
    const title = sessionTitle(input.transcript_path);
    const response = await ask({
      v: PROTOCOL_VERSION,
      op: 'issue_tickets',
      account: account.id,
      accountLabel: account.label,
      ref: input.ref,
      reason: input.reason.trim(),
      count: input.count,
      session: title === undefined ? { id } : { id, title },
      agent,
    });
    if (response.op !== 'issue_tickets') throw new ToolFailure('internal', 'The broker answered another operation');
    return ticketsText(response);
  }

  async function release(args: unknown): Promise<string> {
    const input = parse(SCHEMAS.release, args);
    const id = liveSession(input.session_id);
    const tickets = [...new Set(input.tickets.map((t) => t.trim()).filter((t) => t !== ''))];
    if (tickets.length === 0) throw new ToolFailure('invalid_arguments', 'tickets: no ticket id given');
    const response = await ask({ v: PROTOCOL_VERSION, op: 'release', session: id, tickets });
    if (response.op !== 'release') throw new ToolFailure('internal', 'The broker answered another operation');
    return response.results.map((r) => `- ${r.ticket}: ${RELEASE_TEXT[r.result]}.`).join('\n');
  }

  const handlers: Record<ToolName, (args: unknown) => Promise<string>> = {
    accounts: () => accounts(),
    fields,
    issue_tickets: issueTickets,
    release,
  };

  return {
    async call(name, args) {
      const handler = Object.hasOwn(handlers, name) ? handlers[name as ToolName] : undefined;
      if (handler === undefined) return { isError: true, text: `unknown_tool: ${name}` };
      try {
        return { isError: false, text: await handler(args) };
      } catch (err) {
        if (err instanceof ToolFailure) return { isError: true, text: `${err.code}: ${err.message}` };
        if (err instanceof AccountError) return { isError: true, text: `account: ${err.message}` };
        if (err instanceof BrokerError) return { isError: true, text: `broker_${err.code}: ${err.message}` };
        // An unexpected error may come from anywhere; its message is not echoed.
        const kind = err instanceof Error ? err.name : typeof err;
        return { isError: true, text: `internal: the 1password-bridge server failed (${kind})` };
      }
    },
  };
}

function inputSchema(schema: z.ZodType): Tool['inputSchema'] {
  const json = z.toJSONSchema(schema, { io: 'input', target: 'draft-7' }) as Record<string, unknown>;
  return { ...json, type: 'object' };
}

export const TOOL_LIST: readonly Tool[] = TOOL_NAMES.map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  inputSchema: inputSchema(SCHEMAS[name]),
  annotations: { readOnlyHint: READ_ONLY.has(name) },
}));

/** The MCP server; construction does no I/O. */
export function createMcpServer(deps: ToolDeps): Server {
  const tools = createTools(deps);
  const server = new Server({ name: '1password-bridge', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...TOOL_LIST] }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;
    if (!(TOOL_NAMES as readonly string[]).includes(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool ${JSON.stringify(name)}`);
    }
    const result = await tools.call(name, req.params.arguments);
    return { content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) };
  });
  return server;
}
