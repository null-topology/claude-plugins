/**
 * SessionStart dependency check: what issuing and redeeming tickets need on
 * this machine, and how to fix what is missing. Nothing here runs a program;
 * it only looks for files.
 *
 * The 1Password library locations are the SDK's own search list
 * (`@1password/sdk` `shared_lib_core.js`); the window backends are the ones
 * the approval dialog uses: `osascript` on macOS, `zenity` on Linux.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Environment } from '../paths.ts';
import { SDK_INTEGRATION_SETTING } from '../strings.ts';
import type { HookOutput } from './common.ts';

export interface SystemProbe {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** True when `path` is a regular file, following symlinks. */
  isFile(path: string): boolean;
  /** True when `path` is a regular file this process may execute. */
  isExecutable(path: string): boolean;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export const SYSTEM_PROBE: SystemProbe = {
  platform: process.platform,
  get home() {
    return homedir();
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
  },
};

const MAC_LIBRARY = '/Applications/1Password.app/Contents/Frameworks/libop_sdk_ipc_client.dylib';
const LINUX_LIBRARY_DIRS = ['/usr/bin/1password', '/opt/1Password', '/snap/bin/1password'];
const LINUX_LIBRARY = 'libop_sdk_ipc_client.so';
const INTEGRATION = `then turn on ${SDK_INTEGRATION_SETTING} in the app`;

function onPath(command: string, env: Environment, probe: SystemProbe): boolean {
  const dirs = (env['PATH'] ?? '').split(delimiter).filter((dir) => dir !== '');
  return dirs.some((dir) => probe.isExecutable(join(dir, command)));
}

/**
 * A missing dependency: its sentence, and what it stops. Without the window
 * only redeeming stops (issuing opens no window); without the app or on an
 * unsupported platform, issuing stops as well.
 */
export interface MissingDependency {
  readonly text: string;
  readonly stops: 'redeem' | 'all';
}

/** One entry per missing dependency; empty when tickets can be issued and redeemed. */
export function missingDependencies(env: Environment, probe: SystemProbe): MissingDependency[] {
  const missing: MissingDependency[] = [];
  switch (probe.platform) {
    case 'darwin': {
      if (!probe.isExecutable('/usr/bin/osascript')) {
        missing.push({
          text: '/usr/bin/osascript is missing, so the approval window cannot open; it ships with macOS, so check the system installation.',
          stops: 'redeem',
        });
      }
      if (!probe.isFile(MAC_LIBRARY) && !probe.isFile(join(probe.home, MAC_LIBRARY))) {
        missing.push({
          text: `the 1Password desktop app was not found (no libop_sdk_ipc_client.dylib in /Applications/1Password.app or ~/Applications/1Password.app); install 1Password 8 for Mac, ${INTEGRATION}.`,
          stops: 'all',
        });
      }
      break;
    }
    case 'linux': {
      if (!onPath('zenity', env, probe)) {
        missing.push({
          text: 'zenity is not on PATH, so the approval window cannot open; install it with the package manager (for example `apt install zenity` or `dnf install zenity`).',
          stops: 'redeem',
        });
      }
      if (!LINUX_LIBRARY_DIRS.some((dir) => probe.isFile(join(dir, LINUX_LIBRARY)))) {
        missing.push({
          text: `the 1Password desktop app was not found (no ${LINUX_LIBRARY} in ${LINUX_LIBRARY_DIRS.join(', ')}); install the 1Password 8 desktop app, ${INTEGRATION}.`,
          stops: 'all',
        });
      }
      break;
    }
    default:
      missing.push({ text: `this platform (${probe.platform}) is not supported; only macOS and Linux are.`, stops: 'all' });
  }
  return missing;
}

/** The SessionStart output for `missing`: shown to the user and given to the model; nothing when empty. */
export function diagnosticsOutput(missing: readonly MissingDependency[]): HookOutput | undefined {
  if (missing.length === 0) return undefined;
  const message = `1password-bridge: ${missing.map((m) => m.text).join(' ')}`;
  const effect = missing.some((m) => m.stops === 'all')
    ? '1password-bridge tickets cannot be issued or redeemed.'
    : '1password-bridge tickets can be issued but not redeemed: every redeem needs the approval window.';
  return {
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `${message} Until this is fixed, ${effect}`,
    },
  };
}
