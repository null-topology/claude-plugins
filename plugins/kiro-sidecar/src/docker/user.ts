/**
 * The `--user` of a container: the `docker_user` setting, where `auto` is
 * decided from the daemon.
 *
 * `auto` is `0:0` on a rootless daemon and on Docker Desktop, where uid 0 in
 * the container maps to the invoking user. On a rootful Linux daemon uid 0 is
 * the host's root, so `auto` refuses with `E_DOCKER` and asks for an explicit
 * user.
 */
import { SidecarError } from '../errors.ts';
import { envName } from '../settings.ts';
import type { Environment } from '../settings.ts';
import { InvalidInputError } from '../text/errors.ts';
import { runDocker, stderrSummary, stripClaudeVariables } from './cli.ts';

export const AUTO_DOCKER_USER = 'auto';

/** The user `auto` resolves to where uid 0 maps to the invoking user. */
export const MAPPED_ROOT_USER = '0:0';

const USER_PART = '(?:[0-9]{1,10}|[A-Za-z_][A-Za-z0-9_.-]{0,31})';
const EXPLICIT_USER_PATTERN = new RegExp(`^${USER_PART}(?::${USER_PART})?$`);

const ROOTLESS_OPTION = 'name=rootless';
const DOCKER_DESKTOP_OS = 'Docker Desktop';
const DOCKER_DESKTOP_LABEL_PREFIX = 'com.docker.desktop.address=';

/** The parts of `docker info` that decide `auto`. */
export interface DockerInfo {
  readonly securityOptions: readonly string[];
  readonly operatingSystem: string;
  readonly labels: readonly string[];
}

/**
 * True for a user `--user` accepts as given: a uid or a name, optionally
 * followed by `:` and a gid or a group name. `auto` is not an explicit user.
 */
export function isExplicitDockerUser(value: string): boolean {
  return value !== AUTO_DOCKER_USER && EXPLICIT_USER_PATTERN.test(value);
}

/** Throws `E_INVALID` (field `docker_user`) unless `value` is an explicit user. */
export function assertExplicitDockerUser(value: string): void {
  if (!isExplicitDockerUser(value)) {
    throw new InvalidInputError(
      'docker_user',
      `must be "auto" resolved to a user, or "<uid>[:<gid>]" or "<name>[:<group>]", got ${JSON.stringify(value)}`,
    );
  }
}

/** Reads the output of `docker info --format '{{json .}}'`. Throws `E_DOCKER`. */
export function parseDockerInfo(json: string): DockerInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SidecarError('E_DOCKER', 'docker info did not print JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SidecarError('E_DOCKER', 'docker info did not print a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const serverErrors = stringList(record.ServerErrors);
  if (serverErrors.length > 0) {
    throw new SidecarError('E_DOCKER', `docker info reported: ${serverErrors.join('; ')}`);
  }
  return Object.freeze({
    securityOptions: Object.freeze(stringList(record.SecurityOptions)),
    operatingSystem: typeof record.OperatingSystem === 'string' ? record.OperatingSystem : '',
    labels: Object.freeze(stringList(record.Labels)),
  });
}

/** True when a security option names `rootless` (`name=rootless`). */
export function isRootlessDaemon(info: DockerInfo): boolean {
  return info.securityOptions.some((option) => option.split(',').includes(ROOTLESS_OPTION));
}

/** True for Docker Desktop: its operating system name or its desktop address label. */
export function isDockerDesktop(info: DockerInfo): boolean {
  return (
    info.operatingSystem === DOCKER_DESKTOP_OS ||
    info.labels.some((label) => label.startsWith(DOCKER_DESKTOP_LABEL_PREFIX))
  );
}

/** What `auto` means on this daemon: `0:0`, or `E_DOCKER` on a rootful daemon. */
export function autoDockerUser(info: DockerInfo): string {
  if (isRootlessDaemon(info) || isDockerDesktop(info)) {
    return MAPPED_ROOT_USER;
  }
  throw new SidecarError(
    'E_DOCKER',
    `docker_user "auto" is refused on a rootful Docker daemon (neither rootless nor ` +
      `Docker Desktop), where uid 0 in the container is root on the host: set ` +
      `${envName('docker_user')} to an explicit "<uid>:<gid>"`,
  );
}

/** Runs `docker info` and reads it. Throws `E_DOCKER` when the daemon cannot answer. */
export async function readDockerInfo(env: Environment = process.env): Promise<DockerInfo> {
  const result = await runDocker(['info', '--format', '{{json .}}'], {
    env: stripClaudeVariables(env),
  });
  if (result.code !== 0) {
    throw new SidecarError('E_DOCKER', `docker info failed: ${stderrSummary(result.stderr)}`);
  }
  return parseDockerInfo(result.stdout);
}

/**
 * The container user for a `docker_user` value: an explicit user as given
 * (`E_INVALID` when malformed), or for `auto` the user decided from
 * `docker info` (`E_DOCKER` on a rootful daemon or when docker fails).
 */
export async function resolveDockerUser(
  setting: string,
  env: Environment = process.env,
): Promise<string> {
  if (setting !== AUTO_DOCKER_USER) {
    assertExplicitDockerUser(setting);
    return setting;
  }
  return autoDockerUser(await readDockerInfo(env));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
