// src/cli/main.ts
import { fstatSync, statSync } from "node:fs";

// src/mcp/broker-client.ts
import { lstatSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join as join2 } from "node:path";

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
function lineReader(stream, maxBytes = MAX_LINE_BYTES) {
  let max = maxBytes;
  const lines = [];
  let partial = [];
  let partialSize = 0;
  let ended = false;
  let failure;
  let wake;
  const notify = () => {
    const resolve2 = wake;
    wake = void 0;
    resolve2?.();
  };
  const tooLong = () => {
    failure = new FrameError(`No newline within ${max} bytes`);
    stream.off("data", onData);
    stream.pause();
  };
  const onData = (chunk) => {
    let bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10)) {
      if (partialSize + end > max) {
        tooLong();
        notify();
        return;
      }
      partial.push(bytes.subarray(0, end));
      lines.push(Buffer.concat(partial, partialSize + end).toString("utf8"));
      partial = [];
      partialSize = 0;
      bytes = bytes.subarray(end + 1);
    }
    partial.push(bytes);
    partialSize += bytes.length;
    if (partialSize > max) tooLong();
    notify();
  };
  const onEnd = () => {
    ended = true;
    notify();
  };
  stream.on("data", onData);
  stream.once("end", onEnd);
  stream.once("close", onEnd);
  stream.once("error", onEnd);
  return {
    async next() {
      for (; ; ) {
        const line = lines.shift();
        if (line !== void 0 && Buffer.byteLength(line) > max) tooLong();
        else if (line !== void 0) return line;
        if (failure !== void 0) throw failure;
        if (ended) return null;
        await new Promise((resolve2) => {
          wake = resolve2;
        });
      }
    },
    limit(bytes) {
      max = bytes;
      if (failure === void 0 && partialSize > max) {
        tooLong();
        notify();
      }
    }
  };
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
      const list = [];
      for (const a of accounts) {
        if (!isObject(a) || !isString(a["account"]) || typeof a["warm"] !== "boolean") return null;
        list.push({ account: a["account"], warm: a["warm"] });
      }
      return { ok: true, op, accounts: list, exitsAt };
    }
    case "fields": {
      const { vault, item, fields } = m;
      if (!isString(vault) || !isObject(item) || !isString(item["title"]) || !isString(item["category"]) || !Array.isArray(fields)) return null;
      const list = [];
      for (const f of fields) {
        const field = parseField(f);
        if (field === null) return null;
        list.push(field);
      }
      return { ok: true, op, vault, item: { title: item["title"], category: item["category"] }, fields: list };
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
      const list = [];
      for (const r of results) {
        if (!isObject(r) || !isString(r["ticket"])) return null;
        const result = r["result"];
        if (!RELEASE_RESULTS.includes(result)) return null;
        list.push({ ticket: r["ticket"], result });
      }
      return { ok: true, op, results: list };
    }
    case "end_session":
      return { ok: true, op };
  }
}
function encodeAck(op) {
  return encodeLine({ v: PROTOCOL_VERSION, op });
}

// src/mcp/broker-client.ts
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
function errorCode(err) {
  return err !== null && typeof err === "object" ? err.code : void 0;
}
function untrusted(path, reason) {
  return new BrokerError("untrusted", `Refusing to connect to the 1password-bridge broker socket ${path}: ${reason}.`);
}
function lstatIfPresent(lstat, path) {
  try {
    return lstat(path);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return void 0;
    throw err;
  }
}
function checkSocket(path, uid, lstat) {
  const dir = lstatIfPresent(lstat, dirname(path));
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
  const code = errorCode(err);
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

// src/cli/redeem.ts
var EXIT_CODES = {
  usage: 2,
  denied: 10,
  expired: 11,
  busy: 12,
  not_owner: 13,
  other_agent: 14,
  no_command: 15,
  unknown: 16,
  used: 17,
  voided: 18,
  field_gone: 19,
  broker_down: 20,
  not_delivered: 21
};
var OTHER_FAILURE_EXIT = 1;
var USAGE = "usage: op-bridge redeem <ticket>";
var BROKER_DOWN_MESSAGE = "The 1password-bridge broker is not reachable; if it stopped, its tickets are gone: call issue_tickets for a new one";
var PROTOCOL_MESSAGE = "The broker sent an answer op-bridge does not understand";
function exitFor(code) {
  return Object.hasOwn(EXIT_CODES, code) ? EXIT_CODES[code] : OTHER_FAILURE_EXIT;
}
function oneLine(s) {
  return s.replace(/\s+/g, " ").trim();
}
function writeOut(out, text) {
  return new Promise((resolve2) => {
    out.on("error", () => resolve2(false));
    try {
      out.write(text, (err) => resolve2(err === null || err === void 0));
    } catch {
      resolve2(false);
    }
  });
}
async function finish(socket, closed, ack) {
  if (!socket.destroyed) socket.end(encodeAck(ack));
  await closed;
}
async function runCli(argv, io) {
  const failed = (code, message) => {
    io.writeError(`op-bridge: ${code}: ${oneLine(message)}`);
    return exitFor(code);
  };
  const ticket = argv[1];
  if (argv.length !== 2 || argv[0] !== "redeem" || ticket === void 0 || !TICKET_ID_PATTERN.test(ticket)) {
    io.writeError(USAGE);
    return EXIT_CODES.usage;
  }
  const session = io.env["CLAUDE_CODE_SESSION_ID"];
  if (session === void 0 || session === "") {
    return failed("not_owner", "CLAUDE_CODE_SESSION_ID is not set; run op-bridge inside a Bash command of the Claude Code session that issued the ticket");
  }
  if (!isSessionId(session)) {
    return failed("not_owner", "CLAUDE_CODE_SESSION_ID is not a Claude Code session id; run op-bridge inside a Bash command of the Claude Code session that issued the ticket");
  }
  if (io.stdoutDiscarded()) {
    return failed("usage", 'stdout is closed or /dev/null, so the value would be lost; nothing was sent: capture it with "$(op-bridge redeem <ticket>)"');
  }
  let socket;
  try {
    const stateDir = io.env["OP_BRIDGE_STATE_DIR"] || resolveStateDir(io.env);
    socket = await connectSocket(brokerSocketPath(stateDir, io.env));
  } catch (err) {
    if (err instanceof BrokerError && err.code === "untrusted") return failed("untrusted", err.message);
    return failed("broker_down", BROKER_DOWN_MESSAGE);
  }
  socket.on("error", () => {
  });
  const closed = new Promise((resolve2) => socket.once("close", () => resolve2()));
  const lines = lineReader(socket);
  socket.write(encodeLine({ v: PROTOCOL_VERSION, op: "redeem", ticket, session }));
  const line = await lines.next().catch(() => void 0);
  if (line === null) {
    socket.destroy();
    return failed("broker_down", BROKER_DOWN_MESSAGE);
  }
  const response = line === void 0 ? null : parseResponse(line, "redeem");
  if (response === null || response.ok && response.op !== "redeem") {
    socket.destroy();
    return failed("protocol", PROTOCOL_MESSAGE);
  }
  if (!response.ok) {
    socket.destroy();
    return failed(response.code, response.message);
  }
  socket.write(encodeAck("received"));
  const written = await writeOut(io.stdout, response.value);
  await finish(socket, closed, written ? "delivered" : "not_delivered");
  return written ? 0 : failed("not_delivered", "Delivering the value to stdout failed; the ticket can be redeemed again while its 10 minutes last and it was not released");
}

// src/cli/main.ts
function stdoutDiscarded() {
  let out;
  try {
    out = fstatSync(1);
  } catch {
    return true;
  }
  if (!out.isCharacterDevice()) return false;
  try {
    return out.rdev === statSync("/dev/null").rdev;
  } catch {
    return false;
  }
}
process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: process.stdout,
  stdoutDiscarded,
  writeError: (line) => process.stderr.write(`${line}
`)
});
