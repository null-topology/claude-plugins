// src/hooks/context.ts
import { stat } from "node:fs/promises";

// src/store/files.ts
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
var DIR_MODE = 448;
var FILE_MODE = 384;
function errorCode(error) {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : void 0;
  }
  return void 0;
}
async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
}
function serialize(value, indent) {
  const text = JSON.stringify(value, null, indent);
  if (text === void 0) {
    throw new TypeError("Value cannot be written as JSON");
  }
  return `${text}
`;
}
async function readJsonIfExists(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return void 0;
    }
    throw error;
  }
  return JSON.parse(text);
}
async function appendJsonLine(path, value) {
  const line = Buffer.from(serialize(value), "utf8");
  const handle = await open(path, "a", FILE_MODE);
  try {
    const { bytesWritten } = await handle.write(line, 0, line.length);
    if (bytesWritten !== line.length) {
      throw new Error(`Short write to ${path}: ${bytesWritten} of ${line.length} bytes`);
    }
  } finally {
    await handle.close();
  }
}

// src/store/identity.ts
import { execFile } from "node:child_process";
import { readFile as readFile2, readlink } from "node:fs/promises";
import { hostname } from "node:os";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
function isProcessIdentity(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value;
  return isPid(record.pid) && typeof record.startTime === "string" && record.startTime !== "" && typeof record.hostId === "string" && record.hostId !== "";
}
function isPid(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function ownerKey(owner) {
  return `pid-${owner.pid}-${owner.startTime}@${owner.hostId}`;
}
function parseProcStat(stat2) {
  const nameEnd = stat2.lastIndexOf(")");
  if (nameEnd < 0) {
    throw new Error("Malformed /proc stat: no command name");
  }
  const fields = stat2.slice(nameEnd + 1).trim().split(/\s+/);
  const state = fields[0];
  const startTime = fields[22 - 3];
  if (state === void 0 || startTime === void 0 || !/^[0-9]+$/.test(startTime)) {
    throw new Error("Malformed /proc stat: no start time");
  }
  return { state, startTime };
}
function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}
async function linuxStartTime(pid) {
  let stat2;
  try {
    stat2 = await readFile2(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== "ESRCH") {
      throw error;
    }
    if (pidExists(pid)) {
      throw new Error(`Cannot read the start time of process ${pid}`);
    }
    return null;
  }
  const { state, startTime } = parseProcStat(stat2);
  return state === "Z" || state === "X" ? null : startTime;
}
async function darwinStartTime(pid) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("ps", ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" }
    }));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1) {
      return null;
    }
    throw error;
  }
  const [state, ...started] = stdout.trim().split(/\s+/);
  if (state === void 0 || state === "" || started.length === 0) {
    return null;
  }
  return state.startsWith("Z") ? null : started.join("_");
}
async function processStartTime(pid) {
  if (!isPid(pid)) {
    throw new TypeError(`Invalid pid ${String(pid)}`);
  }
  switch (process.platform) {
    case "linux":
      return linuxStartTime(pid);
    case "darwin":
      return darwinStartTime(pid);
    default:
      throw new Error(`Unsupported platform ${process.platform}`);
  }
}
async function linuxHostId() {
  const bootId = (await readFile2("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const namespace = await readlink("/proc/self/ns/pid");
  const inode = /^pid:\[([0-9]+)\]$/.exec(namespace)?.[1];
  if (bootId === "" || inode === void 0) {
    throw new Error("Cannot read the boot id or the pid namespace");
  }
  return `${hostname()}:${bootId}:${inode}`;
}
async function darwinHostId() {
  const { stdout } = await execFileAsync("sysctl", ["-n", "kern.boottime"]);
  const match = /sec = ([0-9]+), usec = ([0-9]+)/.exec(stdout);
  if (match === null) {
    throw new Error("Cannot read kern.boottime");
  }
  return `${hostname()}:${match[1]}.${match[2]}`;
}
var hostIdOnce;
function localHostId() {
  hostIdOnce ??= (async () => {
    switch (process.platform) {
      case "linux":
        return linuxHostId();
      case "darwin":
        return darwinHostId();
      default:
        throw new Error(`Unsupported platform ${process.platform}`);
    }
  })();
  return hostIdOnce;
}
async function processIdentity(pid) {
  const startTime = await processStartTime(pid);
  return startTime === null ? null : { pid, startTime, hostId: await localHostId() };
}
async function requireIdentity(pid) {
  const identity = await processIdentity(pid);
  if (identity === null) {
    throw new Error(`Process ${pid} is not running`);
  }
  return identity;
}
function currentOwner() {
  return requireIdentity(process.ppid);
}
async function liveness(identity) {
  if (identity.hostId !== await localHostId()) {
    return "other-host";
  }
  const startTime = await processStartTime(identity.pid);
  return startTime !== null && startTime === identity.startTime ? "alive" : "dead";
}

// src/store/paths.ts
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// src/home-name.ts
var HOME_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
var HOME_NAME_RULE = '1 to 64 characters from A-Z, a-z, 0-9, ".", "_" and "-", other than "." and ".."';
function isValidHomeName(name) {
  return HOME_NAME_PATTERN.test(name) && name !== "." && name !== "..";
}

// src/store/paths.ts
var STATE_DIR_NAME = "kiro-sidecar";
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
var LAUNCH_ID_PATTERN = /^ks_[0-9a-f]{12}$/;
function isLaunchId(value) {
  return LAUNCH_ID_PATTERN.test(value);
}
function runsDir(stateDir2) {
  return join(stateDir2, "runs");
}
function runPaths(stateDir2, launchId) {
  if (!isLaunchId(launchId)) {
    throw new TypeError(`Invalid launch id ${JSON.stringify(launchId)}`);
  }
  const dir = join(runsDir(stateDir2), launchId);
  return {
    dir,
    meta: join(dir, "meta.json"),
    lock: join(dir, "lock"),
    claudeSessions: join(dir, "claude-sessions.jsonl"),
    acpLog: join(dir, "acp.jsonl"),
    stderrLog: join(dir, "stderr.log"),
    turns: join(dir, "turns"),
    skills: join(dir, "skills"),
    steering: join(dir, "steering"),
    task: join(dir, "task.md")
  };
}
function turnPaths(stateDir2, launchId, turn) {
  if (!Number.isSafeInteger(turn) || turn < 1) {
    throw new TypeError(`Invalid turn number ${String(turn)}`);
  }
  const base = join(runPaths(stateDir2, launchId).turns, String(turn));
  return {
    result: `${base}.json`,
    text: `${base}.md`,
    partial: `${base}.md.part`,
    armed: `${base}.armed`,
    claimed: `${base}.claimed`,
    returned: `${base}.returned`,
    pushed: `${base}.pushed`
  };
}

// src/session/claims.ts
function isoSeconds(at = /* @__PURE__ */ new Date()) {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// src/session/resolve.ts
import { readdir } from "node:fs/promises";

// src/errors.ts
var SidecarError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "SidecarError";
    this.code = code;
  }
};

// src/store/runs.ts
var RUN_STATES = Object.freeze([
  "starting",
  "idle",
  "running",
  "exited",
  "stopped",
  /** Kiro called `complete_task` and the plugin closed the session; never resumable. */
  "completed",
  "lost",
  "failed"
]);
var isString = (value) => typeof value === "string";
var isBoolean = (value) => typeof value === "boolean";
var isStringList = (value) => Array.isArray(value) && value.every(isString);
var isTurnCount = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
var isOneOf = (allowed) => (value) => typeof value === "string" && allowed.includes(value);
var isNullable = (check) => (value) => value === null || check(value);
var isChild = (value) => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { pid, startTime } = value;
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && isString(startTime);
};
var META_FIELDS = {
  launchId: (value) => typeof value === "string" && isLaunchId(value),
  kiroSessionId: isNullable(isString),
  ownerKey: isString,
  driver: isProcessIdentity,
  home: isString,
  projectDir: isNullable(isString),
  label: isNullable(isString),
  mode: isOneOf(["local", "docker"]),
  dir: isString,
  dirReadOnly: isBoolean,
  mounts: isStringList,
  skills: isStringList,
  steering: isStringList,
  model: isNullable(isString),
  effort: isNullable(isString),
  kiroMode: isNullable(isString),
  permissions: isOneOf(["allow", "deny"]),
  preset: isNullable(isString),
  tokenSource: isNullable(isOneOf(["preset", "api_key"])),
  image: isNullable(isString),
  dockerUser: isNullable(isString),
  containerName: isNullable(isString),
  child: isNullable(isChild),
  state: isOneOf(RUN_STATES),
  currentTurn: isTurnCount,
  firstPromptPreview: isNullable(isString),
  createdAt: isString,
  updatedAt: isString
};
function parseRunMeta(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Malformed meta.json: not an object");
  }
  const record = value;
  for (const [field, check] of Object.entries(META_FIELDS)) {
    if (!check(record[field])) {
      throw new Error(`Malformed meta.json: bad field ${field}`);
    }
  }
  return record;
}
async function readMeta(stateDir2, launchId) {
  const value = await readJsonIfExists(runPaths(stateDir2, launchId).meta);
  return value === void 0 ? void 0 : parseRunMeta(value);
}
async function observedState(meta) {
  if (meta.state !== "idle" && meta.state !== "running") {
    return meta.state;
  }
  return await liveness(meta.driver) === "dead" ? "lost" : meta.state;
}
async function appendClaudeSession(stateDir2, launchId, entry) {
  const line = {
    id: entry.id,
    event: entry.event,
    at: entry.at ?? (/* @__PURE__ */ new Date()).toISOString(),
    ...entry.agentType === void 0 ? {} : { agentType: entry.agentType }
  };
  await appendJsonLine(runPaths(stateDir2, launchId).claudeSessions, line);
  return line;
}
async function readTurnResult(stateDir2, launchId, turn) {
  return readJsonIfExists(turnPaths(stateDir2, launchId, turn).result);
}

// src/text/errors.ts
var InvalidInputError = class extends SidecarError {
  code = "E_INVALID";
  field;
  constructor(field, message) {
    super("E_INVALID", `${field} ${message}`);
    this.name = "InvalidInputError";
    this.field = field;
  }
};

// src/session/resolve.ts
var LIVE_STATES = ["starting", "idle", "running"];
function isLiveState(state) {
  return LIVE_STATES.includes(state);
}
function createdTime(meta) {
  const time = Date.parse(meta.createdAt);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}
async function viewRun(scope, meta) {
  const own = meta.ownerKey === scope.owner;
  if (!own && meta.home !== scope.home) {
    return void 0;
  }
  let relation = "own";
  if (!own) {
    relation = meta.driver.hostId === await localHostId() ? "same-home" : "other-host";
  }
  const live = own ? scope.live.get(meta.launchId) ?? null : null;
  const state = live === null ? await observedState(meta) : live.state;
  return { launchId: meta.launchId, meta, relation, state, live };
}
async function readVisibleRun(scope, launchId) {
  if (!isLaunchId(launchId)) {
    return void 0;
  }
  let meta;
  try {
    meta = await readMeta(scope.stateDir, launchId);
  } catch {
    return void 0;
  }
  if (meta === void 0 || meta.launchId !== launchId) {
    return void 0;
  }
  return viewRun(scope, meta);
}
async function scanVisibleRuns(scope) {
  let names;
  try {
    names = await readdir(runsDir(scope.stateDir));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  const runs = await Promise.all(
    names.filter(isLaunchId).map((name) => readVisibleRun(scope, name))
  );
  return runs.filter((run) => run !== void 0).sort(
    (a, b) => createdTime(a.meta) - createdTime(b.meta) || a.launchId.localeCompare(b.launchId)
  );
}

// src/session/types.ts
var TURN_OUTCOMES = Object.freeze([
  "end_turn",
  "refusal",
  "max_tokens",
  "max_turn_requests",
  "cancelled",
  "stopped",
  "error",
  "exited",
  "lost"
]);
var ENDED_BY = Object.freeze(["cancel", "interrupt", "stop"]);

// src/session/turn-result.ts
var isString2 = (value) => typeof value === "string";
var isBoolean2 = (value) => typeof value === "boolean";
var isCount = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
var isPositiveCount = (value) => isCount(value) && value >= 1;
var isDuration = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
var isOneOf2 = (allowed) => (value) => typeof value === "string" && allowed.includes(value);
var isNullable2 = (check) => (value) => value === null || check(value);
var isStrings = (value) => Array.isArray(value) && value.every(isString2);
var isCompletion = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && isString2(value["result"]) && isString2(value["at"]);
var RESULT_FIELDS = {
  launchId: (value) => typeof value === "string" && isLaunchId(value),
  sessionId: isString2,
  label: isNullable2(isString2),
  turn: isPositiveCount,
  outcome: isOneOf2(TURN_OUTCOMES),
  endedBy: isNullable2(isOneOf2(ENDED_BY)),
  startedAt: isString2,
  endedAt: isString2,
  durationS: isDuration,
  toolCalls: isCount,
  lastTool: isNullable2(isString2),
  messages: isStrings,
  messagesDropped: isCount,
  completion: isNullable2(isCompletion),
  final: isString2,
  textChars: isCount,
  truncated: isBoolean2,
  error: isNullable2(isString2),
  stderrTail: isNullable2(isString2)
};
var LEGACY_DEFAULTS = {
  messages: [],
  messagesDropped: 0,
  completion: null
};
function copyField(field, value) {
  if (Array.isArray(value)) {
    return [...value];
  }
  if (field === "completion" && value !== null) {
    const { result, at } = value;
    return { result, at };
  }
  return value;
}
function parseTurnResult(value, launchId, turn) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("not an object");
  }
  const record = value;
  const copy = {};
  for (const [field, check] of Object.entries(RESULT_FIELDS)) {
    const fieldValue2 = Object.hasOwn(LEGACY_DEFAULTS, field) && !Object.hasOwn(record, field) ? LEGACY_DEFAULTS[field] : record[field];
    if (!check(fieldValue2)) {
      throw new Error(`bad field ${field}`);
    }
    copy[field] = copyField(field, fieldValue2);
  }
  if (record.launchId !== launchId) {
    throw new Error(`launchId ${String(record.launchId)} is not ${launchId}`);
  }
  if (record.turn !== turn) {
    throw new Error(`turn ${String(record.turn)} is not ${turn}`);
  }
  return copy;
}

// src/text/limits.ts
var KiB = 1024;
var MiB = 1024 * KiB;
var ACP_LOG_CAP_BYTES = 20 * MiB;
var STDERR_LOG_CAP_BYTES = 5 * MiB;
var TURN_TEXT_CAP_BYTES = 2 * MiB;
var DEBUG_FIELD_CAP_BYTES = 4 * KiB;
var PROMPT_FILE_MAX_BYTES = 32 * MiB;
var STDERR_TAIL_MAX_BYTES = 64 * KiB;
var MIN_KIRO_TOKEN_CHARS = 16;
var LABEL_MAX_CHARS = 40;
var FIELD_KEPT_CHARS = 500;

// src/text/neutralise.ts
var NEUTRALISED_PREFIX = "[neutralised] ";
var DELIMITER_LIKE = /\b(?:BEGIN|END)\s+KIRO\s+OUTPUT\b/i;
var TRAILER_LIKE = /^\s*kiro-(?:turn|result):/;
var REMINDER_TAG_OPEN = /<(?=\s*\/?\s*system[-_\s]?reminder)/gi;
var LINE_BREAK = /(\r\n|\r|\n|\u{2028}|\u{2029})/u;
function isMarkerLikeLine(line) {
  return DELIMITER_LIKE.test(line) || TRAILER_LIKE.test(line);
}
function neutraliseKiroText(text) {
  const parts = text.split(LINE_BREAK).map((part, index) => index % 2 === 0 && isMarkerLikeLine(part) ? NEUTRALISED_PREFIX + part : part);
  return parts.join("").replace(REMINDER_TAG_OPEN, "&lt;");
}

// src/text/unicode.ts
function isHighSurrogate(code) {
  return code >= 55296 && code <= 56319;
}
function isLowSurrogate(code) {
  return code >= 56320 && code <= 57343;
}
function splitsSurrogatePair(text, index) {
  return index > 0 && index < text.length && isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index));
}
function headChars(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }
  const end = Math.max(0, maxChars);
  return text.slice(0, splitsSurrogatePair(text, end) ? end - 1 : end);
}

// src/text/preview.ts
var HEAD_CUT_MARKER = " [...]";

// src/text/messages.ts
var ANY_LINE_BREAK = /\r\n|\r|\n|\u{2028}|\u{2029}/gu;
var MESSAGE_LINE_PREFIX = "- ";
var MESSAGE_LINE_EXTRA_CHARS = MESSAGE_LINE_PREFIX.length + 1;
function oneLine(text) {
  return text.replace(ANY_LINE_BREAK, " ");
}

// src/text/field.ts
function fieldValue(value, secrets) {
  const flat = oneLine(secrets.redact(value));
  return flat.length > FIELD_KEPT_CHARS ? headChars(flat, FIELD_KEPT_CHARS - HEAD_CUT_MARKER.length) + HEAD_CUT_MARKER : flat;
}
function headerValue(value, secrets) {
  return neutraliseKiroText(fieldValue(value, secrets));
}

// src/text/redact.ts
var REDACTED = "[REDACTED]";
var MESSAGING_TOKEN_VARIABLE = "CLAUDE_CODE_MESSAGING_TOKEN";
var SECRET_PROXY_VARIABLES = Object.freeze([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy"
]);
var PROXY_SETTING_VARIABLES = Object.freeze(["KIRO_SIDECAR_PROXY", "CLAUDE_PLUGIN_OPTION_PROXY"]);
function secretForms(secret) {
  if (secret === "") {
    return [];
  }
  const forms = /* @__PURE__ */ new Set([secret, JSON.stringify(secret).slice(1, -1)]);
  try {
    forms.add(encodeURIComponent(secret));
  } catch {
  }
  return [...forms];
}
function assertKiroToken(token, field) {
  if (token.length < MIN_KIRO_TOKEN_CHARS) {
    throw new InvalidInputError(
      field,
      `must hold a Kiro token of at least ${MIN_KIRO_TOKEN_CHARS} characters`
    );
  }
}
function buildSecretSet(sources = {}) {
  const secrets = [];
  const apiKey = sources.apiKey ?? "";
  if (apiKey !== "") {
    assertKiroToken(apiKey, "api_key");
    secrets.push(apiKey);
  }
  for (const token of sources.tokenFileValues ?? []) {
    assertKiroToken(token, "token_file");
    secrets.push(token);
  }
  for (const key of sources.kiroKeys ?? []) {
    if (key !== "") {
      secrets.push(key);
    }
  }
  const env = sources.env ?? process.env;
  for (const name of [MESSAGING_TOKEN_VARIABLE, ...SECRET_PROXY_VARIABLES, ...PROXY_SETTING_VARIABLES]) {
    const value = env[name];
    if (value !== void 0 && value !== "") {
      secrets.push(value);
    }
  }
  return new SecretSet(secrets);
}
var SecretSet = class {
  #patterns;
  constructor(secrets = []) {
    const patterns = /* @__PURE__ */ new Set();
    for (const secret of secrets) {
      for (const form of secretForms(secret)) {
        patterns.add(form);
      }
    }
    this.#patterns = Object.freeze([...patterns].map(compilePattern));
  }
  /** Number of distinct redacted forms. */
  get size() {
    return this.#patterns.length;
  }
  /** Characters a stream holds back: the longest form's length minus one. */
  get windowChars() {
    return windowFor(this.#patterns);
  }
  redact(text) {
    if (this.#patterns.length === 0 || text === "") {
      return text;
    }
    return emit(text, this.#patterns, text.length, 0, NO_RUN).text;
  }
  /** A redactor for one stream of text. */
  stream() {
    return new StreamRedactor(this.#patterns);
  }
  toJSON() {
    return { size: this.size };
  }
};
var StreamRedactor = class {
  #patterns;
  #window;
  /** Text received but not yet emitted. */
  #carry = "";
  /** Where the carry stands against the runs already emitted. */
  #state = NO_RUN;
  /** Leading characters of the carry that are never emitted (see `restart`). */
  #hidden = 0;
  /** Inserted text not placed yet, at offsets into the carry, in order. */
  #inserts = [];
  #insertedChars = 0;
  constructor(patterns) {
    this.#patterns = patterns;
    this.#window = windowFor(patterns);
  }
  push(chunk) {
    if (chunk === "") {
      return "";
    }
    const buffer = this.#carry + chunk;
    let cut = Math.max(0, buffer.length - this.#window);
    if (cut > 0 && isHighSurrogate(buffer.charCodeAt(cut - 1))) {
      cut -= 1;
    }
    return this.#advance(buffer, cut);
  }
  /**
   * Puts `text` into the output at the point between the input pushed so far
   * and the next push. Redaction does not see it, so a secret that spans the
   * point is still found; when the point falls inside a covered run, the text
   * is dropped.
   */
  insert(text) {
    if (text !== "") {
      this.#inserts.push({ at: this.#carry.length, text });
    }
  }
  /** UTF-16 code units of inserted text placed in the output since the redactor was created. */
  get insertedChars() {
    return this.#insertedChars;
  }
  /** Flushes the held-back text and resets the redactor for a new stream. */
  end() {
    const output2 = this.#advance(this.#carry, this.#carry.length, true);
    this.#carry = "";
    this.#state = NO_RUN;
    this.#hidden = 0;
    this.#inserts = [];
    return output2;
  }
  /**
   * Starts a new output segment: the held-back text, and any text inserted
   * into it, is dropped without being emitted, but the text stays as context,
   * so a secret that began in it is still redacted in the text that follows.
   */
  restart() {
    this.#hidden = this.#carry.length;
    this.#state = NO_RUN;
    this.#inserts = [];
  }
  #advance(buffer, cut, final = false) {
    const emitted = emit(buffer, this.#patterns, cut, this.#hidden, this.#state, this.#inserts, final);
    this.#carry = buffer.slice(cut);
    this.#state = { covered: emitted.covered, continues: emitted.continues };
    this.#hidden = Math.max(0, this.#hidden - cut);
    this.#inserts = emitted.pending.map((insert) => ({ at: insert.at - cut, text: insert.text }));
    this.#insertedChars += emitted.insertedChars;
    return emitted.text;
  }
};
var PERCENT_ESCAPE = /^%[0-9A-Fa-f]{2}$/;
var REGEX_SYNTAX = /[.*+?^${}()|[\]\\/]/g;
function compilePattern(form) {
  let source = "";
  let caseFree = false;
  for (let at = 0; at < form.length; at += 1) {
    const escape = form.slice(at, at + 3);
    if (PERCENT_ESCAPE.test(escape)) {
      const high = hexDigitClass(escape.charAt(1));
      const low = hexDigitClass(escape.charAt(2));
      caseFree ||= high.length > 1 || low.length > 1;
      source += `%${high}${low}`;
      at += 2;
    } else {
      source += form.charAt(at).replace(REGEX_SYNTAX, "\\$&");
    }
  }
  return { form, escapes: caseFree ? new RegExp(source, "g") : null };
}
function hexDigitClass(digit) {
  const lower = digit.toLowerCase();
  const upper = digit.toUpperCase();
  return lower === upper ? digit : `[${lower}${upper}]`;
}
function windowFor(patterns) {
  let longest = 0;
  for (const pattern of patterns) {
    longest = Math.max(longest, pattern.form.length);
  }
  return Math.max(0, longest - 1);
}
function coveredRuns(text, patterns, coveredPrefix) {
  const found = [];
  if (coveredPrefix > 0) {
    found.push([0, coveredPrefix]);
  }
  for (const { form, escapes } of patterns) {
    if (escapes === null) {
      for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
        found.push([at, at + form.length]);
      }
      continue;
    }
    escapes.lastIndex = 0;
    for (let match = escapes.exec(text); match !== null; match = escapes.exec(text)) {
      found.push([match.index, match.index + form.length]);
      escapes.lastIndex = match.index + 1;
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  const runs = [];
  for (const [start, end] of found) {
    const last = runs.at(-1);
    if (last !== void 0 && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      runs.push([start, end]);
    }
  }
  return runs;
}
var NO_RUN = Object.freeze({ covered: 0, continues: false });
var NO_INSERTS = Object.freeze([]);
function emit(buffer, patterns, cut, hidden, state, inserts = NO_INSERTS, final = false) {
  let output2 = "";
  let position = hidden;
  let lastEnd = -1;
  let next = 0;
  let insertedChars = 0;
  const plain = (to, atEnd) => {
    let from = position;
    for (; next < inserts.length; next += 1) {
      const insert = inserts[next];
      if (insert === void 0 || insert.at > to || insert.at === to && !atEnd) {
        break;
      }
      if (insert.at < from) {
        continue;
      }
      output2 += buffer.slice(from, insert.at) + insert.text;
      insertedChars += insert.text.length;
      from = insert.at;
    }
    if (to > from) {
      output2 += buffer.slice(from, to);
    }
  };
  for (const [start, end] of coveredRuns(buffer, patterns, state.covered)) {
    const continuation = start === 0 && state.continues;
    if (start >= cut && !continuation) {
      break;
    }
    if (end <= hidden) {
      continue;
    }
    plain(start, !continuation);
    if (!continuation) {
      output2 += REDACTED;
    }
    position = Math.max(position, end);
    lastEnd = end;
    if (end > cut) {
      break;
    }
  }
  plain(cut, final);
  const pending = inserts.slice(next);
  if (lastEnd >= cut) {
    return { text: output2, covered: lastEnd - cut, continues: true, pending, insertedChars };
  }
  return { text: output2, covered: 0, continues: output2 === "" && state.continues, pending, insertedChars };
}

// src/hooks/input.ts
var HOOK_INPUT_MAX_BYTES = 8 * 1024 * 1024;
var ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
async function readHookInput(stream, maxBytes = HOOK_INPUT_MAX_BYTES) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      size += buffer.length;
      if (size > maxBytes) {
        return { kind: "skip", reason: "input-too-large" };
      }
      chunks.push(buffer);
    }
  } catch (error) {
    return { kind: "skip", reason: "input-unreadable", error };
  }
  try {
    return { kind: "json", value: JSON.parse(Buffer.concat(chunks, size).toString("utf8")) };
  } catch {
    return { kind: "skip", reason: "input-not-json" };
  }
}

// src/hooks/log.ts
import { join as join2 } from "node:path";
var HOOKS_LOG_NAME = "hooks.log";
var ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;
function hooksLogPath(stateDir2) {
  return join2(stateDir2, HOOKS_LOG_NAME);
}
function hookLogLine(entry, at) {
  const { hook, step, reason, launchId, turn, toolUseId, sessionId, agentId, error } = entry;
  const code = error === void 0 ? void 0 : errorCode(error);
  return {
    at: isoSeconds(at),
    hook,
    step,
    reason,
    ...launchId === void 0 ? {} : { launchId },
    ...turn === void 0 ? {} : { turn },
    ...toolUseId === void 0 ? {} : { toolUseId },
    ...sessionId === void 0 ? {} : { sessionId },
    ...agentId === void 0 ? {} : { agentId },
    ...code !== void 0 && ERROR_CODE_PATTERN.test(code) ? { code } : {}
  };
}
async function appendHookLog(stateDir2, entry, at = /* @__PURE__ */ new Date()) {
  try {
    await ensureDir(stateDir2);
    await appendJsonLine(hooksLogPath(stateDir2), hookLogLine(entry, at));
  } catch {
  }
}

// src/docker/cli.ts
var TOKEN_VARIABLE = "KIRO_API_KEY";
var MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

// src/settings.ts
var ENV_PREFIX = "KIRO_SIDECAR_";
var DEFAULTS = Object.freeze({
  api_key: "",
  presets_file: "",
  home: "",
  docker_image: "sbx/kiro:latest",
  docker_user: "auto",
  kiro_command: "kiro-cli",
  default_mode: "docker",
  retention_days: 14,
  debug_acp: false,
  proxy: "",
  no_proxy: ""
});
var SETTING_KEYS = Object.freeze(
  Object.keys(DEFAULTS)
);
function envName(key) {
  return ENV_PREFIX + key.toUpperCase();
}
var PROXY_VARIABLES = Object.freeze([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy"
]);
var PROXY_URL_VARIABLES = Object.freeze(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]);
var NO_PROXY_VARIABLES = Object.freeze(["NO_PROXY", "no_proxy"]);
var DOCKER_USER_PATTERN = /^(?:auto|[0-9]+:[0-9]+)$/;
var INTEGER_PATTERN = /^[0-9]+$/;
function anyString(raw) {
  return { ok: true, value: raw };
}
function accepting(isValid, expected) {
  return (raw) => isValid(raw) ? { ok: true, value: raw } : { ok: false, expected };
}
function matching(pattern, expected) {
  return accepting((raw) => pattern.test(raw), expected);
}
function oneOf(allowed) {
  const expected = `one of ${allowed.map((value) => `"${value}"`).join(", ")}`;
  return (raw) => {
    const match = allowed.find((value) => value === raw);
    return match === void 0 ? { ok: false, expected } : { ok: true, value: match };
  };
}
function boolean(raw) {
  if (raw === "true") {
    return { ok: true, value: true };
  }
  if (raw === "false") {
    return { ok: true, value: false };
  }
  return { ok: false, expected: '"true" or "false"' };
}
function integerInRange(min, max) {
  const expected = `an integer from ${min} to ${max}`;
  return (raw) => {
    if (!INTEGER_PATTERN.test(raw)) {
      return { ok: false, expected };
    }
    const value = Number(raw);
    return value >= min && value <= max ? { ok: true, value } : { ok: false, expected };
  };
}
var FIELDS = {
  api_key: { parse: anyString, sensitive: true },
  presets_file: { parse: anyString },
  home: { parse: accepting(isValidHomeName, HOME_NAME_RULE) },
  docker_image: { parse: anyString },
  docker_user: {
    parse: matching(DOCKER_USER_PATTERN, '"auto" or "<uid>:<gid>" in decimal digits')
  },
  kiro_command: { parse: anyString },
  default_mode: { parse: oneOf(["local", "docker"]) },
  retention_days: { parse: integerInRange(1, 365) },
  debug_acp: { parse: boolean },
  // A proxy URL can carry credentials.
  proxy: { parse: anyString, sensitive: true },
  no_proxy: { parse: anyString }
};

// src/text/format.ts
var LABEL_PATTERN = new RegExp(`^[A-Za-z0-9._-]{1,${LABEL_MAX_CHARS}}$`);

// src/hooks/wake.ts
function present(value) {
  return value !== null && value !== "";
}

// src/hooks/waiter-loop.ts
var HOOK_API_KEY_VARIABLE = "CLAUDE_PLUGIN_OPTION_API_KEY";
function waiterSecrets(env) {
  return buildSecretSet({
    env,
    kiroKeys: [env[HOOK_API_KEY_VARIABLE] ?? "", env[envName("api_key")] ?? "", env[TOKEN_VARIABLE] ?? ""]
  });
}
function redactionChanges(secrets, ids) {
  return ids.some((id) => id !== null && secrets.redact(id) !== id);
}

// src/hooks/context.ts
var CONTEXT_MAX_CHARS = 2e3;
var CONTEXT_HOW_TO = "Read a turn with wait {session, turn}; continue a session with send {session, text}.";
var SOURCE_PATTERN = /^[a-z][a-z_-]{0,31}$/;
var NO_LIVE_SESSIONS = { get: () => void 0, list: () => [] };
function parseSessionStartInput(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "skip", reason: "input-invalid" };
  }
  const { session_id: sessionId, source } = value;
  if (typeof sessionId !== "string" || !ID_PATTERN.test(sessionId)) {
    return { kind: "skip", reason: "input-invalid" };
  }
  if (typeof source !== "string" || !SOURCE_PATTERN.test(source)) {
    return { kind: "skip", reason: "input-invalid" };
  }
  return { kind: "input", input: { sessionId, source } };
}
async function ownLiveRuns(stateDir2, owner) {
  const runs = await scanVisibleRuns({ stateDir: stateDir2, home: "", owner, live: NO_LIVE_SESSIONS });
  const own = runs.filter((run) => run.relation === "own" && isLiveState(run.state));
  const alive = await Promise.all(own.map(async (run) => await liveness(run.meta.driver) === "alive"));
  return own.filter((_, index) => alive[index] === true);
}
async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}
async function pushedTo(path) {
  let value;
  try {
    value = await readJsonIfExists(path);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
  if (value === void 0) {
    return void 0;
  }
  const id = typeof value === "object" && value !== null ? value.sessionId : void 0;
  return typeof id === "string" && ID_PATTERN.test(id) ? id : null;
}
async function turnDelivery(stateDir2, launchId, turn, state) {
  const paths = turnPaths(stateDir2, launchId, turn);
  const pushed = await pushedTo(paths.pushed);
  if (pushed !== void 0) {
    return { kind: "pushed", sessionId: pushed };
  }
  if (await fileExists(paths.returned)) {
    return { kind: "returned" };
  }
  const value = await readTurnResult(stateDir2, launchId, turn);
  if (value === void 0) {
    return state === "running" || state === "starting" ? { kind: "running" } : { kind: "no-result" };
  }
  parseTurnResult(value, launchId, turn);
  return { kind: "not-delivered" };
}
function deliveryText(delivery, secrets) {
  switch (delivery.kind) {
    case "pushed":
      return delivery.sessionId === null ? "pushed to a session" : `pushed to session ${headerValue(delivery.sessionId, secrets)}`;
    case "returned":
      return "returned by a tool";
    case "running":
      return "running";
    case "no-result":
      return "no result";
    case "not-delivered":
      return "not delivered";
  }
}
function sessionEntry(session, secrets) {
  const { meta } = session;
  const kiro = present(meta.kiroSessionId) ? `Kiro ${headerValue(meta.kiroSessionId, secrets)}` : null;
  const name = present(meta.label) ? `"${headerValue(meta.label, secrets)}" (${kiro === null ? meta.launchId : `${meta.launchId}, ${kiro}`})` : kiro === null ? meta.launchId : `${meta.launchId} (${kiro})`;
  const facts = [
    `dir ${headerValue(meta.dir, secrets)}`,
    `mode ${headerValue(meta.mode, secrets)}`,
    // Kiro called `complete_task`: never resumed or sent to (4.11).
    session.state === "completed" ? "state completed (completed by itself; start a new session)" : `state ${session.state}`
  ];
  if (meta.currentTurn > 0) {
    const delivery = session.delivery === null ? "" : ` (${deliveryText(session.delivery, secrets)})`;
    facts.push(`current turn ${meta.currentTurn}${delivery}`);
  }
  return `- ${name}: ${facts.join(", ")}.`;
}
function moreLine(count) {
  return `${count} more ${count === 1 ? "session is" : "sessions are"} not shown; list shows them.`;
}
function buildContextText(sessions, secrets) {
  const header = `[kiro-sidecar] Live Kiro sessions owned by this Claude process: ${sessions.length}.`;
  const entries = sessions.map((session) => sessionEntry(session, secrets));
  const assemble = (kept2) => [
    header,
    ...entries.slice(entries.length - kept2),
    ...kept2 < entries.length ? [moreLine(entries.length - kept2)] : [],
    CONTEXT_HOW_TO
  ].join("\n");
  let kept = entries.length;
  let text = assemble(kept);
  while (text.length > CONTEXT_MAX_CHARS && kept > 0) {
    kept -= 1;
    text = assemble(kept);
  }
  return text;
}
function contextOutput(text) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text }
  });
}
async function runContextHook(options) {
  const { stateDir: stateDir2 } = options;
  if (stateDir2 === null) {
    return null;
  }
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  let ids = {};
  let step = "input";
  const log = (logStep, reason, error, extra = {}) => appendHookLog(
    stateDir2,
    { hook: "context", step: logStep, reason, ...ids, ...extra, ...error === void 0 ? {} : { error } },
    now()
  );
  try {
    let secrets;
    try {
      secrets = (options.secrets ?? (() => waiterSecrets(options.env ?? process.env)))();
    } catch (error) {
      await log("input", "secrets-invalid", error);
      secrets = new SecretSet();
    }
    const read = await readHookInput(options.stdin);
    if (read.kind === "skip") {
      await log("input", read.reason, read.error);
      return null;
    }
    const parsed = parseSessionStartInput(read.value);
    if (parsed.kind === "skip") {
      await log("input", parsed.reason);
      return null;
    }
    const { sessionId, source } = parsed.input;
    if (redactionChanges(secrets, [sessionId, source])) {
      await log("input", "input-secret");
      return null;
    }
    ids = { sessionId };
    step = "owner";
    let owner;
    try {
      owner = ownerKey(await (options.owner ?? currentOwner)());
    } catch (error) {
      await log("owner", "owner-unknown", error);
      return null;
    }
    step = "session";
    const runs = await ownLiveRuns(stateDir2, owner);
    if (runs.length === 0) {
      return null;
    }
    const at = isoSeconds(now());
    for (const run of runs) {
      try {
        await appendClaudeSession(stateDir2, run.launchId, { id: sessionId, event: source, at });
      } catch (error) {
        await log("session", "session-log-failed", error, { launchId: run.launchId });
      }
    }
    step = "turn";
    const sessions = [];
    for (const run of runs) {
      const turn = run.meta.currentTurn;
      let delivery = null;
      if (turn > 0) {
        try {
          delivery = await turnDelivery(stateDir2, run.launchId, turn, run.state);
        } catch (error) {
          await log("turn", "result-unreadable", error, { launchId: run.launchId, turn });
        }
        if (delivery?.kind === "no-result") {
          await log("turn", "result-missing", void 0, { launchId: run.launchId, turn });
        }
      }
      sessions.push({ meta: run.meta, state: run.state, delivery });
    }
    return contextOutput(buildContextText(sessions, secrets));
  } catch (error) {
    await log(step, "internal", error);
    return null;
  }
}

// src/context.ts
var stateDir;
try {
  stateDir = resolveStateDir(process.env);
} catch {
  stateDir = null;
}
var output = await runContextHook({ stdin: process.stdin, stateDir, env: process.env });
if (output !== null) {
  process.stdout.on("error", () => {
  });
  process.stdout.write(`${output}
`);
}
