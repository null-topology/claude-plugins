/**
 * Container removal at shutdown. The server has 500 ms to exit, so it starts
 * one `docker rm -f` for all its containers as a detached process and returns
 * at once: the removal runs in its own process group, holds no stdio of the
 * server and keeps the server's event loop free, so it finishes after the
 * server has exited.
 *
 * The startup sweep removes what a dead server left behind by the launch
 * label, and waits for it. It also lists the containers labelled with this
 * host's id, to remove those whose labelled driver is dead.
 */
import { spawn } from 'node:child_process';
import { SidecarError } from '../errors.ts';
import type { Environment } from '../settings.ts';
import { isLaunchId } from '../store/paths.ts';
import { DOCKER_COMMAND, runDocker, stderrSummary, stripClaudeVariables } from './cli.ts';
import { CONTAINER_NAME_PREFIX, LABEL_DRIVER_PID, LABEL_DRIVER_START, LABEL_HOST, LABEL_LAUNCH } from './launch.ts';

/** How long the sweep waits for `docker rm -f`. */
const LABEL_REMOVE_TIMEOUT_MS = 30_000;

const NAME_PATTERN = new RegExp(`^${CONTAINER_NAME_PREFIX}[A-Za-z0-9][A-Za-z0-9_.-]*$`);

/** True for a name this plugin may remove: its prefix and docker name characters. */
export function isRemovableContainerName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/**
 * Starts a detached `docker rm -f <names>` and returns without waiting. Does
 * nothing for an empty list. A failure to start docker is ignored: there is
 * nobody left to report it to, and the startup sweep removes what is left.
 * Throws `TypeError` for a name outside this plugin's prefix.
 */
export function removeContainersDetached(
  names: readonly string[],
  env: Environment = process.env,
): void {
  for (const name of names) {
    if (!isRemovableContainerName(name)) {
      throw new TypeError(`Refusing to remove container ${JSON.stringify(name)}`);
    }
  }
  if (names.length === 0) {
    return;
  }
  const child = spawn(DOCKER_COMMAND, ['rm', '-f', ...names], {
    detached: true,
    stdio: 'ignore',
    env: stripClaudeVariables(env),
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

/**
 * Removes every container, running or not, that carries the launch label of
 * `launchId`, and waits. Returns the ids of the containers docker removed;
 * an empty list when there were none. Rejects `E_DOCKER` when docker cannot
 * list or remove them; a container already gone by the time it is removed
 * is fine, and is not among the ids. Throws `TypeError` for an invalid
 * launch id.
 */
export async function removeContainersByLabel(launchId: string, env: Environment = process.env): Promise<string[]> {
  if (!isLaunchId(launchId)) {
    throw new TypeError(`Invalid launch id ${JSON.stringify(launchId)}`);
  }
  const filter = `label=${LABEL_LAUNCH}=${launchId}`;
  const listed = await runDocker(['ps', '--all', '--quiet', '--no-trunc', '--filter', filter], {
    env: stripClaudeVariables(env),
  });
  if (listed.code !== 0) {
    throw new SidecarError(
      'E_DOCKER',
      `docker ps --filter ${filter} exited with code ${listed.code}: ${stderrSummary(listed.stderr)}`,
    );
  }
  return removeContainersById(outputLines(listed.stdout), env);
}

const CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/;

/**
 * Removes the containers with these ids, running or not, and waits. Returns
 * the ids docker printed as removed, which leaves out a container already
 * gone. Rejects `E_DOCKER` when docker fails for another reason. Throws
 * `TypeError` for a string that is not a container id.
 */
export async function removeContainersById(ids: readonly string[], env: Environment = process.env): Promise<string[]> {
  for (const id of ids) {
    if (!CONTAINER_ID_PATTERN.test(id)) {
      throw new TypeError(`Invalid container id ${JSON.stringify(id)}`);
    }
  }
  if (ids.length === 0) {
    return [];
  }
  const removed = await runDocker(['rm', '-f', ...ids], {
    env: stripClaudeVariables(env),
    timeoutMs: LABEL_REMOVE_TIMEOUT_MS,
  });
  if (removed.code !== 0 && !onlyGoneContainers(removed.stderr)) {
    throw new SidecarError(
      'E_DOCKER',
      `docker rm -f of ${ids.length} containers exited with code ${removed.code}: ${stderrSummary(removed.stderr)}`,
    );
  }
  // docker prints each container it removed, as it was named on the command line.
  const asked = new Set(ids);
  return outputLines(removed.stdout).filter((line) => asked.has(line));
}

const NO_SUCH_CONTAINER = /no such container/i;

/**
 * True when `docker rm` failed only on containers already gone: its stderr
 * has a line, and every line that is not blank is a "No such container"
 * error. Any other line is a failure on another container.
 */
function onlyGoneContainers(stderr: string): boolean {
  const lines = outputLines(stderr);
  return lines.length > 0 && lines.every((line) => NO_SUCH_CONTAINER.test(line));
}

/** A container labelled with a host id, with the run and the driver its labels name. */
export interface HostContainer {
  readonly id: string;
  /** Its launch label; null when that is missing or not a launch id. */
  readonly launchId: string | null;
  /** The driver pid and start time from its labels; null when they are missing or invalid. */
  readonly driver: { readonly pid: number; readonly startTime: string } | null;
}

const PID_LABEL_PATTERN = /^[1-9][0-9]*$/;

/**
 * Lists every container, running or not, labelled `kiro-sidecar.host` with
 * `hostId`. Rejects `E_DOCKER` when docker cannot list them.
 */
export async function listHostContainers(hostId: string, env: Environment = process.env): Promise<HostContainer[]> {
  const filter = `label=${LABEL_HOST}=${hostId}`;
  const format = [LABEL_LAUNCH, LABEL_DRIVER_PID, LABEL_DRIVER_START].map((label) => `{{.Label "${label}"}}`);
  const listed = await runDocker(['ps', '--all', '--no-trunc', '--filter', filter, '--format', ['{{.ID}}', ...format].join('\t')], {
    env: stripClaudeVariables(env),
  });
  if (listed.code !== 0) {
    throw new SidecarError(
      'E_DOCKER',
      `docker ps --filter ${filter} exited with code ${listed.code}: ${stderrSummary(listed.stderr)}`,
    );
  }
  const containers: HostContainer[] = [];
  for (const line of outputLines(listed.stdout)) {
    const [id = '', launchId = '', pid = '', startTime = ''] = line.split('\t').map((field) => field.trim());
    if (!CONTAINER_ID_PATTERN.test(id)) {
      continue;
    }
    containers.push({
      id,
      launchId: isLaunchId(launchId) ? launchId : null,
      driver: PID_LABEL_PATTERN.test(pid) && startTime !== '' ? { pid: Number(pid), startTime } : null,
    });
  }
  return containers;
}

function outputLines(stdout: string): string[] {
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}
