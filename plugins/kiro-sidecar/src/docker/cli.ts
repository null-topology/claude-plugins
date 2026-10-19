/**
 * Running the Docker CLI: its environment and a bounded call that collects
 * the output.
 *
 * The CLI gets the server's environment without any `CLAUDE_*` variable. What
 * reaches a container is decided by the `-e` names on the `docker run`
 * command line, never by this environment as a whole.
 */
import { execFile } from 'node:child_process';
import { SidecarError } from '../errors.ts';
import type { Environment } from '../settings.ts';

export const DOCKER_COMMAND = 'docker';

/** Variables with this prefix belong to Claude Code and never reach the Docker CLI. */
export const STRIPPED_ENV_PREFIX = 'CLAUDE_';

/** The variable that carries the Kiro token from the Docker CLI into the container. */
export const TOKEN_VARIABLE = 'KIRO_API_KEY';

/** How long a Docker CLI query may take before it fails with `E_DOCKER`. */
export const DOCKER_QUERY_TIMEOUT_MS = 15_000;

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_IN_MESSAGE = 500;

/** The server environment without `CLAUDE_*` variables and without unset entries. */
export function stripClaudeVariables(env: Environment): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !name.startsWith(STRIPPED_ENV_PREFIX)) {
      result[name] = value;
    }
  }
  return result;
}

/**
 * The environment of a `docker run` CLI process: the server environment
 * without `CLAUDE_*` variables, with `KIRO_API_KEY` set to the token. The
 * token travels here, never in an argument.
 */
export function dockerCliEnvironment(env: Environment, token: string): Record<string, string> {
  return { ...stripClaudeVariables(env), [TOKEN_VARIABLE]: token };
}

export interface DockerResult {
  /** The exit code; a non-zero code is returned, not thrown. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DockerCallOptions {
  /** The complete environment of the CLI process. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/**
 * The `E_DOCKER` error of a call that found no `docker` on PATH: there is no
 * Docker CLI on this host, as opposed to a CLI whose daemon fails.
 */
export class DockerNotFoundError extends SidecarError {
  constructor() {
    super('E_DOCKER', 'the docker CLI was not found on PATH');
    this.name = 'DockerNotFoundError';
  }
}

/**
 * Runs `docker <args>` and collects its output. Throws `E_DOCKER` when the CLI
 * cannot be started ({@link DockerNotFoundError} when it is not on PATH) or
 * does not finish in time; a non-zero exit is returned.
 */
export function runDocker(args: readonly string[], options: DockerCallOptions): Promise<DockerResult> {
  const timeoutMs = options.timeoutMs ?? DOCKER_QUERY_TIMEOUT_MS;
  const label = commandLabel(args);
  return new Promise((resolve, reject) => {
    execFile(
      DOCKER_COMMAND,
      [...args],
      {
        env: { ...options.env },
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        if (typeof error.code === 'number') {
          resolve({ code: error.code, stdout, stderr });
          return;
        }
        if (error.code === 'ENOENT') {
          reject(new DockerNotFoundError());
          return;
        }
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new SidecarError('E_DOCKER', `${label} printed more than ${MAX_OUTPUT_BYTES} bytes`));
          return;
        }
        if (error.killed === true) {
          reject(new SidecarError('E_DOCKER', `${label} did not finish within ${timeoutMs} ms`));
          return;
        }
        reject(new SidecarError('E_DOCKER', `${label} failed: ${error.message}`));
      },
    );
  });
}

/** `docker` and its subcommand words, without flags or values. */
function commandLabel(args: readonly string[]): string {
  const words = ['docker'];
  for (const arg of args.slice(0, 2)) {
    if (arg.startsWith('-')) {
      break;
    }
    words.push(arg);
  }
  return words.join(' ');
}

/** The first part of a CLI's stderr, trimmed, for an error message. */
export function stderrSummary(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed === '') {
    return 'no error output';
  }
  return trimmed.length > MAX_STDERR_IN_MESSAGE
    ? `${trimmed.slice(0, MAX_STDERR_IN_MESSAGE)}...`
    : trimmed;
}
