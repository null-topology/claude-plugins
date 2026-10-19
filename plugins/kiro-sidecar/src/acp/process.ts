/**
 * A child process with piped stdio that runs an ACP agent.
 *
 * The handle is argv-generic: it knows nothing about Kiro, local or docker
 * mode. It owns the child's lifetime: stderr is passed as raw byte chunks to
 * a caller-given callback, the exit is observed once, and `kill()` escalates
 * from SIGTERM to SIGKILL after a grace period.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** What to run: argv[0] is the command, the rest are its arguments. */
export interface ProcessSpec {
  readonly argv: readonly string[];
  /** The complete environment of the child; nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /**
   * Starts the child as the leader of its own process group (POSIX only), so
   * that `kill()` signals the child with every process it started. When the
   * leader ends by any route, what is left of its group gets SIGTERM and,
   * after the grace period, SIGKILL; a server that exits before the grace
   * period ends kills what is left at once (`killProcessGroups`).
   */
  readonly processGroup?: boolean;
}

/** How the process ended. `error` is set when it could not be started. */
export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

export interface ProcessOptions {
  /**
   * Receives stderr as it arrives: raw byte chunks, neither decoded, split
   * nor cut. The bytes are the child's output and may hold secrets: they are
   * redacted before any use.
   */
  readonly onStderr?: (chunk: Buffer) => void;
  /** Time between SIGTERM and SIGKILL in `kill()`. */
  readonly killGraceMs?: number;
}

export const DEFAULT_KILL_GRACE_MS = 5_000;

/** A running (or finished) child process. */
export class ProcessHandle {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #graceMs: number;
  readonly #group: boolean;
  readonly #exited: Promise<ProcessExit>;
  #exit: ProcessExit | undefined;
  #killing: Promise<ProcessExit> | undefined;

  constructor(spec: ProcessSpec, options: ProcessOptions = {}) {
    const [command, ...args] = spec.argv;
    if (command === undefined || command === '') {
      throw new TypeError('ProcessSpec.argv must name a command');
    }
    this.#graceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.#group = spec.processGroup === true && process.platform !== 'win32';
    this.#child = spawn(command, args, {
      cwd: spec.cwd,
      env: { ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // On POSIX a detached child runs in a new session, as its process group leader.
      detached: this.#group,
    });
    if (this.#group && this.#child.pid !== undefined) {
      liveGroups.add(this.#child.pid);
    }
    this.#exited = new Promise((resolve) => {
      const settle = (exit: ProcessExit): void => {
        if (this.#exit === undefined) {
          this.#exit = Object.freeze(exit);
          resolve(this.#exit);
        }
      };
      this.#child.once('exit', (code, signal) => {
        settle({ code, signal });
        this.#sweepGroup();
      });
      this.#child.on('error', (error) => {
        // 'error' after a successful spawn means a failed kill or write; the
        // exit is still reported by 'exit'. Before spawn there is no 'exit'.
        if (this.#child.pid === undefined) {
          settle({ code: null, signal: null, error });
        }
      });
    });
    // A write to a dead child fails with EPIPE; the ACP stream sees the failure.
    this.#child.stdin.on('error', () => {});
    forwardChunks(this.#child.stderr, options.onStderr);
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get stdin(): Writable {
    return this.#child.stdin;
  }

  get stdout(): Readable {
    return this.#child.stdout;
  }

  /** Resolves once, when the process has ended or failed to start. */
  get exited(): Promise<ProcessExit> {
    return this.#exited;
  }

  /** The exit, once known. */
  get exit(): ProcessExit | undefined {
    return this.#exit;
  }

  /**
   * Sends SIGTERM, then SIGKILL if the process is still running after the
   * grace period. Resolves with the exit. Repeated calls share one escalation.
   */
  kill(graceMs: number = this.#graceMs): Promise<ProcessExit> {
    if (this.#exit !== undefined) {
      return this.#exited;
    }
    if (this.#killing === undefined) {
      this.#signal('SIGTERM');
      const timer = setTimeout(() => {
        if (this.#exit === undefined) {
          this.#signal('SIGKILL');
        }
      }, graceMs);
      this.#killing = this.#exited.finally(() => clearTimeout(timer));
    }
    return this.#killing;
  }

  /** Signals the child, or its whole process group when it leads one. */
  #signal(signal: NodeJS.Signals): void {
    const pid = this.#child.pid;
    if (this.#group && pid !== undefined) {
      signalGroup(pid, signal);
    } else {
      this.#child.kill(signal);
    }
  }

  /**
   * After the leader has ended, ends what is left of its group: SIGTERM now,
   * SIGKILL after the grace period if the group still exists then.
   */
  #sweepGroup(): void {
    const pid = this.#child.pid;
    if (!this.#group || pid === undefined) {
      return;
    }
    if (!signalGroup(pid, 'SIGTERM')) {
      liveGroups.delete(pid);
      return;
    }
    const timer = setTimeout(() => {
      if (signalGroup(pid, 0)) {
        signalGroup(pid, 'SIGKILL');
      }
      liveGroups.delete(pid);
    }, this.#graceMs);
    timer.unref();
  }
}

/** Process groups led by children started here that may still have members. */
const liveGroups = new Set<number>();

/**
 * Sends SIGKILL to every process group started here that still exists,
 * synchronously, so it can run in an `exit` handler: what is left of a group
 * does not outlive the server while its sweep waits out the grace period.
 */
export function killProcessGroups(): void {
  for (const pgid of liveGroups) {
    signalGroup(pgid, 'SIGKILL');
  }
  liveGroups.clear();
}

/** Sends `signal` to process group `pgid`; false when no process of the group could be signalled. */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    // ESRCH: the group is empty.
    return false;
  }
}

/** Starts a child process. */
export function spawnProcess(spec: ProcessSpec, options: ProcessOptions = {}): ProcessHandle {
  return new ProcessHandle(spec, options);
}

/** Passes every chunk of a stream to `onChunk` as it arrives; always drains it so the child never blocks. */
function forwardChunks(stream: Readable, onChunk: ((chunk: Buffer) => void) | undefined): void {
  stream.on('data', (chunk: Buffer) => onChunk?.(chunk));
  stream.on('error', () => {});
}
