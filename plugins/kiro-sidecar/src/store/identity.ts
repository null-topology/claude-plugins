/**
 * Process identity and liveness.
 *
 * A process is named by {pid, startTime, hostId}. It is alive when a process
 * with that pid runs AND started at the recorded time, so a reused pid never
 * keeps a dead process alive. A record from another host is never judged:
 * its liveness is `other-host`.
 *
 * The host id is the hostname, the boot id and the pid-namespace inode on
 * Linux, and the hostname and the boot time on macOS. The start time is
 * field 22 of `/proc/<pid>/stat` on Linux and `ps -o lstart=` on macOS. The
 * macOS code is not exercised by the tests, which run on Linux.
 */

import { execFile } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { errorCode } from './files.ts';

const execFileAsync = promisify(execFile);

export interface ProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly hostId: string;
}

export type Liveness = 'alive' | 'dead' | 'other-host';

export function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isPid(record.pid) &&
    typeof record.startTime === 'string' &&
    record.startTime !== '' &&
    typeof record.hostId === 'string' &&
    record.hostId !== ''
  );
}

export function sameIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.startTime === b.startTime && a.hostId === b.hostId;
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** `pid-<pid>-<startTime>@<hostId>`: the key of the Claude process that owns a run. */
export function ownerKey(owner: ProcessIdentity): string {
  return `pid-${owner.pid}-${owner.startTime}@${owner.hostId}`;
}

const OWNER_KEY_PATTERN = /^pid-([0-9]+)-([^@]+)@(.+)$/;

/** The identity in an owner key, or null when the key is malformed. */
export function parseOwnerKey(key: string): ProcessIdentity | null {
  const match = OWNER_KEY_PATTERN.exec(key);
  if (match === null) {
    return null;
  }
  const [, pid = '', startTime = '', hostId = ''] = match;
  const identity = { pid: Number(pid), startTime, hostId };
  return isProcessIdentity(identity) ? identity : null;
}

export interface ProcStat {
  /** One-letter process state; `Z` is a zombie, `X` is dead. */
  readonly state: string;
  /** Start time in clock ticks after boot, as decimal digits. */
  readonly startTime: string;
}

/**
 * Parses the content of `/proc/<pid>/stat`. The command name in field 2 is
 * in parentheses and may itself hold spaces and parentheses, so the fields
 * are counted from the LAST `)`: the state (field 3) comes right after it,
 * the start time is field 22.
 */
export function parseProcStat(stat: string): ProcStat {
  const nameEnd = stat.lastIndexOf(')');
  if (nameEnd < 0) {
    throw new Error('Malformed /proc stat: no command name');
  }
  const fields = stat.slice(nameEnd + 1).trim().split(/\s+/);
  const state = fields[0];
  const startTime = fields[22 - 3];
  if (state === undefined || startTime === undefined || !/^[0-9]+$/.test(startTime)) {
    throw new Error('Malformed /proc stat: no start time');
  }
  return { state, startTime };
}

/** True when a process with this pid exists, including one we may not signal. */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

async function linuxStartTime(pid: number): Promise<string | null> {
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'ENOENT' && code !== 'ESRCH') {
      throw error;
    }
    // A process hidden from /proc (hidepid) must not pass for a dead one.
    if (pidExists(pid)) {
      throw new Error(`Cannot read the start time of process ${pid}`);
    }
    return null;
  }
  const { state, startTime } = parseProcStat(stat);
  return state === 'Z' || state === 'X' ? null : startTime;
}

// macOS only; not exercised by the tests. `ps` prints the start time in the
// caller's locale and time zone, so both are fixed to keep it comparable
// across processes. The value has its spaces replaced by `_`.
async function darwinStartTime(pid: number): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ps', ['-o', 'stat=', '-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }));
  } catch (error) {
    // `ps -p` exits 1 when no process has that pid.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
      return null;
    }
    throw error;
  }
  const [state, ...started] = stdout.trim().split(/\s+/);
  if (state === undefined || state === '' || started.length === 0) {
    return null;
  }
  return state.startsWith('Z') ? null : started.join('_');
}

/**
 * Start time of a running process, or null when no running process has this
 * pid (a zombie counts as not running).
 */
export async function processStartTime(pid: number): Promise<string | null> {
  if (!isPid(pid)) {
    throw new TypeError(`Invalid pid ${String(pid)}`);
  }
  switch (process.platform) {
    case 'linux':
      return linuxStartTime(pid);
    case 'darwin':
      return darwinStartTime(pid);
    default:
      throw new Error(`Unsupported platform ${process.platform}`);
  }
}

async function linuxHostId(): Promise<string> {
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const namespace = await readlink('/proc/self/ns/pid');
  const inode = /^pid:\[([0-9]+)\]$/.exec(namespace)?.[1];
  if (bootId === '' || inode === undefined) {
    throw new Error('Cannot read the boot id or the pid namespace');
  }
  return `${hostname()}:${bootId}:${inode}`;
}

// macOS only; not exercised by the tests.
async function darwinHostId(): Promise<string> {
  const { stdout } = await execFileAsync('sysctl', ['-n', 'kern.boottime']);
  const match = /sec = ([0-9]+), usec = ([0-9]+)/.exec(stdout);
  if (match === null) {
    throw new Error('Cannot read kern.boottime');
  }
  return `${hostname()}:${match[1]}.${match[2]}`;
}

let hostIdOnce: Promise<string> | undefined;

/** The id of this host; read once per process. */
export function localHostId(): Promise<string> {
  hostIdOnce ??= (async () => {
    switch (process.platform) {
      case 'linux':
        return linuxHostId();
      case 'darwin':
        return darwinHostId();
      default:
        throw new Error(`Unsupported platform ${process.platform}`);
    }
  })();
  return hostIdOnce;
}

/** Identity of a running process on this host, or null when it is not running. */
export async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  const startTime = await processStartTime(pid);
  return startTime === null ? null : { pid, startTime, hostId: await localHostId() };
}

async function requireIdentity(pid: number): Promise<ProcessIdentity> {
  const identity = await processIdentity(pid);
  if (identity === null) {
    throw new Error(`Process ${pid} is not running`);
  }
  return identity;
}

let driverOnce: Promise<ProcessIdentity> | undefined;

/** This process: the driver of the runs it starts. */
export function currentDriver(): Promise<ProcessIdentity> {
  driverOnce ??= requireIdentity(process.pid);
  return driverOnce;
}

/** The parent process: the Claude process that owns the runs started here. */
export function currentOwner(): Promise<ProcessIdentity> {
  return requireIdentity(process.ppid);
}

/**
 * Whether the process is alive. `other-host` when the record is from another
 * host (or another pid namespace), where this process cannot judge it.
 */
export async function liveness(identity: ProcessIdentity): Promise<Liveness> {
  if (identity.hostId !== (await localHostId())) {
    return 'other-host';
  }
  const startTime = await processStartTime(identity.pid);
  return startTime !== null && startTime === identity.startTime ? 'alive' : 'dead';
}
