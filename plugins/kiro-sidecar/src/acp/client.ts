/**
 * The ACP client for one Kiro process.
 *
 * It wraps the SDK's `ClientSideConnection` over the process's stdio and adds
 * what the session owner needs: per-step timeouts and abort signals, the
 * session id fallback, tracking of each session's config options and of the
 * MCP server statuses Kiro reports (`_kiro/mcp/status`), turn events, the
 * permission policy, and a single closed state. When the process exits or
 * the stream dies, every pending and later request fails at once with the same
 * `closed` error, and a child that is still running is killed.
 *
 * Agent requests other than `session/request_permission` (file system,
 * terminal, extension methods) are answered with method-not-found, and no file
 * system or terminal capability is advertised, so a turn never waits on them.
 */
import { Readable, Writable } from 'node:stream';
import {
  CLIENT_METHODS,
  ClientSideConnection,
  MessageTooLargeError,
  RequestError,
  ndJsonStream,
} from '@agentclientprotocol/sdk';
import type {
  AnyMessage,
  Client,
  CloseSessionResponse,
  ContentBlock,
  Implementation,
  InitializeResponse,
  LoadSessionResponse,
  McpServer,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
  SetSessionConfigOptionRequest,
  Stream,
} from '@agentclientprotocol/sdk';
import { SERVER_VERSION } from '../version.ts';
import { checkConfigValue } from './config.ts';
import type { ConfigValue } from './config.ts';
import { AcpClientError } from './errors.ts';
import type { CloseReason } from './errors.ts';
import { toTurnEvent } from './events.ts';
import type { LifecycleEntry, LifecycleSink, TurnEvent, TurnEventSink } from './events.ts';
import { CANCELLED_RESPONSE, choosePermission } from './permissions.ts';
import type { PermissionDecision } from './permissions.ts';
import type { ProcessExit, ProcessHandle } from './process.ts';

/** The ACP protocol version the client speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** How long to let stdout drain after the process exits before the stream is closed. */
export const DEFAULT_EXIT_DRAIN_MS = 200;

export const DEFAULT_CLIENT_INFO: Implementation = Object.freeze({ name: 'kiro-sidecar', version: SERVER_VERSION });

/** Decides a permission request; may be asynchronous. */
export type PermissionDecider = (
  request: RequestPermissionRequest,
) => PermissionDecision | Promise<PermissionDecision>;

export interface AcpClientOptions {
  /** Answers permission requests through the policy. Errors count as `deny`. */
  readonly decidePermission: PermissionDecider;
  readonly events?: TurnEventSink;
  readonly lifecycle?: LifecycleSink;
  /** Sends every frame, in both directions, to the lifecycle sink. */
  readonly debugFrames?: boolean;
  /** Incoming message size cap; the SDK default is 32 MiB. */
  readonly maxMessageBytes?: number;
  readonly clientInfo?: Implementation;
  readonly exitDrainMs?: number;
}

/** Per-step limits; a step that exceeds them rejects, the request is not withdrawn. */
export interface StepOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface SessionParams {
  readonly cwd: string;
  readonly mcpServers?: readonly McpServer[];
}

export interface NewSessionResult {
  readonly sessionId: string;
  readonly response: NewSessionResponse;
}

/** The notification in which Kiro reports the state of a session's MCP servers. */
export const MCP_STATUS_METHOD = '_kiro/mcp/status';

/** The status of one MCP server of a session, as Kiro last reported it. */
export interface McpServerStatus {
  readonly name: string;
  /** `connecting` and `connected` are measured; any other text is kept as sent. */
  readonly status: string;
  /** The names of the tools the server lists. */
  readonly tools: readonly string[];
}

interface OpenPermission {
  readonly sessionId: string;
  readonly turn: number | undefined;
  readonly withdraw: () => void;
}

export class KiroAcpClient {
  readonly #process: ProcessHandle;
  readonly #decidePermission: PermissionDecider;
  readonly #events: TurnEventSink | undefined;
  readonly #lifecycle: LifecycleSink | undefined;
  readonly #clientInfo: Implementation;
  readonly #exitDrainMs: number;
  readonly #config = new Map<string, readonly SessionConfigOption[]>();
  /** Where each session's stored config list came on the wire (#storeConfig). */
  readonly #configPositions = new Map<string, number>();
  /** Where the latest `config_option_update` of each session came on the wire. */
  readonly #configUpdatePositions = new Map<string, number>();
  /** Where each answer came on the wire, by its result object, which the SDK hands back as is. */
  readonly #answerPositions = new WeakMap<object, number>();
  /** How many frames have come from the agent. */
  #received = 0;
  readonly #loading = new Set<string>();
  readonly #turns = new Map<string, number>();
  readonly #open = new Set<OpenPermission>();
  /** The latest status of each MCP server, per session id, from any moment of the session. */
  readonly #mcpServers = new Map<string, Map<string, McpServerStatus>>();
  /** Called after every stored MCP status and config list, for the waits on them. */
  readonly #watchers = new Set<() => void>();
  readonly #closedPromise: Promise<AcpClientError>;
  readonly #closedRejection: Promise<never>;
  readonly #gate: TransformStreamDefaultController<Uint8Array>;
  readonly #connection: ClientSideConnection;
  #resolveClosed: (error: AcpClientError) => void = () => {};
  #rejectClosed: (error: AcpClientError) => void = () => {};
  #closed: AcpClientError | undefined;
  #nextTurn = 0;

  constructor(process: ProcessHandle, options: AcpClientOptions) {
    this.#process = process;
    this.#decidePermission = options.decidePermission;
    this.#events = options.events;
    this.#lifecycle = options.lifecycle;
    this.#clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.#exitDrainMs = options.exitDrainMs ?? DEFAULT_EXIT_DRAIN_MS;
    this.#closedPromise = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    this.#closedRejection = new Promise<never>((_resolve, reject) => {
      this.#rejectClosed = reject;
    });
    this.#closedRejection.catch(() => {});

    // stdout passes through a gate the client can error, so a dead process
    // closes the connection even when its stdout is held open by another process.
    let gate: TransformStreamDefaultController<Uint8Array> | undefined;
    const gated = new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        gate = controller;
      },
    });
    if (gate === undefined) {
      throw new Error('TransformStream did not start synchronously');
    }
    this.#gate = gate;
    const input = (Readable.toWeb(process.stdout) as ReadableStream<Uint8Array>).pipeThrough(gated);
    const output = Writable.toWeb(process.stdin) as WritableStream<Uint8Array>;
    const stream = watchIncoming(ndJsonStream(output, input, maxBytesOption(options.maxMessageBytes)), (message) =>
      this.#onFrame(message),
    );
    const tapped = options.debugFrames === true ? tapFrames(stream, (entry) => this.#log(entry)) : stream;

    this.#log({ event: 'start', pid: process.pid });
    this.#connection = new ClientSideConnection(() => this.#handlers(), tapped);
    const signal = this.#connection.signal;
    signal.addEventListener('abort', () => this.#onConnectionClosed(signal.reason), { once: true });
    void process.exited.then((exit) => this.#onExit(exit));
  }

  get pid(): number | undefined {
    return this.#process.pid;
  }

  /** The process exit, once it has ended. */
  get exited(): Promise<ProcessExit> {
    return this.#process.exited;
  }

  /** Resolves with the `closed` error once the connection is dead. */
  get closed(): Promise<AcpClientError> {
    return this.#closedPromise;
  }

  /** The `closed` error, once the connection is dead. */
  get closeError(): AcpClientError | undefined {
    return this.#closed;
  }

  /** Permission requests received and not yet answered. */
  get openPermissionRequests(): number {
    return this.#open.size;
  }

  /** The session's current config options, as last reported by the agent. */
  configOptions(sessionId: string): readonly SessionConfigOption[] | undefined {
    return this.#config.get(sessionId);
  }

  initialize(options: StepOptions = {}): Promise<InitializeResponse> {
    return this.#step('initialize', undefined, options, () =>
      this.#connection.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: this.#clientInfo,
      }),
    );
  }

  /** Creates a session. The id is `sessionId`, else `_meta.id`. */
  async newSession(params: SessionParams, options: StepOptions = {}): Promise<NewSessionResult> {
    const response = await this.#step('session/new', undefined, options, () =>
      this.#connection.newSession({ cwd: params.cwd, mcpServers: [...(params.mcpServers ?? [])] }),
    );
    const sessionId = sessionIdOf(response);
    if (sessionId === undefined) {
      throw new AcpClientError('protocol', 'session/new returned neither sessionId nor _meta.id');
    }
    this.#storeConfig(sessionId, response.configOptions, this.#answerPosition(response));
    return { sessionId, response };
  }

  /** Loads a session; the history it replays is reported with `replay: true`. */
  async loadSession(
    params: SessionParams & { readonly sessionId: string },
    options: StepOptions = {},
  ): Promise<LoadSessionResponse> {
    const { sessionId } = params;
    this.#loading.add(sessionId);
    try {
      const response = await this.#step('session/load', sessionId, options, () =>
        this.#connection.loadSession({
          sessionId,
          cwd: params.cwd,
          mcpServers: [...(params.mcpServers ?? [])],
        }),
      );
      this.#storeConfig(sessionId, response.configOptions, this.#answerPosition(response));
      return response;
    } finally {
      this.#loading.delete(sessionId);
    }
  }

  /** The latest status Kiro reported for a server of a session, if any. */
  mcpServerStatus(sessionId: string, name: string): McpServerStatus | undefined {
    return this.#mcpServers.get(sessionId)?.get(name);
  }

  /**
   * Resolves once the latest status of server `name` in the session is
   * `connected` and lists every tool in `tools`, which may already be so.
   * Every other status is waited through. Rejects like a step: `timeout`
   * after `timeoutMs`, `aborted` on the signal, `closed` when the client
   * closes. Sends nothing.
   */
  async waitForMcpServer(
    sessionId: string,
    name: string,
    tools: readonly string[],
    options: StepOptions = {},
  ): Promise<McpServerStatus> {
    return this.#waitUntil(
      `${name} server`,
      `the ${name} server was not connected within ${options.timeoutMs} ms`,
      () => {
        const status = this.mcpServerStatus(sessionId, name);
        return status !== undefined && status.status === 'connected' && tools.every((tool) => status.tools.includes(tool))
          ? status
          : undefined;
      },
      options,
    );
  }

  /**
   * Resolves with the session's config option `configId` once the agent
   * offers it, which may already be so: Kiro can answer `session/new` before
   * it offers `model` and add it in a `config_option_update`. Rejects like a
   * step: `timeout` after `timeoutMs`, `aborted` on the signal, `closed` when
   * the client closes. Sends nothing.
   */
  waitForConfigOption(sessionId: string, configId: string, options: StepOptions = {}): Promise<SessionConfigOption> {
    return this.waitForConfig(sessionId, `${configId} option`, (offered) => offered.find((option) => option.id === configId), options);
  }

  /**
   * Resolves with what `ready` returns for the session's config options once
   * it returns something other than `undefined`, which may already be so;
   * `ready` is asked again on every change. Rejects like
   * {@link waitForConfigOption}, the timeout naming `what`. Sends nothing.
   */
  waitForConfig<T>(
    sessionId: string,
    what: string,
    ready: (offered: readonly SessionConfigOption[]) => T | undefined,
    options: StepOptions = {},
  ): Promise<T> {
    return this.#waitUntil(
      what,
      `the ${what} was not offered within ${options.timeoutMs} ms`,
      () => ready(this.#config.get(sessionId) ?? []),
      options,
    );
  }

  /**
   * Sets a config option to a value the agent offers; rejects with
   * `invalid_config`, naming the offered values, before sending anything
   * otherwise. Resolves with the session's options after the change.
   */
  async setConfig(
    sessionId: string,
    configId: string,
    value: ConfigValue,
    options: StepOptions = {},
  ): Promise<readonly SessionConfigOption[]> {
    const option = checkConfigValue(this.#config.get(sessionId), configId, value);
    const request: SetSessionConfigOptionRequest =
      option.type === 'boolean' && typeof value === 'boolean'
        ? { sessionId, configId, type: 'boolean', value }
        : { sessionId, configId, value: String(value) };
    const response = await this.#step('session/set_config_option', sessionId, options, () =>
      this.#connection.setSessionConfigOption(request),
    );
    this.#storeConfig(sessionId, response.configOptions, this.#answerPosition(response));
    return this.#config.get(sessionId) ?? [];
  }

  /** Runs one turn; resolves with the agent's stop reason. */
  async prompt(
    sessionId: string,
    prompt: string | readonly ContentBlock[],
    options: StepOptions = {},
  ): Promise<PromptResponse> {
    const blocks: ContentBlock[] = typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : [...prompt];
    this.#nextTurn += 1;
    const turn = this.#nextTurn;
    this.#turns.set(sessionId, turn);
    try {
      return await this.#step('session/prompt', sessionId, options, () =>
        this.#connection.prompt({ sessionId, prompt: blocks }),
      );
    } finally {
      this.#withdraw(sessionId, turn);
      if (this.#turns.get(sessionId) === turn) {
        this.#turns.delete(sessionId);
      }
    }
  }

  /** Sends `session/cancel` and answers the session's open permission requests `cancelled`. */
  async cancel(sessionId: string): Promise<void> {
    if (this.#closed !== undefined) {
      throw this.#closed;
    }
    this.#log({ event: 'cancel', sessionId, openPermissions: this.#countOpen(sessionId) });
    try {
      await this.#connection.cancel({ sessionId });
    } catch (error) {
      throw await this.#closedErrorFor(error);
    } finally {
      this.#withdraw(sessionId);
    }
  }

  /** Sends `session/close`; the process stays alive for other sessions. */
  async closeSession(sessionId: string, options: StepOptions = {}): Promise<CloseSessionResponse> {
    const response = await this.#step('session/close', sessionId, options, () =>
      this.#connection.closeSession({ sessionId }),
    );
    this.#withdraw(sessionId);
    this.#config.delete(sessionId);
    this.#configPositions.delete(sessionId);
    this.#configUpdatePositions.delete(sessionId);
    this.#mcpServers.delete(sessionId);
    return response;
  }

  /** Closes the connection and kills the process (SIGTERM, then SIGKILL). */
  terminate(graceMs?: number): Promise<ProcessExit> {
    this.#close(new AcpClientError('closed', 'ACP client terminated', { closeReason: 'terminated' }), false);
    if (this.#process.exit === undefined) {
      this.#log({ event: 'kill', reason: 'terminated' });
    }
    return this.#process.kill(graceMs);
  }

  #handlers(): Client {
    return {
      requestPermission: (params) => this.#onPermission(params),
      sessionUpdate: (params) => this.#onUpdate(params),
      readTextFile: () => this.#refuse(CLIENT_METHODS.fs_read_text_file),
      writeTextFile: () => this.#refuse(CLIENT_METHODS.fs_write_text_file),
      createTerminal: () => this.#refuse(CLIENT_METHODS.terminal_create),
      terminalOutput: () => this.#refuse(CLIENT_METHODS.terminal_output),
      releaseTerminal: () => this.#refuse(CLIENT_METHODS.terminal_release),
      waitForTerminalExit: () => this.#refuse(CLIENT_METHODS.terminal_wait_for_exit),
      killTerminal: () => this.#refuse(CLIENT_METHODS.terminal_kill),
      extNotification: (method, params) => {
        this.#log({ event: 'notification', method, length: jsonLength(params) });
        if (method === MCP_STATUS_METHOD) {
          this.#onMcpStatus(params);
        }
      },
    };
  }

  /**
   * Keeps the latest status of each server a `_kiro/mcp/status` names, under
   * its session id. Kiro sends it before the `session/new` or `session/load`
   * answer too, so it is kept for any session id. A malformed entry is skipped.
   */
  #onMcpStatus(params: Record<string, unknown>): void {
    const { sessionId, servers } = params;
    if (typeof sessionId !== 'string' || !Array.isArray(servers)) {
      return;
    }
    let known = this.#mcpServers.get(sessionId);
    for (const server of servers) {
      const status = mcpServerStatusOf(server);
      if (status === undefined) {
        continue;
      }
      if (known === undefined) {
        known = new Map();
        this.#mcpServers.set(sessionId, known);
      }
      known.set(status.name, status);
      this.#log({ event: 'mcp_status', sessionId, server: status.name, status: status.status, tools: status.tools.length });
    }
    this.#notifyWatchers();
  }

  #refuse(method: string): never {
    this.#log({ event: 'agent_request', method, answer: 'method_not_found' });
    throw RequestError.methodNotFound(method);
  }

  #onUpdate(notification: SessionNotification): void {
    const { sessionId, update } = notification;
    this.#log({ event: 'update', sessionId, update: update.sessionUpdate, length: jsonLength(update) });
    if (update.sessionUpdate === 'config_option_update') {
      // Updates reach this handler in wire order, so the latest one numbered
      // for the session is this one or one stored right after it.
      this.#storeConfig(sessionId, update.configOptions, this.#configUpdatePositions.get(sessionId) ?? this.#received);
    }
    this.#emit(toTurnEvent(notification, this.#loading.has(sessionId)));
  }

  async #onPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const { sessionId } = request;
    const toolCallId = request.toolCall.toolCallId;
    const title = request.toolCall.title ?? undefined;
    this.#emit({ kind: 'permission_requested', sessionId, toolCallId, title });
    let withdraw: () => void = () => {};
    const withdrawn = new Promise<'withdrawn'>((resolve) => {
      withdraw = () => resolve('withdrawn');
    });
    const entry: OpenPermission = { sessionId, turn: this.#turns.get(sessionId), withdraw };
    this.#open.add(entry);
    if (this.#closed !== undefined) {
      withdraw();
    }
    try {
      const decided = await Promise.race([this.#decide(request), withdrawn]);
      const answer =
        decided === 'withdrawn'
          ? { response: CANCELLED_RESPONSE, decision: undefined, option: undefined, via: 'withdrawn' as const }
          : { ...choosePermission(request.options, decided), decision: decided };
      const outcome = answer.response.outcome.outcome;
      this.#emit({
        kind: 'permission_answered',
        sessionId,
        toolCallId,
        title,
        decision: answer.decision,
        outcome,
        optionId: answer.option?.optionId,
        optionKind: answer.option?.kind,
        via: answer.via,
      });
      this.#log({
        event: 'permission',
        sessionId,
        decision: answer.decision,
        outcome,
        optionKind: answer.option?.kind,
        via: answer.via,
      });
      return answer.response;
    } finally {
      this.#open.delete(entry);
    }
  }

  async #decide(request: RequestPermissionRequest): Promise<PermissionDecision> {
    try {
      const decision = await this.#decidePermission(request);
      if (decision === 'allow' || decision === 'deny') {
        return decision;
      }
      throw new TypeError(`decidePermission returned ${String(decision)}`);
    } catch (error) {
      this.#log({ event: 'error', where: 'decidePermission', error: describeError(error) });
      return 'deny';
    }
  }

  /** Answers open permission requests `cancelled`: a session's, or one turn's. */
  #withdraw(sessionId?: string, turn?: number): void {
    for (const entry of this.#open) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) {
        continue;
      }
      if (turn !== undefined && entry.turn !== turn) {
        continue;
      }
      entry.withdraw();
    }
  }

  #countOpen(sessionId: string): number {
    let count = 0;
    for (const entry of this.#open) {
      if (entry.sessionId === sessionId) {
        count += 1;
      }
    }
    return count;
  }

  async #step<T>(
    method: string,
    sessionId: string | undefined,
    options: StepOptions,
    run: () => Promise<T>,
  ): Promise<T> {
    if (this.#closed !== undefined) {
      throw this.#closed;
    }
    if (options.signal?.aborted === true) {
      throw abortedError(method, options.signal.reason);
    }
    this.#log(sessionId === undefined ? { event: 'request', method } : { event: 'request', method, sessionId });
    const started = performance.now();
    const { guards, dispose } = this.#guards(method, options, `${method} did not finish within ${options.timeoutMs} ms`);
    try {
      const result = await Promise.race([run(), ...guards]);
      // Updates that arrived before the response are dispatched through
      // promise chains; let them reach the sinks before the caller resumes.
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.#log({
        event: 'response',
        method,
        ms: elapsed(started),
        ok: true,
        ...stopReasonOf(result),
      });
      return result;
    } catch (error) {
      const failure = error instanceof AcpClientError ? error : await this.#closedErrorFor(error);
      this.#log({ event: 'response', method, ms: elapsed(started), ok: false, error: describeError(failure) });
      throw failure;
    } finally {
      dispose();
    }
  }

  /**
   * Resolves with what `ready` returns once it returns something: at once,
   * or after a stored MCP status or config list. Rejects like a step: `closed`,
   * `timeout` (with `timeoutText`) or `aborted` (naming `what`).
   */
  async #waitUntil<T>(what: string, timeoutText: string, ready: () => T | undefined, options: StepOptions): Promise<T> {
    if (this.#closed !== undefined) {
      throw this.#closed;
    }
    if (options.signal?.aborted === true) {
      throw abortedError(what, options.signal.reason);
    }
    const now = ready();
    if (now !== undefined) {
      return now;
    }
    let watcher: (() => void) | undefined;
    const reached = new Promise<T>((resolve) => {
      watcher = () => {
        const value = ready();
        if (value !== undefined) {
          resolve(value);
        }
      };
      this.#watchers.add(watcher);
    });
    const { guards, dispose } = this.#guards(what, options, timeoutText);
    try {
      return await Promise.race([reached, ...guards]);
    } finally {
      dispose();
      if (watcher !== undefined) {
        this.#watchers.delete(watcher);
      }
    }
  }

  /**
   * The promises that end a step early: the client closing, the timeout
   * (`timeout`, with `timeoutText`) and the abort (`aborted`, naming `what`).
   * `dispose` clears the timer and the abort listener.
   */
  #guards(
    what: string,
    options: StepOptions,
    timeoutText: string,
  ): { readonly guards: Promise<never>[]; readonly dispose: () => void } {
    const { timeoutMs, signal } = options;
    const guards: Promise<never>[] = [this.#closedRejection];
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    if (timeoutMs !== undefined) {
      guards.push(
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new AcpClientError('timeout', timeoutText)), timeoutMs);
        }),
      );
    }
    if (signal !== undefined) {
      guards.push(
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(abortedError(what, signal.reason));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      );
    }
    return {
      guards,
      dispose: () => {
        clearTimeout(timer);
        if (onAbort !== undefined) {
          signal?.removeEventListener('abort', onAbort);
        }
      },
    };
  }

  /**
   * An SDK rejection caused by the connection closing becomes the client's
   * `closed` error; an error the agent returned is passed through.
   */
  async #closedErrorFor(error: unknown): Promise<unknown> {
    if (this.#closed !== undefined) {
      return this.#closed;
    }
    if (this.#connection.signal.aborted) {
      return await this.#closedPromise;
    }
    return error;
  }

  #onExit(exit: ProcessExit): void {
    this.#log({
      event: 'exit',
      code: exit.code,
      signal: exit.signal,
      ...(exit.error === undefined ? {} : { error: describeError(exit.error) }),
    });
    if (this.#closed !== undefined) {
      return;
    }
    const stdout = this.#process.stdout;
    const drained = new Promise<void>((resolve) => {
      if (stdout.readableEnded || stdout.destroyed) {
        resolve();
        return;
      }
      stdout.once('end', () => resolve());
      stdout.once('close', () => resolve());
    });
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, this.#exitDrainMs));
    void Promise.race([drained, timeout]).then(() => {
      if (this.#closed === undefined) {
        this.#close(closedError('exited', undefined, exit), true);
      }
    });
  }

  #onConnectionClosed(reason: unknown): void {
    if (this.#closed !== undefined) {
      return;
    }
    if (reason instanceof AcpClientError) {
      this.#close(reason, true);
      return;
    }
    if (reason instanceof MessageTooLargeError) {
      this.#close(closedError('message_too_large', reason, this.#process.exit), true);
      return;
    }
    // stdout usually ends a moment before the exit event; give the exit a
    // short window so a process that ended is reported as exited.
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), this.#exitDrainMs));
    void Promise.race([this.#process.exited, timeout]).then((exit) => {
      if (this.#closed !== undefined) {
        return;
      }
      if (exit !== undefined) {
        this.#close(closedError('exited', undefined, exit), true);
        return;
      }
      // The SDK closes with no error when its input ends.
      const ended = reason instanceof Error && reason.message === 'ACP connection closed';
      this.#close(closedError(ended ? 'stream_closed' : 'stream_error', ended ? undefined : reason, undefined), true);
    });
  }

  /** Enters the closed state once: fails pending steps, withdraws open permissions, kills a live child. */
  #close(error: AcpClientError, killChild: boolean): void {
    if (this.#closed !== undefined) {
      return;
    }
    this.#closed = error;
    this.#log({ event: 'closed', reason: error.closeReason ?? 'stream_error', error: error.message });
    this.#rejectClosed(error);
    this.#resolveClosed(error);
    this.#withdraw();
    try {
      this.#gate.error(error);
    } catch {
      // The stream is already closed.
    }
    if (killChild && this.#process.exit === undefined) {
      this.#log({ event: 'kill', reason: error.closeReason ?? 'stream_error' });
      void this.#process.kill();
    }
  }

  /**
   * Numbers each frame from the agent as it comes off the wire, before the SDK
   * dispatches it, and notes where each answer and each session's latest
   * `config_option_update` came.
   */
  #onFrame(message: AnyMessage): void {
    this.#received += 1;
    const frame: unknown = message;
    if (!isRecord(frame)) {
      return;
    }
    if (!('method' in frame)) {
      const result = frame['result'];
      if (isRecord(result)) {
        this.#answerPositions.set(result, this.#received);
      }
      return;
    }
    const params = frame['params'];
    if (
      frame['method'] === CLIENT_METHODS.session_update &&
      isRecord(params) &&
      typeof params['sessionId'] === 'string' &&
      isRecord(params['update']) &&
      params['update']['sessionUpdate'] === 'config_option_update'
    ) {
      this.#configUpdatePositions.set(params['sessionId'], this.#received);
    }
  }

  /** Where an answer came on the wire; one not numbered counts as the latest frame. */
  #answerPosition(result: object): number {
    return this.#answerPositions.get(result) ?? this.#received;
  }

  /**
   * Stores a session's config list unless the stored one came later on the
   * wire: an answer handed back after a `config_option_update` that followed
   * it (`#step` yields first) does not undo that update.
   */
  #storeConfig(
    sessionId: string,
    options: readonly SessionConfigOption[] | null | undefined,
    position: number,
  ): void {
    if (!Array.isArray(options) || position < (this.#configPositions.get(sessionId) ?? 0)) {
      return;
    }
    this.#config.set(sessionId, Object.freeze([...options]));
    this.#configPositions.set(sessionId, position);
    this.#notifyWatchers();
  }

  #notifyWatchers(): void {
    for (const watcher of this.#watchers) {
      watcher();
    }
  }

  #emit(event: TurnEvent): void {
    if (this.#events === undefined) {
      return;
    }
    try {
      this.#events(event);
    } catch (error) {
      this.#log({ event: 'error', where: 'events sink', error: describeError(error) });
    }
  }

  #log(entry: LifecycleEntry): void {
    if (this.#lifecycle === undefined) {
      return;
    }
    try {
      this.#lifecycle(entry);
    } catch {
      // A failing log sink must not break the connection.
    }
  }
}

function sessionIdOf(response: NewSessionResponse): string | undefined {
  if (typeof response.sessionId === 'string' && response.sessionId !== '') {
    return response.sessionId;
  }
  const metaId = response._meta?.['id'];
  return typeof metaId === 'string' && metaId !== '' ? metaId : undefined;
}

/** One entry of `_kiro/mcp/status` `servers`; undefined without a string name and status. */
function mcpServerStatusOf(entry: unknown): McpServerStatus | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  const { name, status, tools } = entry as Record<string, unknown>;
  if (typeof name !== 'string' || typeof status !== 'string') {
    return undefined;
  }
  const names = Array.isArray(tools)
    ? tools.flatMap((tool: unknown) => {
        const toolName = typeof tool === 'object' && tool !== null ? (tool as Record<string, unknown>)['name'] : undefined;
        return typeof toolName === 'string' ? [toolName] : [];
      })
    : [];
  return Object.freeze({ name, status, tools: Object.freeze(names) });
}

function maxBytesOption(maxMessageBytes: number | undefined): { maxMessageBytes?: number } {
  return maxMessageBytes === undefined ? {} : { maxMessageBytes };
}

function closedError(reason: CloseReason, cause: unknown, exit: ProcessExit | undefined): AcpClientError {
  const details = { closeReason: reason, ...(cause === undefined ? {} : { cause }), ...(exit === undefined ? {} : { exit }) };
  switch (reason) {
    case 'exited':
      return new AcpClientError('closed', `Kiro process ${describeExit(exit)}`, details);
    case 'message_too_large':
      return new AcpClientError('closed', `ACP message too large: ${describeError(cause)}`, details);
    case 'stream_closed':
      return new AcpClientError('closed', 'Kiro closed its ACP stream', details);
    default:
      return new AcpClientError('closed', `ACP stream failed: ${describeError(cause)}`, details);
  }
}

function describeExit(exit: ProcessExit | undefined): string {
  if (exit === undefined) {
    return 'exited';
  }
  if (exit.error !== undefined) {
    return `could not start: ${exit.error.message}`;
  }
  return exit.signal !== null ? `was killed by ${exit.signal}` : `exited with code ${String(exit.code)}`;
}

function abortedError(method: string, reason: unknown): AcpClientError {
  return new AcpClientError('aborted', `${method} was aborted`, { cause: reason });
}

function describeError(error: unknown): string {
  if (error instanceof RequestError) {
    return `RequestError ${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function stopReasonOf(result: unknown): { stopReason?: string } {
  if (typeof result === 'object' && result !== null && 'stopReason' in result) {
    const { stopReason } = result as { stopReason: unknown };
    if (typeof stopReason === 'string') {
      return { stopReason };
    }
  }
  return {};
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shows `seen` every frame from the agent as it comes off the wire, before the SDK reads it. */
function watchIncoming(stream: Stream, seen: (message: AnyMessage) => void): Stream {
  const readable = stream.readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        seen(message);
        controller.enqueue(message);
      },
    }),
  );
  return { readable, writable: stream.writable };
}

/** Copies every frame to the lifecycle sink, in both directions. */
function tapFrames(stream: Stream, log: LifecycleSink): Stream {
  const readable = stream.readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        log({ event: 'frame', dir: 'a2c', message });
        controller.enqueue(message);
      },
    }),
  );
  const writer = stream.writable.getWriter();
  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      log({ event: 'frame', dir: 'c2a', message });
      await writer.write(message);
    },
    async close() {
      await writer.close();
    },
    async abort(reason) {
      await writer.abort(reason);
    },
  });
  return { readable, writable };
}
