/**
 * The `docker run` command line and CLI environment of one Kiro session in
 * docker mode.
 *
 * The Kiro home mounts come first: the shared home read-write at the
 * container's Kiro home, then the run's own `skills/` and `steering/`
 * read-only over the home's, always, also when they are empty. The caller
 * creates those directories, and the home's `skills/` and `steering/` that
 * serve as mount targets, before the command is built.
 *
 * The work directory is mounted at its own absolute path, read-write unless
 * it is given read-only, and is the container's working directory. A linked
 * git worktree or a submodule also gets its repository's git common dir
 * mounted read-only when that dir lies outside the work directory, and
 * each custom mount follows. Every mount source is resolved and the whole set
 * is checked (`./mounts.ts`) before the command is built. The token reaches
 * the container only as `-e KIRO_API_KEY`: by name on the command line, with
 * the value in the CLI process environment. Each proxy variable the `proxy`
 * and `no_proxy` settings set is passed the same way. Nothing of the server
 * environment reaches the container, its proxy variables included. The
 * run's copy of `prompt_file`, when there is one, is mounted last,
 * read-only, at the container's task file.
 *
 * Every container carries labels naming its run, its owner and the driver
 * process, so that containers left behind can be found by label. Labels are
 * visible to every docker user of the host: a label value that the run's
 * secret set would redact fails the launch.
 */
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { PROXY_VARIABLES } from '../settings.ts';
import type { Environment, ProxyEnvironment, ProxyVariable } from '../settings.ts';
import type { ProcessIdentity } from '../store/identity.ts';
import { isLaunchId } from '../store/paths.ts';
import { InvalidInputError } from '../text/errors.ts';
import { assertKiroToken } from '../text/redact.ts';
import type { SecretSet } from '../text/redact.ts';
import { DOCKER_COMMAND, TOKEN_VARIABLE, dockerCliEnvironment } from './cli.ts';
import {
  CONTAINER_HOME,
  CONTAINER_KIRO_HOME,
  CONTAINER_TASK_FILE,
  CONTAINER_TOOL_SERVER_FILE,
  bindMountArgument,
  formatMountSpec,
  isAtOrBelow,
  isMountSafe,
  mountArgument,
  stateDirMask,
  tmpfsMountArgument,
  validateMountSet,
} from './mounts.ts';
import type { MountSpec, ResolvedMount } from './mounts.ts';
import { assertExplicitDockerUser } from './user.ts';

export { CONTAINER_HOME, CONTAINER_KIRO_HOME, CONTAINER_TASK_FILE, CONTAINER_TOOL_SERVER_FILE };

/** The labels of every container, in `--label` order. */
export const LABEL_LAUNCH = 'kiro-sidecar.launch';
export const LABEL_OWNER = 'kiro-sidecar.owner';
export const LABEL_DRIVER_PID = 'kiro-sidecar.driver-pid';
export const LABEL_DRIVER_START = 'kiro-sidecar.driver-start';
export const LABEL_HOST = 'kiro-sidecar.host';

/** The prompt of a docker start with `prompt_file`: Kiro reads the task from the mounted copy. */
export const TASK_FILE_PROMPT = `Read the task in ${CONTAINER_TASK_FILE} and carry it out.`;

/** Where the run's skill copies are mounted, over the home's `skills/`. */
export const CONTAINER_KIRO_SKILLS = `${CONTAINER_KIRO_HOME}/skills`;

/** Where the run's steering copies are mounted, over the home's `steering/`. */
export const CONTAINER_KIRO_STEERING = `${CONTAINER_KIRO_HOME}/steering`;

/** Every container of this plugin is named with this prefix. */
export const CONTAINER_NAME_PREFIX = 'kiro-sidecar-';

export const KIRO_ENTRYPOINT = 'kiro-cli';

export const KIRO_ARGS: readonly string[] = Object.freeze(['acp', '--agent-engine', 'v3']);

/**
 * `-e` entries of every container: the home, the token by name, git's
 * `safe.directory=*` for any uid and home, and no optional git locks.
 */
const FIXED_ENV_ENTRIES: readonly string[] = Object.freeze([
  `HOME=${CONTAINER_HOME}`,
  TOKEN_VARIABLE,
  'GIT_CONFIG_COUNT=1',
  'GIT_CONFIG_KEY_0=safe.directory',
  'GIT_CONFIG_VALUE_0=*',
  'GIT_OPTIONAL_LOCKS=0',
]);

/** The refusal of a path the `--mount` syntax would misread. */
const MOUNT_UNSAFE_RULE = 'must not contain a comma, a double quote or a control character';

/** The first line of a `.git` file that points to the git dir. */
const GITDIR_PREFIX = 'gitdir: ';

/** A local image reference that cannot be read as an option. */
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,511}$/;

/** A launch: run `command` with `args` and exactly `env` as its environment. */
export interface DockerLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** The container name, for removing the container at shutdown. */
  readonly containerName: string;
  /** The work directory after resolution, mounted at the same path. */
  readonly dir: string;
}

export interface DockerLaunchOptions {
  /** The run id, `ks_` and 12 hex digits. */
  readonly launchId: string;
  /**
   * The run's mounts as {@link resolveMountSet} resolved and checked them,
   * mounted as they are: the launch does not resolve them again.
   */
  readonly mountSet: MountSet;
  /** An explicit user (`auto` must be resolved first). */
  readonly user: string;
  readonly image: string;
  /** The Kiro token; it is put in the CLI environment only. */
  readonly token: string;
  /** The server environment. */
  readonly env?: Environment;
  /**
   * The proxy variables of the `proxy` and `no_proxy` settings
   * (`proxySettingsEnvironment`); omitted is none. Like the token, each is
   * passed by name with its value in the CLI environment.
   */
  readonly proxy?: ProxyEnvironment;
  /** The host directories of the Kiro home mounts. */
  readonly kiroHome: KiroHomeSources;
  /** The run's copy of `prompt_file`, a regular file; omitted is no task file. */
  readonly taskFile?: string;
  /**
   * The plugin's tool server `sidecar-tools.js`, a regular file, mounted
   * read-only at {@link CONTAINER_TOOL_SERVER_FILE}; omitted is no mount.
   */
  readonly toolServerFile?: string;
  /** Who runs the container, for its labels. */
  readonly owner: ContainerOwner;
  /** The run's secret set: no label value may hold a secret. */
  readonly secrets: SecretSet;
}

/** The identities a container is labelled with. */
export interface ContainerOwner {
  /** The owner key of the run (`ownerKey`). */
  readonly ownerKey: string;
  /** The driver process of the run. */
  readonly driver: ProcessIdentity;
}

/** The host directories of the Kiro home mounts; each must already exist. */
export interface KiroHomeSources {
  /** The shared home, mounted read-write at the container's Kiro home. */
  readonly home: string;
  /** The run's skill copies, mounted read-only over the home's `skills/`. */
  readonly skills: string;
  /** The run's steering copies, mounted read-only over the home's `steering/`. */
  readonly steering: string;
}

/** A bind mount whose destination is a fixed container path. */
interface FixedMount {
  readonly source: string;
  readonly destination: string;
  readonly readOnly: boolean;
}

/** The container name of a run: the prefix and the 12 hex digits of its id. */
export function containerName(launchId: string): string {
  if (!isLaunchId(launchId)) {
    throw new TypeError(`Invalid launch id ${JSON.stringify(launchId)}`);
  }
  return CONTAINER_NAME_PREFIX + launchId.slice('ks_'.length);
}

/**
 * The labels of a run's container, in order: the launch id, the owner key,
 * the driver's pid, start time and host id. A value that holds a secret of
 * `secrets` is a plain error.
 */
export function containerLabels(launchId: string, owner: ContainerOwner, secrets: SecretSet): Array<[string, string]> {
  const labels: Array<[string, string]> = [
    [LABEL_LAUNCH, launchId],
    [LABEL_OWNER, owner.ownerKey],
    [LABEL_DRIVER_PID, String(owner.driver.pid)],
    [LABEL_DRIVER_START, owner.driver.startTime],
    [LABEL_HOST, owner.driver.hostId],
  ];
  for (const [key, value] of labels) {
    if (secrets.redact(value) !== value) {
      throw new Error(`The container label ${key} holds a secret`);
    }
  }
  return labels;
}

/** Throws `E_INVALID` (field `image`) unless `image` is a plain image reference. */
export function assertDockerImage(image: string): void {
  if (!IMAGE_PATTERN.test(image)) {
    throw new InvalidInputError(
      'image',
      `must be an image reference such as "name:tag", got ${JSON.stringify(image)}`,
    );
  }
}

/**
 * Resolves the work directory with `realpath` and checks it: the given path
 * is absolute, it exists, it is a directory and not `/`. Every failure is
 * `E_INVALID` naming the field `dir`. Both modes use it.
 */
export async function resolveWorkDir(dir: string): Promise<string> {
  if (!isAbsolute(dir)) {
    throw new InvalidInputError('dir', `must be an absolute path, got ${JSON.stringify(dir)}`);
  }
  let resolved: string;
  try {
    resolved = await realpath(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new InvalidInputError('dir', `does not exist: ${JSON.stringify(dir)}`);
    }
    throw new InvalidInputError(
      'dir',
      `cannot be resolved (${code ?? 'unknown error'}): ${JSON.stringify(dir)}`,
    );
  }
  if (resolved === '/') {
    throw new InvalidInputError('dir', `must not be the root directory, got ${JSON.stringify(dir)}`);
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new InvalidInputError('dir', `must be a directory, got ${JSON.stringify(dir)}`);
  }
  return resolved;
}

/**
 * Resolves a work directory that is mounted into a container: the checks of
 * {@link resolveWorkDir}, and neither the given nor the resolved path holds a
 * character the `--mount` syntax interprets.
 */
export async function resolveMountDir(dir: string): Promise<string> {
  if (isAbsolute(dir)) {
    assertMountSafe(dir);
  }
  const resolved = await resolveWorkDir(dir);
  assertMountSafe(resolved);
  return resolved;
}

/** The mounts of a run before resolution. */
export interface MountRequest {
  /** The work directory, without a `:ro` suffix. */
  readonly dir: string;
  readonly dirReadOnly?: boolean;
  readonly mounts?: readonly MountSpec[];
  /**
   * The plugin's state directory: nothing may be mounted at or inside it,
   * and an empty tmpfs covers it when a mount holds it.
   */
  readonly stateDir: string;
}

/** The mounts of a run after resolution and the set checks. */
export interface MountSet {
  /** The resolved work directory. */
  readonly dir: string;
  readonly dirReadOnly: boolean;
  /**
   * The repository's git common dir when the work directory is a linked git
   * worktree or a submodule ({@link gitCommonDir}) and that dir lies outside
   * the work directory, else null.
   */
  readonly gitCommonDir: string | null;
  /** The custom mounts with resolved paths, in the given order. */
  readonly mounts: readonly MountSpec[];
  /** Every mount in `--mount` order: the work directory, the git common dir, the custom mounts. */
  readonly all: readonly ResolvedMount[];
  /** The resolved state directory when a mount of the set holds it, else null; an empty tmpfs covers it. */
  readonly stateMask: string | null;
}

/**
 * Resolves every mount of a run and checks the set (`validateMountSet`,
 * `stateDirMask`). The work directory gets the checks of
 * {@link resolveMountDir}; a custom mount source must be absolute, exist (a
 * file or a directory), not be `/`, and hold no character the `--mount`
 * syntax interprets, before and after `realpath`. Every failure of these is
 * `E_INVALID`, naming `dir` or `mounts`. The state directory is plugin
 * state: it must resolve to an existing directory other than `/` that is
 * mount-safe, or the failure is a plain error. A git common dir at or inside
 * the state directory gets no mount.
 */
export async function resolveMountSet(request: MountRequest): Promise<MountSet> {
  const dirReadOnly = request.dirReadOnly ?? false;
  const given = request.mounts ?? [];
  const dir = await resolveMountDir(request.dir);
  const mounts: MountSpec[] = [];
  for (const spec of given) {
    mounts.push({ path: await resolveMountSource(spec), readOnly: spec.readOnly });
  }
  const stateDir = await resolveStateSource('state directory', request.stateDir);
  const found = await gitCommonDir(dir);
  // A common dir at or inside the work directory is already visible through its mount;
  // one at or inside the state directory is never mounted.
  const commonDir = found !== null && !isAtOrBelow(found, dir) && !isAtOrBelow(found, stateDir) ? found : null;
  const all: ResolvedMount[] = [
    { role: 'dir', path: dir, readOnly: dirReadOnly, given: formatMountSpec({ path: request.dir, readOnly: dirReadOnly }) },
  ];
  if (commonDir !== null) {
    all.push({ role: 'git', path: commonDir, readOnly: true, given: commonDir });
  }
  mounts.forEach((mount, index) => {
    all.push({ role: 'mount', path: mount.path, readOnly: mount.readOnly, given: formatMountSpec(given[index] as MountSpec) });
  });
  validateMountSet(all);
  const stateMask = stateDirMask(all, stateDir);
  return Object.freeze({
    dir,
    dirReadOnly,
    gitCommonDir: commonDir,
    mounts: Object.freeze(mounts),
    all: Object.freeze(all),
    stateMask,
  });
}

/**
 * The git common dir to mount for `dir` (resolved), when `dir/.git` is a
 * regular file, not a symlink, `gitdir: <path>` (relative to `dir`) naming a
 * git dir of one of the two layouts git writes itself:
 * - a linked worktree: the git dir has a `commondir` file naming the common
 *   dir, sits in that common dir's `worktrees/`, and its `gitdir` file names
 *   `dir/.git` back. The common dir is returned.
 * - a submodule: the git dir has no `commondir` file and its `config` sets
 *   `core.worktree` to `dir`. The git dir itself is returned.
 * Every path is resolved with `realpath`, a relative one against the file's
 * own directory. The back-links are what make the layout git's own: a `.git`
 * file alone cannot point the mount at an arbitrary directory. Anything else
 * is null, with no error: no `.git`, a `.git` directory or symlink, another
 * format, a target that is missing or unreadable, or one that does not name
 * `dir` back. A common dir that passes these checks but is `/` or not
 * mount-safe is `E_INVALID` naming `dir`.
 */
export async function gitCommonDir(dir: string): Promise<string | null> {
  const dotGit = join(dir, '.git');
  // A symlink to another checkout's `.git` file would pass that checkout's back-link check.
  const info = await lstat(dotGit).catch(() => null);
  if (info === null || !info.isFile()) {
    return null;
  }
  const line = await readGitFile(dotGit);
  if (line === null || !line.startsWith(GITDIR_PREFIX) || line.length === GITDIR_PREFIX.length) {
    return null;
  }
  const gitDir = await realpathOrNull(physicalPath(dir, line.slice(GITDIR_PREFIX.length)));
  if (gitDir === null) {
    return null;
  }
  const named = await readGitFile(join(gitDir, 'commondir'));
  const commonDir =
    named === null || named === ''
      ? await submoduleGitDir(gitDir, dir)
      : await linkedWorktreeCommonDir(gitDir, named, dotGit);
  if (commonDir === null) {
    return null;
  }
  const subject = `is a git work tree whose common dir ${JSON.stringify(commonDir)}`;
  if (commonDir === '/') {
    throw new InvalidInputError('dir', `${subject} is the root directory`);
  }
  if (!isMountSafe(commonDir)) {
    throw new InvalidInputError('dir', `${subject} ${MOUNT_UNSAFE_RULE}`);
  }
  return commonDir;
}

/**
 * The common dir of a linked worktree's git dir (resolved): the dir its
 * `commondir` names, when the git dir is `<common dir>/worktrees/<name>` and
 * its `gitdir` file names `dotGit` back; else null.
 */
async function linkedWorktreeCommonDir(gitDir: string, named: string, dotGit: string): Promise<string | null> {
  const commonDir = await realpathOrNull(physicalPath(gitDir, named));
  if (commonDir === null || dirname(gitDir) !== join(commonDir, 'worktrees')) {
    return null;
  }
  const backLink = await readGitFile(join(gitDir, 'gitdir'));
  if (backLink === null || backLink === '') {
    return null;
  }
  const linked = await realpathOrNull(physicalPath(gitDir, backLink));
  return linked !== null && linked === (await realpathOrNull(dotGit)) ? commonDir : null;
}

/** A submodule's git dir (resolved), when its `config` sets `core.worktree` to `dir`; else null. */
async function submoduleGitDir(gitDir: string, dir: string): Promise<string | null> {
  const config = await readRegularFile(join(gitDir, 'config'));
  const worktree = config === null ? null : coreWorktree(config);
  if (worktree === null || worktree === '') {
    return null;
  }
  return (await realpathOrNull(physicalPath(gitDir, worktree))) === dir ? gitDir : null;
}

/** A git file is read only when it is a regular file of at most this many bytes. */
const GIT_FILE_MAX_BYTES = 1024 * 1024;

/** A section header of a git config file: the name, and the subsection when there is one. */
const CONFIG_SECTION = /^\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]\s*(?:[#;].*)?$/;

/** A variable line of a git config file: the name, and the raw value after `=` when there is one. */
const CONFIG_VARIABLE = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/;

/** The escapes a git config value may hold. */
const CONFIG_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['\\', '\\'],
  ['"', '"'],
  ['n', '\n'],
  ['t', '\t'],
  ['b', '\b'],
]);

/**
 * The last `core.worktree` value of a git config file, or null when none is
 * set. Section and variable names are matched without case, a subsection is
 * a different section, and a value is read with git's quoting, escapes and
 * comments. A line this reader does not know (a continued value among them)
 * makes the whole file null: the caller then mounts nothing.
 */
export function coreWorktree(config: string): string | null {
  let section: string | null = null;
  let worktree: string | null = null;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    if (line.startsWith('[')) {
      const header = CONFIG_SECTION.exec(line);
      if (header === null) {
        return null;
      }
      section = header[2] === undefined ? (header[1] as string).toLowerCase() : null;
      continue;
    }
    const variable = CONFIG_VARIABLE.exec(line);
    if (variable === null) {
      return null;
    }
    const value = variable[2] === undefined ? null : configValue(variable[2]);
    if (variable[2] !== undefined && value === null) {
      return null;
    }
    if (section === 'core' && (variable[1] as string).toLowerCase() === 'worktree') {
      worktree = value;
    }
  }
  return worktree;
}

/**
 * A git config value after `=`: blanks around it dropped and blanks inside
 * kept, quotes removed, escapes replaced, a `#` or `;` outside quotes
 * starting a comment. Null for an unknown escape, a trailing backslash or an
 * open quote.
 */
function configValue(raw: string): string | null {
  let value = '';
  let blanks = '';
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;
    if (!quoted && (char === ' ' || char === '\t')) {
      blanks += value === '' ? '' : char;
      continue;
    }
    if (!quoted && (char === '#' || char === ';')) {
      break;
    }
    value += blanks;
    blanks = '';
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === '\\') {
      const escaped = CONFIG_ESCAPES.get(raw[index + 1] ?? '');
      if (escaped === undefined) {
        return null;
      }
      value += escaped;
      index += 1;
      continue;
    }
    value += char;
  }
  return quoted ? null : value;
}

/** A git file's content without the line breaks at its end, as git reads it; null as {@link readRegularFile}. */
async function readGitFile(path: string): Promise<string | null> {
  const content = await readRegularFile(path);
  return content === null ? null : content.replace(/[\r\n]+$/, '');
}

/** The content of a regular file of at most {@link GIT_FILE_MAX_BYTES}, or null for any other path or failure. */
async function readRegularFile(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > GIT_FILE_MAX_BYTES) {
      return null;
    }
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** `path` against `base` as the file system reads it: `..` after a symlink is the symlink target's parent. */
function physicalPath(base: string, path: string): string {
  return isAbsolute(path) ? path : `${base}/${path}`;
}

async function realpathOrNull(path: string): Promise<string | null> {
  return realpath(path).catch(() => null);
}

/** Resolves the source of a custom mount; failures are `E_INVALID` naming `mounts`. */
async function resolveMountSource(spec: MountSpec): Promise<string> {
  const subject = `entry ${JSON.stringify(formatMountSpec(spec))}`;
  if (!isAbsolute(spec.path)) {
    throw new InvalidInputError('mounts', `${subject} must be an absolute path`);
  }
  if (!isMountSafe(spec.path)) {
    throw new InvalidInputError('mounts', `${subject} ${MOUNT_UNSAFE_RULE}`);
  }
  let resolved: string;
  try {
    resolved = await realpath(spec.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new InvalidInputError('mounts', `${subject} does not exist`);
    }
    throw new InvalidInputError('mounts', `${subject} cannot be resolved (${code ?? 'unknown error'})`);
  }
  if (resolved === '/') {
    throw new InvalidInputError('mounts', `${subject} must not be the root directory`);
  }
  if (!isMountSafe(resolved)) {
    throw new InvalidInputError('mounts', `${subject} resolves to ${JSON.stringify(resolved)}, which ${MOUNT_UNSAFE_RULE}`);
  }
  return resolved;
}

/**
 * Resolves the sources of the Kiro home mounts, in `--mount` order: the home
 * read-write, then the skill and steering copies read-only. Each source is
 * resolved with `realpath` and must be an existing directory other than `/`,
 * holding no character the `--mount` syntax interprets before or after
 * resolution. They are plugin state, not input, so a failure is a plain
 * error.
 */
async function resolveKiroHomeMounts(sources: KiroHomeSources): Promise<FixedMount[]> {
  const mounts: Array<[string, string, string, boolean]> = [
    ['Kiro home', sources.home, CONTAINER_KIRO_HOME, false],
    ['skill copies directory', sources.skills, CONTAINER_KIRO_SKILLS, true],
    ['steering copies directory', sources.steering, CONTAINER_KIRO_STEERING, true],
  ];
  const resolved: FixedMount[] = [];
  for (const [what, path, destination, readOnly] of mounts) {
    resolved.push({ source: await resolveStateSource(what, path), destination, readOnly });
  }
  return resolved;
}

/** The read-only mount of a fixed file at `destination`, or null without one. */
async function resolveFileMount(what: string, file: string | undefined, destination: string): Promise<FixedMount | null> {
  if (file === undefined) {
    return null;
  }
  return { source: await resolveStateSource(what, file, 'file'), destination, readOnly: true };
}

/**
 * Resolves the source of a mount the plugin adds itself with `realpath`: it
 * must exist, be a directory or a regular file as `kind` says, not be `/`,
 * and hold no character the `--mount` syntax interprets before or after
 * resolution. A failure is a plain error naming `what`.
 */
export async function resolveStateSource(what: string, path: string, kind: 'directory' | 'file' = 'directory'): Promise<string> {
  const subject = `The ${what} ${JSON.stringify(path)}`;
  if (!isMountSafe(path)) {
    throw new Error(`${subject} ${MOUNT_UNSAFE_RULE}`);
  }
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch (error) {
    throw new Error(`${subject} cannot be resolved (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`);
  }
  if (resolved === '/') {
    throw new Error(`${subject} must not resolve to the root directory`);
  }
  if (!isMountSafe(resolved)) {
    throw new Error(`${subject} resolves to ${JSON.stringify(resolved)}, which ${MOUNT_UNSAFE_RULE}`);
  }
  const status = await stat(resolved);
  if (kind === 'directory' ? !status.isDirectory() : !status.isFile()) {
    throw new Error(`${subject} must be a ${kind === 'directory' ? 'directory' : 'regular file'}`);
  }
  return resolved;
}

/**
 * Builds the `docker run` command of a run and the CLI environment. Validates
 * the user, image and token first (`E_INVALID`). The mount set is taken as
 * resolved ({@link resolveMountSet}): each resolved path is its mount's
 * destination, and the work directory is the working directory. The Kiro
 * home mounts precede the set, and the task file and tool server mounts
 * follow it; a source of theirs that cannot be mounted, and a label value
 * that is refused
 * ({@link containerLabels}), is a plain error.
 */
export async function buildDockerLaunch(options: DockerLaunchOptions): Promise<DockerLaunch> {
  const env = options.env ?? process.env;
  const name = containerName(options.launchId);
  assertExplicitDockerUser(options.user);
  assertDockerImage(options.image);
  assertKiroToken(options.token, 'token');
  const set = options.mountSet;
  const kiroMounts = await resolveKiroHomeMounts(options.kiroHome);
  const taskMount = await resolveFileMount('task file', options.taskFile, CONTAINER_TASK_FILE);
  const toolServerMount = await resolveFileMount('tool server', options.toolServerFile, CONTAINER_TOOL_SERVER_FILE);
  const labels =containerLabels(options.launchId, options.owner, options.secrets);
  const dir = set.dir;
  const proxies = options.proxy ?? {};
  const proxyNames = PROXY_VARIABLES.filter((variable) => proxies[variable] !== undefined);
  const args = dockerRunArgs({
    name,
    labels,
    user: options.user,
    image: options.image,
    dir,
    kiroMounts,
    mounts: set.all,
    stateMask: set.stateMask,
    taskMount,
    toolServerMount,
    proxyNames,
  });
  return Object.freeze({
    command: DOCKER_COMMAND,
    args: Object.freeze(args),
    env: Object.freeze({ ...dockerCliEnvironment(env, options.token), ...proxies }),
    containerName: name,
    dir,
  });
}

interface DockerRunSpec {
  readonly name: string;
  /** The container labels in order. */
  readonly labels: ReadonlyArray<readonly [string, string]>;
  readonly user: string;
  readonly image: string;
  readonly dir: string;
  /** The Kiro home mounts in order, mounted before the set. */
  readonly kiroMounts: readonly FixedMount[];
  /** Every mount of the set in order, the work directory first. */
  readonly mounts: readonly ResolvedMount[];
  /** The task file mount, mounted after the set, or null. */
  readonly taskMount: FixedMount | null;
  /** The tool server mount, mounted after the task file, or null. */
  readonly toolServerMount: FixedMount | null;
  /** The state directory to cover with an empty tmpfs after the last mount that holds it, or null. */
  readonly stateMask: string | null;
  readonly proxyNames: readonly ProxyVariable[];
}

/** The argument array of `docker run`, from inputs that are already validated. */
function dockerRunArgs(spec: DockerRunSpec): string[] {
  const args = ['run', '--rm', '-i', '--pull', 'never', '--name', spec.name];
  for (const [key, value] of spec.labels) {
    args.push('--label', `${key}=${value}`);
  }
  args.push('--user', spec.user);
  for (const entry of [...FIXED_ENV_ENTRIES, ...spec.proxyNames]) {
    args.push('-e', entry);
  }
  for (const mount of spec.kiroMounts) {
    args.push('--mount', bindMountArgument(mount.source, mount.destination, mount.readOnly));
  }
  const mask = spec.stateMask;
  const lastHolder = mask === null ? -1 : spec.mounts.findLastIndex((mount) => isAtOrBelow(mask, mount.path));
  spec.mounts.forEach((mount, index) => {
    args.push('--mount', mountArgument(mount));
    if (index === lastHolder) {
      args.push('--mount', tmpfsMountArgument(mask as string));
    }
  });
  for (const mount of [spec.taskMount, spec.toolServerMount]) {
    if (mount !== null) {
      args.push('--mount', bindMountArgument(mount.source, mount.destination, mount.readOnly));
    }
  }
  args.push('-w', spec.dir, '--entrypoint', KIRO_ENTRYPOINT, spec.image, ...KIRO_ARGS);
  return args;
}

function assertMountSafe(path: string): void {
  if (!isMountSafe(path)) {
    throw new InvalidInputError('dir', `${MOUNT_UNSAFE_RULE}, got ${JSON.stringify(path)}`);
  }
}
