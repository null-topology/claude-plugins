/**
 * Entry of `dist/broker.js`, started detached by the MCP server
 * (mcp/broker-client.ts). It wires the real 1Password SDK, the platform
 * approval window, the state directory and `process.exit` into the broker
 * (service.ts) and does nothing else.
 */

import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveStateDir, socketPath } from '../paths.ts';
import { platformDialog, runCommand } from './dialog.ts';
import { connectDesktop } from './onepassword.ts';
import { idleWindowMs, openBrokerLog, startBroker } from './service.ts';

function errorCode(err: unknown): string {
  if (err !== null && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name)) return name;
  }
  return 'unknown';
}

const env = process.env;
const stateDir = resolveStateDir(env);
const log = openBrokerLog(stateDir);
// The bundle lives in <plugin root>/dist/.
const pluginRoot = fileURLToPath(new URL('..', import.meta.url));

startBroker({
  socketPath: socketPath(stateDir, process.getuid?.() ?? 0, tmpdir(), env['XDG_RUNTIME_DIR']),
  stateDir,
  connect: (account) => connectDesktop(account),
  dialog: platformDialog(runCommand, process.platform, pluginRoot),
  lang: env['OP_BRIDGE_LANGUAGE'],
  idleMs: idleWindowMs(env['OP_BRIDGE_IDLE_MINUTES']),
  exit: (code) => process.exit(code),
  log,
}).catch((err: unknown) => {
  // The error message may quote a path; the log keeps the code only.
  log('fatal', { code: errorCode(err) });
  process.exit(1);
});
