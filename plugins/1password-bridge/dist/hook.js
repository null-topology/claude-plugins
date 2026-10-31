// src/board.ts
import { readdirSync, readFileSync as readFileSync2, renameSync as renameSync2, rmSync as rmSync2, statSync, utimesSync as utimesSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { performance } from "node:perf_hooks";

// src/paths.ts
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// src/version.ts
var PROTOCOL_VERSION = 2;

// src/paths.ts
var STATE_DIR_NAME = "1password-bridge";
var MAX_SOCKET_PATH_BYTES = 100;
var SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
function resolveStateDir(env = process.env) {
  const pluginData = env.CLAUDE_PLUGIN_DATA;
  if (pluginData !== void 0 && pluginData !== "") {
    return resolve(pluginData);
  }
  const xdgState = env.XDG_STATE_HOME;
  if (xdgState !== void 0 && isAbsolute(xdgState)) {
    return join(xdgState, STATE_DIR_NAME);
  }
  const home = env.HOME !== void 0 && env.HOME !== "" ? env.HOME : homedir();
  return join(home, ".local", "state", STATE_DIR_NAME);
}
function isSessionId(value) {
  return SESSION_ID_PATTERN.test(value);
}
function sessionsDir(stateDir) {
  return join(stateDir, "sessions");
}
function sessionDir(stateDir, sessionId) {
  if (!isSessionId(sessionId)) {
    throw new TypeError(`Invalid session id ${JSON.stringify(sessionId)}`);
  }
  return join(sessionsDir(stateDir), sessionId);
}
function boardDir(stateDir, id) {
  return join(sessionDir(stateDir, id), "board");
}
function maskedMarkerPath(stateDir, id) {
  return join(sessionDir(stateDir, id), "masked");
}
function lastSeenPath(stateDir, id) {
  return join(sessionDir(stateDir, id), "last-seen");
}
function sessionInfoPath(stateDir, id) {
  return join(sessionDir(stateDir, id), "session.json");
}
function socketPath(stateDir, uid, tmp, runtimeDir) {
  const name = `broker-v${PROTOCOL_VERSION}.sock`;
  const preferred = join(stateDir, "run", name);
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) {
    return preferred;
  }
  if (runtimeDir !== void 0 && isAbsolute(runtimeDir)) {
    const runtime = join(runtimeDir, STATE_DIR_NAME, name);
    if (Buffer.byteLength(runtime) <= MAX_SOCKET_PATH_BYTES) {
      return runtime;
    }
  }
  return join(tmp, `${STATE_DIR_NAME}-${uid}`, name);
}

// src/session-files.ts
import { mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
function errCode(err) {
  return err !== null && typeof err === "object" ? err.code : void 0;
}
function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 384 });
  renameSync(tmp, path);
}
function touchLastSeen(stateDir, id, now) {
  const path = lastSeenPath(stateDir, id);
  const time = new Date(now);
  try {
    utimesSync(path, time, time);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
    mkdirSync(sessionDir(stateDir, id), { recursive: true, mode: 448 });
    writeFileSync(path, "", { mode: 384 });
    utimesSync(path, time, time);
  }
}
function writeSessionInfo(stateDir, id, info) {
  writeAtomic(sessionInfoPath(stateDir, id), `${JSON.stringify(info)}
`);
}
function readMarker(stateDir, id) {
  let text;
  try {
    text = readFileSync(maskedMarkerPath(stateDir, id), "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") return void 0;
    throw err;
  }
  return text.split("\n").filter((line) => line !== "");
}

// src/ticket-lifetime.ts
var TICKET_TTL_MS = 10 * 60 * 1e3;

// src/board.ts
var DEFAULT_COMMAND_TIMEOUT_MS = 6e5;
var STALE_GRACE_MS = 3e4;
var BACKGROUND_PRUNE_MARGIN_MS = 1e4;
var MAX_SCAN_ATTEMPTS = 5;
var FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;
var BACKGROUND_PREFIX = "bg-";
function errCode2(err) {
  return err !== null && typeof err === "object" ? err.code : void 0;
}
function positive(v) {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : void 0;
}
function hasBackgroundPrefix(id) {
  return id.startsWith(BACKGROUND_PREFIX);
}
function isTaskId(id) {
  return FILE_ID.test(id);
}
function isForegroundId(id) {
  return FILE_ID.test(id) && !hasBackgroundPrefix(id);
}
function commandTimeoutMs(toolInput, env) {
  const own = toolInput !== null && typeof toolInput === "object" ? toolInput.timeout : void 0;
  return positive(own) ?? positive(env["BASH_MAX_TIMEOUT_MS"]) ?? DEFAULT_COMMAND_TIMEOUT_MS;
}
function writeEntry(stateDir, session, entry) {
  if (!isForegroundId(entry.tool_use_id)) return;
  writeAtomic(join2(boardDir(stateDir, session), `${entry.tool_use_id}.json`), JSON.stringify(entry));
}
function removeEntry(stateDir, session, toolUseId) {
  if (!isForegroundId(toolUseId)) return;
  rmSync2(join2(boardDir(stateDir, session), `${toolUseId}.json`), { force: true });
}
function moveToBackground(stateDir, session, toolUseId, taskId, now = Date.now()) {
  if (!isForegroundId(toolUseId) || !isTaskId(taskId)) return;
  const dir = boardDir(stateDir, session);
  const from = join2(dir, `${toolUseId}.json`);
  const time = new Date(now);
  try {
    utimesSync2(from, time, time);
  } catch {
  }
  try {
    renameSync2(from, join2(dir, `${BACKGROUND_PREFIX}${taskId}.json`));
  } catch (err) {
    if (errCode2(err) !== "ENOENT") throw err;
  }
}
function parseEntry(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return void 0;
  }
  if (v === null || typeof v !== "object") return void 0;
  const e = v;
  const { agent_id, agent_type, tool_use_id, command, cwd, startedAt, timeoutMs } = e;
  if (typeof agent_id !== "string" || typeof tool_use_id !== "string" || typeof command !== "string" || typeof cwd !== "string") return void 0;
  if (typeof startedAt !== "number" || typeof timeoutMs !== "number") return void 0;
  if (agent_type !== void 0 && typeof agent_type !== "string") return void 0;
  const entry = { agent_id, tool_use_id, command, cwd, startedAt, timeoutMs };
  if (agent_type !== void 0) entry.agent_type = agent_type;
  return entry;
}
function listNames(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (err) {
    if (errCode2(err) === "ENOENT") return [];
    throw err;
  }
}
function sameNames(a, b) {
  const names = new Set(a);
  return a.length === b.length && b.every((name) => names.has(name));
}
function list(stateDir, session) {
  const dir = boardDir(stateDir, session);
  const seen = /* @__PURE__ */ new Map();
  for (let attempt = 0; attempt < MAX_SCAN_ATTEMPTS; attempt += 1) {
    const names = listNames(dir);
    const pass = [];
    let vanished = false;
    for (const name of names) {
      const path = join2(dir, name);
      let entry;
      try {
        entry = parseEntry(readFileSync2(path, "utf8"));
      } catch (err) {
        if (errCode2(err) !== "ENOENT") throw err;
        vanished = true;
        continue;
      }
      const base = name.slice(0, -".json".length);
      pass.push({ path, taskId: base.startsWith(BACKGROUND_PREFIX) ? base.slice(BACKGROUND_PREFIX.length) : void 0, entry });
    }
    if (!vanished && sameNames(names, listNames(dir))) return pass;
    for (const item of pass) seen.set(item.entry === void 0 ? `path:${item.path}` : `id:${item.entry.tool_use_id}`, item);
  }
  return [...seen.values()];
}
function stale(entry, now) {
  return now - entry.startedAt > Math.max(entry.timeoutMs, TICKET_TTL_MS) + STALE_GRACE_MS;
}
function pruneStale(stateDir, session, now) {
  for (const { path, taskId, entry } of list(stateDir, session)) {
    if (taskId === void 0 && (entry === void 0 || stale(entry, now))) rmSync2(path, { force: true });
  }
}
function pruneForeground(stateDir, session, agentId) {
  for (const { path, taskId, entry } of list(stateDir, session)) {
    if (taskId === void 0 && entry?.agent_id === agentId) rmSync2(path, { force: true });
  }
}
function pruneBackground(stateDir, session, live, hookStart = performance.timeOrigin) {
  const movedBefore = hookStart - BACKGROUND_PRUNE_MARGIN_MS;
  for (const { path, taskId } of list(stateDir, session)) {
    if (taskId === void 0 || live.has(taskId)) continue;
    const movedAt = statSync(path, { throwIfNoEntry: false })?.mtimeMs;
    if (movedAt !== void 0 && movedAt < movedBefore) rmSync2(path, { force: true });
  }
}

// src/protocol.ts
var TICKET_ID_PATTERN = /^tkt_[a-z2-7]{16}$/;
var FAILURE_CODES = [
  "denied",
  "no_dialog",
  "not_found",
  "ambiguous",
  "bad_ref",
  "integration_off",
  "auth_denied",
  "auth_timeout",
  "expired",
  "busy",
  "not_owner",
  "other_agent",
  "no_command",
  "unknown",
  "used",
  "voided",
  "field_gone",
  // The broker lost its socket path to another broker; broker-client reconnects and retries once.
  "displaced",
  "no_app",
  "internal"
];
var RELEASE_RESULTS = ["voided", "in_flight", "unmasked", "mask_kept", "final", "unknown", "not_owner"];
var MAX_LINE_BYTES = 1024 * 1024;
var MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
var FrameError = class extends Error {
  code = "EFRAME";
  constructor(message) {
    super(message);
    this.name = "FrameError";
  }
};
function encodeLine(message) {
  return `${JSON.stringify(message)}
`;
}
function readLine(stream, maxBytes = MAX_LINE_BYTES) {
  return new Promise((resolve2, reject) => {
    const chunks = [];
    let size = 0;
    const finish = (settle) => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("close", onEnd);
      stream.off("error", onEnd);
      stream.pause();
      settle();
    };
    const onData = (chunk) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const end = bytes.indexOf(10);
      if (end >= 0 && size + end <= maxBytes) {
        chunks.push(bytes.subarray(0, end));
        finish(() => resolve2(Buffer.concat(chunks).toString("utf8")));
        return;
      }
      size += end >= 0 ? end : bytes.length;
      if (size > maxBytes) {
        finish(() => reject(new FrameError(`No newline within ${maxBytes} bytes`)));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => finish(() => resolve2(null));
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("close", onEnd);
    stream.once("error", onEnd);
  });
}
function parseObject(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return isObject(value) ? value : null;
}
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isString(v) {
  return typeof v === "string";
}
function isOptionalString(v) {
  return v === void 0 || typeof v === "string";
}
function isTicketId(v) {
  return isString(v) && TICKET_ID_PATTERN.test(v);
}
function parseField(v) {
  if (!isObject(v)) return null;
  const { id, title, sectionId, section, type, masked } = v;
  if (!isString(id) || !isString(title) || !isString(type) || typeof masked !== "boolean") return null;
  if (!isOptionalString(sectionId) || !isOptionalString(section)) return null;
  const field = { id, title, type, masked };
  if (sectionId !== void 0) field.sectionId = sectionId;
  if (section !== void 0) field.section = section;
  return field;
}
function parseResponse(line, op) {
  const m = parseObject(line);
  if (m === null) return null;
  if (m["ok"] === false) {
    const { code, message } = m;
    return FAILURE_CODES.includes(code) && isString(message) ? { ok: false, code, message } : null;
  }
  if (m["ok"] !== true || m["op"] !== op) return null;
  switch (op) {
    case "status": {
      const { accounts, exitsAt } = m;
      if (!Array.isArray(accounts) || !isString(exitsAt)) return null;
      const list2 = [];
      for (const a of accounts) {
        if (!isObject(a) || !isString(a["account"]) || typeof a["warm"] !== "boolean") return null;
        list2.push({ account: a["account"], warm: a["warm"] });
      }
      return { ok: true, op, accounts: list2, exitsAt };
    }
    case "fields": {
      const { vault, item, fields } = m;
      if (!isString(vault) || !isObject(item) || !isString(item["title"]) || !isString(item["category"]) || !Array.isArray(fields)) return null;
      const list2 = [];
      for (const f of fields) {
        const field = parseField(f);
        if (field === null) return null;
        list2.push(field);
      }
      return { ok: true, op, vault, item: { title: item["title"], category: item["category"] }, fields: list2 };
    }
    case "issue_tickets": {
      const { tickets, expiresAt, field } = m;
      if (!Array.isArray(tickets) || !tickets.every(isTicketId) || !isString(expiresAt) || !isObject(field)) return null;
      const { vault, item, field: title, type, masked, short } = field;
      if (!isString(vault) || !isString(item) || !isString(title) || !isString(type)) return null;
      if (typeof masked !== "boolean" || typeof short !== "boolean") return null;
      return { ok: true, op, tickets: [...tickets], expiresAt, field: { vault, item, field: title, type, masked, short } };
    }
    case "redeem": {
      const value = m["value"];
      return isString(value) ? { ok: true, op, value } : null;
    }
    case "mask": {
      const { known, changed, missing } = m;
      if (typeof known !== "boolean" || typeof changed !== "boolean" || !Object.hasOwn(m, "output")) return null;
      if (!Array.isArray(missing) || !missing.every(isString)) return null;
      return { ok: true, op, known, changed, output: m["output"], missing: [...missing] };
    }
    case "release": {
      const results = m["results"];
      if (!Array.isArray(results)) return null;
      const list2 = [];
      for (const r of results) {
        if (!isObject(r) || !isString(r["ticket"])) return null;
        const result = r["result"];
        if (!RELEASE_RESULTS.includes(result)) return null;
        list2.push({ ticket: r["ticket"], result });
      }
      return { ok: true, op, results: list2 };
    }
    case "end_session":
      return { ok: true, op };
  }
}

// src/hooks/common.ts
var HOOK_EVENTS = ["SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop", "SessionEnd"];
function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
function liveSessionId(input) {
  const id = input["session_id"];
  return typeof id === "string" && isSessionId(id) ? id : void 0;
}
function maskedSession(ctx) {
  const id = liveSessionId(ctx.input);
  if (id === void 0) return void 0;
  let tickets;
  try {
    tickets = readMarker(ctx.stateDir, id);
  } catch {
    return { id, tickets: [], unreadable: true };
  }
  if (tickets === void 0) return void 0;
  if (tickets.length === 0 || !tickets.every((t) => TICKET_ID_PATTERN.test(t))) return { id, tickets: [], unreadable: true };
  return { id, tickets, unreadable: false };
}

// src/hooks/log.ts
import { appendFileSync, chmodSync, mkdirSync as mkdirSync2, statSync as statSync2, truncateSync } from "node:fs";
import { join as join3 } from "node:path";
var MAX_HOOK_LOG_BYTES = 1024 * 1024;
var ERROR_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;
var ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
var STEP = /^[a-z][a-z-]{0,31}$/;
var BROKER_ERROR_CODES = { unavailable: true, untrusted: true, closed: true, timeout: true, protocol: true };
var BROKER_CODES = /* @__PURE__ */ new Set([...Object.keys(BROKER_ERROR_CODES), ...FAILURE_CODES]);
function hookLogPath(stateDir) {
  return join3(stateDir, "log", "hook.log");
}
function errorCode(err) {
  if (err !== null && typeof err === "object") {
    const code = err.code;
    if (typeof code === "string" && ERROR_CODE.test(code)) return code;
    if (typeof code === "string" && BROKER_CODES.has(code)) return code.toUpperCase();
    const name = err.name;
    if (typeof name === "string" && ERROR_NAME.test(name)) return name;
  }
  return "unknown";
}
function logHookError(stateDir, event, step, err, now = /* @__PURE__ */ new Date()) {
  try {
    const line = {
      at: now.toISOString(),
      event: HOOK_EVENTS.includes(event) ? event : "unknown",
      step: STEP.test(step) ? step : "unknown",
      code: errorCode(err)
    };
    const path = hookLogPath(stateDir);
    mkdirSync2(join3(stateDir, "log"), { recursive: true, mode: 448 });
    try {
      if (statSync2(path).size > MAX_HOOK_LOG_BYTES) truncateSync(path, 0);
    } catch {
    }
    appendFileSync(path, `${JSON.stringify(line)}
`, { mode: 384 });
    chmodSync(path, 384);
  } catch {
  }
}

// src/hooks/board-hooks.ts
var BoardRefusal = class extends Error {
  code;
  constructor(code) {
    super(code);
    this.name = "BoardRefusal";
    this.code = code;
  }
};
function agentOf(ctx) {
  const agent = ctx.input["agent_id"];
  return typeof agent === "string" && agent !== "" ? agent : "main";
}
function refuseBackgroundPrefix(toolUseId) {
  if (hasBackgroundPrefix(toolUseId)) throw new BoardRefusal("BACKGROUND_TOOL_USE_ID");
}
function boardBefore(ctx, now = Date.now()) {
  const id = liveSessionId(ctx.input);
  const toolUseId = ctx.input["tool_use_id"];
  const toolInput = ctx.input["tool_input"];
  if (id === void 0 || typeof toolUseId !== "string" || !isPlainObject(toolInput)) return;
  const command = toolInput["command"];
  if (typeof command !== "string") return;
  refuseBackgroundPrefix(toolUseId);
  const cwd = ctx.input["cwd"];
  const type = ctx.input["agent_type"];
  const entry = {
    agent_id: agentOf(ctx),
    tool_use_id: toolUseId,
    command,
    cwd: typeof cwd === "string" ? cwd : "",
    startedAt: now,
    timeoutMs: commandTimeoutMs(toolInput, ctx.env)
  };
  if (typeof type === "string" && type !== "") entry.agent_type = type;
  writeEntry(ctx.stateDir, id, entry);
}
function boardAfter(ctx) {
  const id = liveSessionId(ctx.input);
  const toolUseId = ctx.input["tool_use_id"];
  if (id === void 0 || typeof toolUseId !== "string") return;
  refuseBackgroundPrefix(toolUseId);
  const response = ctx.input["tool_response"];
  const taskId = isPlainObject(response) ? response["backgroundTaskId"] : void 0;
  if (taskId === void 0) {
    removeEntry(ctx.stateDir, id, toolUseId);
    return;
  }
  const name = typeof taskId === "number" ? String(taskId) : taskId;
  if (typeof name !== "string" || !isTaskId(name)) throw new BoardRefusal("UNUSABLE_TASK_ID");
  moveToBackground(ctx.stateDir, id, toolUseId, name);
}
function boardFailed(ctx) {
  const id = liveSessionId(ctx.input);
  const toolUseId = ctx.input["tool_use_id"];
  if (id === void 0 || typeof toolUseId !== "string") return;
  refuseBackgroundPrefix(toolUseId);
  removeEntry(ctx.stateDir, id, toolUseId);
}
function backgroundTaskIds(v) {
  if (!Array.isArray(v)) return void 0;
  const ids = /* @__PURE__ */ new Set();
  for (const task of v) {
    const id = typeof task === "string" ? task : isPlainObject(task) ? task["id"] ?? task["task_id"] ?? task["taskId"] : void 0;
    if (typeof id !== "string" || id === "") return void 0;
    ids.add(id);
  }
  return ids;
}
function stop(ctx) {
  const id = liveSessionId(ctx.input);
  if (id === void 0) return void 0;
  const event = ctx.input["hook_event_name"] === "SubagentStop" ? "SubagentStop" : "Stop";
  const agent = event === "Stop" ? "main" : agentOf(ctx);
  if (event === "Stop" || agent !== "main") {
    try {
      pruneForeground(ctx.stateDir, id, agent);
    } catch (err) {
      logHookError(ctx.stateDir, event, "board", err);
    }
  }
  const live = backgroundTaskIds(ctx.input["background_tasks"]);
  if (live !== void 0) {
    try {
      pruneBackground(ctx.stateDir, id, live);
    } catch (err) {
      logHookError(ctx.stateDir, event, "board", err);
    }
  }
  return void 0;
}

// src/mcp/broker-client.ts
import { lstatSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname as dirname2, join as join4 } from "node:path";
var BrokerError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
  }
};
function brokerSocketPath(stateDir, env = process.env) {
  return socketPath(stateDir, process.getuid?.() ?? 0, tmpdir(), env["XDG_RUNTIME_DIR"]);
}
function errorCode2(err) {
  return err !== null && typeof err === "object" ? err.code : void 0;
}
function untrusted(path, reason) {
  return new BrokerError("untrusted", `Refusing to connect to the 1password-bridge broker socket ${path}: ${reason}.`);
}
function lstatIfPresent(lstat, path) {
  try {
    return lstat(path);
  } catch (err) {
    if (errorCode2(err) === "ENOENT") return void 0;
    throw err;
  }
}
function checkSocket(path, uid, lstat) {
  const dir = lstatIfPresent(lstat, dirname2(path));
  if (dir === void 0) return "absent";
  if (dir.isSymbolicLink()) throw untrusted(path, "its directory is a symbolic link");
  if (!dir.isDirectory()) throw untrusted(path, "its directory is not a directory");
  if (dir.uid !== uid) throw untrusted(path, "its directory is owned by another user");
  if ((dir.mode & 63) !== 0) throw untrusted(path, "its directory is open to other users");
  const socket = lstatIfPresent(lstat, path);
  if (socket === void 0) return "absent";
  if (!socket.isSocket()) throw untrusted(path, "it is not a socket");
  if (socket.uid !== uid) throw untrusted(path, "the socket is owned by another user");
  return "present";
}
async function connectOnce(path, lstat) {
  const uid = process.getuid?.();
  if (uid !== void 0 && checkSocket(path, uid, lstat) === "absent") {
    throw Object.assign(new Error(`${path} does not exist`), { code: "ENOENT" });
  }
  return new Promise((resolve2, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve2(socket);
    });
    socket.once("error", reject);
  });
}
function notRunning(err) {
  const code = errorCode2(err);
  const why = typeof code === "string" ? ` (${code})` : "";
  return new BrokerError("unavailable", `The 1password-bridge broker is not reachable${why}.`);
}
async function connectSocket(path, lstat = lstatSync) {
  try {
    return await connectOnce(path, lstat);
  } catch (err) {
    if (err instanceof BrokerError) throw err;
    throw notRunning(err);
  }
}
async function exchange(socket, req, timeoutMs, maxBytes = MAX_LINE_BYTES) {
  socket.on("error", () => {
  });
  let timer;
  try {
    socket.write(encodeLine(req));
    const reading = readLine(socket, maxBytes);
    const line = timeoutMs === void 0 ? await reading : await Promise.race([
      reading,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new BrokerError("timeout", `The 1password-bridge broker did not answer within ${timeoutMs} ms.`)), timeoutMs);
      })
    ]);
    if (line === null) return null;
    const response = parseResponse(line, req.op);
    if (response === null) throw new BrokerError("protocol", "The 1password-bridge broker sent an answer this server does not understand.");
    return response;
  } catch (err) {
    if (err instanceof BrokerError) throw err;
    throw new BrokerError("protocol", "The 1password-bridge broker sent an answer this server does not understand.");
  } finally {
    if (timer !== void 0) clearTimeout(timer);
    socket.destroy();
  }
}
async function requestRunning(req, options) {
  const socket = await connectSocket(brokerSocketPath(options.stateDir, options.env), options.lstat);
  const response = await exchange(socket, req, options.timeoutMs, options.maxBytes);
  if (response === null) throw new BrokerError("closed", "The 1password-bridge broker closed the connection without an answer.");
  return response;
}

// src/hooks/broker.ts
var BrokerFailure = class extends Error {
  code;
  constructor(code) {
    super(`The 1password-bridge broker answered ${code}.`);
    this.name = "BrokerFailure";
    this.code = code;
  }
};
var HOOK_BROKER_TIMEOUT_MS = 8e3;
var END_SESSION_TIMEOUT_MS = 2e3;
function brokerAsk(ctx, timeoutMs = HOOK_BROKER_TIMEOUT_MS) {
  return (req) => requestRunning(req, { stateDir: ctx.stateDir, env: ctx.env, timeoutMs, maxBytes: MAX_OUTPUT_BYTES });
}

// src/hooks/post-tool-use-failure.ts
var MASK_LABEL = /<masked ticket=(tkt_[a-z2-7]{16})>/g;
function labelCounts(text) {
  const counts = /* @__PURE__ */ new Map();
  for (const m of text.matchAll(MASK_LABEL)) {
    const id = m[1] ?? "";
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}
async function postToolUseFailure(ctx, ask = brokerAsk(ctx)) {
  if (ctx.input["tool_name"] !== "Bash") return void 0;
  try {
    boardFailed(ctx);
  } catch (err) {
    logHookError(ctx.stateDir, "PostToolUseFailure", "board", err);
  }
  const masked = maskedSession(ctx);
  if (masked === void 0) return void 0;
  const error = ctx.input["error"];
  if (typeof error !== "string" || error === "") return void 0;
  let leaked;
  if (!masked.unreadable) {
    try {
      const answer = await ask({ v: PROTOCOL_VERSION, op: "mask", session: masked.id, tickets: masked.tickets, output: error });
      if (!answer.ok) throw new BrokerFailure(answer.code);
      if (answer.op === "mask" && answer.known) {
        if (!answer.changed) return void 0;
        const quoted = labelCounts(error);
        const added = [...labelCounts(String(answer.output))].filter(([id, n]) => n > (quoted.get(id) ?? 0)).map(([id]) => id);
        if (added.length > 0) leaked = added;
      }
    } catch (err) {
      logHookError(ctx.stateDir, "PostToolUseFailure", "scan", err);
    }
  }
  const additionalContext = leaked === void 0 ? "The failed output above may contain an unmasked secret value of this session, and no ticket could be named for it (failed Bash output cannot be rewritten). Do not repeat anything that looks like a secret; tell the user." : `The failed output above contains the unmasked value of ticket ${leaked.join(", ")} (failed Bash output cannot be rewritten). Do not repeat it; tell the user it may need rotating.`;
  return { hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext } };
}

// src/mask/masker.ts
function isPlainObject2(v) {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
var DISCRIMINATOR_KEYS = /* @__PURE__ */ new Set(["type", "mode"]);
function withholdDeep(v, note) {
  if (typeof v === "string") return note;
  if (Array.isArray(v)) return v.map((item) => withholdDeep(item, note));
  if (isPlainObject2(v)) {
    return Object.fromEntries(
      Object.entries(v).map(([key, item]) => [key, typeof item === "string" && DISCRIMINATOR_KEYS.has(key) ? item : withholdDeep(item, note)])
    );
  }
  return v;
}

// src/hooks/post-tool-use.ts
function withheldNote(tickets) {
  const which = tickets.length === 0 ? "the tickets of this session" : tickets.join(", ");
  return `[1password-bridge: output withheld, masking failed; call release with ${which} to stop masking]`;
}
var UNREADABLE_MARKER_NOTE = "[1password-bridge: output withheld, the masking marker of this session cannot be read; the Bash output stays withheld until the session ends, or, when the marker is only empty, until the next redeem delivers a masked value]";
function replaced(updatedToolOutput) {
  return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput } };
}
function withheld(ctx, response, note) {
  try {
    return replaced(withholdDeep(response, note));
  } catch (err) {
    logHookError(ctx.stateDir, "PostToolUse", "withhold", err);
    return replaced({ stdout: note, stderr: note, interrupted: false, isImage: false });
  }
}
async function postToolUse(ctx, ask = brokerAsk(ctx)) {
  if (ctx.input["tool_name"] !== "Bash") return void 0;
  try {
    boardAfter(ctx);
  } catch (err) {
    logHookError(ctx.stateDir, "PostToolUse", "board", err);
  }
  const masked = maskedSession(ctx);
  if (masked === void 0) return void 0;
  const response = ctx.input["tool_response"];
  if (masked.unreadable) {
    logHookError(ctx.stateDir, "PostToolUse", "marker", new Error("The masked marker cannot be read or holds no ticket id"));
    return withheld(ctx, response, UNREADABLE_MARKER_NOTE);
  }
  try {
    const answer = await ask({ v: PROTOCOL_VERSION, op: "mask", session: masked.id, tickets: masked.tickets, output: response });
    if (!answer.ok) throw new BrokerFailure(answer.code);
    if (answer.op !== "mask") throw new Error(`unexpected ${answer.op}`);
    if (!answer.known) return withheld(ctx, response, withheldNote(answer.missing));
    return answer.changed ? replaced(answer.output) : void 0;
  } catch (err) {
    logHookError(ctx.stateDir, "PostToolUse", "mask", err);
    return withheld(ctx, response, withheldNote(masked.tickets));
  }
}

// src/hooks/pre-tool-use.ts
var BRIDGE_TOOL = /^mcp__plugin_1password-bridge_op__(fields|issue_tickets|release)$/;
var BASH_TOOL = /^Bash$/;
var INJECTED = ["session_id", "transcript_path", "agent_id", "agent_type", "cwd"];
function preToolUse(ctx) {
  const tool = ctx.input["tool_name"];
  if (typeof tool === "string" && BASH_TOOL.test(tool)) {
    try {
      boardBefore(ctx);
    } catch (err) {
      logHookError(ctx.stateDir, "PreToolUse", "board", err);
    }
    return void 0;
  }
  const toolInput = ctx.input["tool_input"];
  if (typeof tool !== "string" || !BRIDGE_TOOL.test(tool) || !isPlainObject(toolInput)) return void 0;
  const updatedInput = {};
  for (const [key, value] of Object.entries(toolInput)) {
    if (!INJECTED.includes(key)) updatedInput[key] = value;
  }
  const sessionId = liveSessionId(ctx.input);
  if (sessionId !== void 0) updatedInput["session_id"] = sessionId;
  for (const key of ["transcript_path", "agent_type", "cwd"]) {
    const value = ctx.input[key];
    if (typeof value === "string" && value !== "") updatedInput[key] = value;
  }
  const agent = ctx.input["agent_id"];
  updatedInput["agent_id"] = typeof agent === "string" && agent !== "" ? agent : "main";
  return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } };
}

// src/hooks/session-end.ts
import { rmSync as rmSync3 } from "node:fs";
async function sessionEnd(ctx, ask = brokerAsk(ctx, END_SESSION_TIMEOUT_MS)) {
  const id = liveSessionId(ctx.input);
  if (id === void 0) return void 0;
  try {
    const answer = await ask({ v: PROTOCOL_VERSION, op: "end_session", session: id });
    if (!answer.ok) throw new BrokerFailure(answer.code);
  } catch (err) {
    if (!(err instanceof BrokerError && err.code === "unavailable")) logHookError(ctx.stateDir, "SessionEnd", "end-session", err);
  }
  try {
    rmSync3(sessionDir(ctx.stateDir, id), { recursive: true, force: true });
  } catch (err) {
    logHookError(ctx.stateDir, "SessionEnd", "remove", err);
  }
  return void 0;
}

// src/hooks/session-start.ts
import { appendFileSync as appendFileSync2, chmodSync as chmodSync2, lstatSync as lstatSync2, mkdirSync as mkdirSync3, readdirSync as readdirSync2, readFileSync as readFileSync3, rmSync as rmSync4, statSync as statSync4 } from "node:fs";
import { join as join6 } from "node:path";

// src/session-lifetime.ts
var SESSION_FORGET_MS = 7 * 24 * 60 * 60 * 1e3;
var FORGET_SCAN_MS = 10 * 60 * 1e3;
var SWEEP_AGE_MS = SESSION_FORGET_MS + 60 * 60 * 1e3;

// src/hooks/diagnostics.ts
import { accessSync, constants, statSync as statSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { delimiter, join as join5 } from "node:path";

// src/strings.ts
var SDK_INTEGRATION_SETTING = "Settings > Developer > Integrate with 1Password SDKs";

// src/hooks/diagnostics.ts
function isFile(path) {
  try {
    return statSync3(path).isFile();
  } catch {
    return false;
  }
}
var SYSTEM_PROBE = {
  platform: process.platform,
  get home() {
    return homedir2();
  },
  isFile,
  isExecutable(path) {
    if (!isFile(path)) return false;
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
};
var MAC_LIBRARY = "/Applications/1Password.app/Contents/Frameworks/libop_sdk_ipc_client.dylib";
var LINUX_LIBRARY_DIRS = ["/usr/bin/1password", "/opt/1Password", "/snap/bin/1password"];
var LINUX_LIBRARY = "libop_sdk_ipc_client.so";
var INTEGRATION = `then turn on ${SDK_INTEGRATION_SETTING} in the app`;
function onPath(command, env, probe) {
  const dirs = (env["PATH"] ?? "").split(delimiter).filter((dir) => dir !== "");
  return dirs.some((dir) => probe.isExecutable(join5(dir, command)));
}
function missingDependencies(env, probe) {
  const missing = [];
  switch (probe.platform) {
    case "darwin": {
      if (!probe.isExecutable("/usr/bin/osascript")) {
        missing.push({
          text: "/usr/bin/osascript is missing, so the approval window cannot open; it ships with macOS, so check the system installation.",
          stops: "redeem"
        });
      }
      if (!probe.isFile(MAC_LIBRARY) && !probe.isFile(join5(probe.home, MAC_LIBRARY))) {
        missing.push({
          text: `the 1Password desktop app was not found (no libop_sdk_ipc_client.dylib in /Applications/1Password.app or ~/Applications/1Password.app); install 1Password 8 for Mac, ${INTEGRATION}.`,
          stops: "all"
        });
      }
      break;
    }
    case "linux": {
      if (!onPath("zenity", env, probe)) {
        missing.push({
          text: "zenity is not on PATH, so the approval window cannot open; install it with the package manager (for example `apt install zenity` or `dnf install zenity`).",
          stops: "redeem"
        });
      }
      if (!LINUX_LIBRARY_DIRS.some((dir) => probe.isFile(join5(dir, LINUX_LIBRARY)))) {
        missing.push({
          text: `the 1Password desktop app was not found (no ${LINUX_LIBRARY} in ${LINUX_LIBRARY_DIRS.join(", ")}); install the 1Password 8 desktop app, ${INTEGRATION}.`,
          stops: "all"
        });
      }
      break;
    }
    default:
      missing.push({ text: `this platform (${probe.platform}) is not supported; only macOS and Linux are.`, stops: "all" });
  }
  return missing;
}
function diagnosticsOutput(missing) {
  if (missing.length === 0) return void 0;
  const message = `1password-bridge: ${missing.map((m) => m.text).join(" ")}`;
  const effect = missing.some((m) => m.stops === "all") ? "1password-bridge tickets cannot be issued or redeemed." : "1password-bridge tickets can be issued but not redeemed: every redeem needs the approval window.";
  return {
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `${message} Until this is fixed, ${effect}`
    }
  };
}

// src/hooks/session-start.ts
var LEGACY_FILES = ["grants.json", "env"];
function shellQuote(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
function inDoubleQuotes(s) {
  return s.replace(/[\\"$`]/g, "\\$&");
}
function pathLine(pluginRoot) {
  return `export PATH="${inDoubleQuotes(pluginRoot)}/bin:$PATH"`;
}
function stateDirLine(stateDir) {
  return `export OP_BRIDGE_STATE_DIR=${shellQuote(stateDir)}`;
}
function exitTrapLine(pluginRoot) {
  const quoted = shellQuote(join6(pluginRoot, "bin", "exit-trap.sh"));
  return `[ -f ${quoted} ] && . ${quoted}`;
}
function errCode3(err) {
  return err !== null && typeof err === "object" ? err.code : void 0;
}
function holdsStatement(content, statement) {
  return `
${content}
`.includes(`
${statement}
`);
}
function appendLine(file, statement) {
  let current = "";
  try {
    current = readFileSync3(file, "utf8");
  } catch (err) {
    if (errCode3(err) !== "ENOENT") throw err;
  }
  if (holdsStatement(current, statement)) return;
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync2(file, `${separator}${statement}
`);
}
function lastSeen(stateDir, id, dirMtimeMs) {
  try {
    return statSync4(lastSeenPath(stateDir, id)).mtimeMs;
  } catch {
    return dirMtimeMs;
  }
}
function sweepSessions(stateDir, keep, now) {
  let names;
  try {
    names = readdirSync2(sessionsDir(stateDir));
  } catch (err) {
    if (errCode3(err) === "ENOENT") return;
    throw err;
  }
  for (const name of names) {
    if (!isSessionId(name)) continue;
    const dir = sessionDir(stateDir, name);
    try {
      const stat = lstatSync2(dir);
      if (!stat.isDirectory()) continue;
      for (const file of LEGACY_FILES) {
        try {
          rmSync4(join6(dir, file), { force: true });
        } catch (err) {
          logHookError(stateDir, "SessionStart", "legacy", err);
        }
      }
      if (name !== keep && now - lastSeen(stateDir, name, stat.mtimeMs) > SWEEP_AGE_MS) rmSync4(dir, { recursive: true, force: true });
    } catch (err) {
      logHookError(stateDir, "SessionStart", "sweep", err);
    }
  }
}
function sessionStart(ctx, probe = SYSTEM_PROBE, now = Date.now()) {
  const id = liveSessionId(ctx.input);
  if (id !== void 0) {
    try {
      const dir = sessionDir(ctx.stateDir, id);
      mkdirSync3(dir, { recursive: true, mode: 448 });
      chmodSync2(dir, 448);
      touchLastSeen(ctx.stateDir, id, now);
      const cwd = ctx.input["cwd"];
      if (typeof cwd === "string" && cwd !== "") writeSessionInfo(ctx.stateDir, id, { cwd });
      const envFile = ctx.env["CLAUDE_ENV_FILE"];
      if (envFile !== void 0 && envFile !== "") {
        appendLine(envFile, stateDirLine(ctx.stateDir));
        if (ctx.pluginRoot !== "") {
          appendLine(envFile, pathLine(ctx.pluginRoot));
          appendLine(envFile, exitTrapLine(ctx.pluginRoot));
        }
      }
    } catch (err) {
      logHookError(ctx.stateDir, "SessionStart", "session", err);
    }
  }
  try {
    sweepSessions(ctx.stateDir, id, now);
  } catch (err) {
    logHookError(ctx.stateDir, "SessionStart", "sweep", err);
  }
  return diagnosticsOutput(missingDependencies(ctx.env, probe));
}

// src/hooks/run.ts
async function dispatch(ctx) {
  switch (ctx.input["hook_event_name"]) {
    case "SessionStart":
      return sessionStart(ctx);
    case "PreToolUse":
      return preToolUse(ctx);
    case "PostToolUse":
      return postToolUse(ctx);
    case "PostToolUseFailure":
      return postToolUseFailure(ctx);
    case "Stop":
    case "SubagentStop":
      return stop(ctx);
    case "SessionEnd":
      return sessionEnd(ctx);
    default:
      return void 0;
  }
}
function keepSession(ctx, now = Date.now(), fail = (step, err) => logHookError(ctx.stateDir, ctx.input["hook_event_name"], step, err)) {
  const id = liveSessionId(ctx.input);
  if (id === void 0 || ctx.input["hook_event_name"] === "SessionEnd") return;
  try {
    touchLastSeen(ctx.stateDir, id, now);
  } catch (err) {
    fail("touch", err);
  }
  try {
    pruneStale(ctx.stateDir, id, now);
  } catch (err) {
    fail("prune", err);
  }
}
async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function runHook(io) {
  let stateDir;
  try {
    stateDir = resolveStateDir(io.env);
  } catch {
    return;
  }
  let event;
  try {
    const parsed = JSON.parse(await readAll(io.stdin));
    if (!isPlainObject(parsed)) return;
    const input = parsed;
    event = input["hook_event_name"];
    const ctx = { input, stateDir, pluginRoot: io.env["CLAUDE_PLUGIN_ROOT"] ?? "", env: io.env };
    keepSession(ctx);
    const output = await dispatch(ctx);
    if (output !== void 0) io.write(`${JSON.stringify(output)}
`);
  } catch (err) {
    logHookError(stateDir, event, "run", err);
  }
}

// src/hooks/main.ts
process.stdout.on("error", () => {
});
await runHook({ stdin: process.stdin, env: process.env, write: (text) => process.stdout.write(text) }).catch(() => {
});
process.exitCode = 0;
