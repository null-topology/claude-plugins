/**
 * The mount set of a docker run: the `path` and `path:ro` syntax, the
 * `--mount` values, and the rules the whole set must keep. Nothing here
 * touches the file system; the caller resolves every path first.
 *
 * Every mount is a bind mount whose destination is its source path, so a
 * mount is identified by one resolved path. The set is, in `--mount` order:
 * the work directory, the git common dir of a linked worktree or a submodule
 * (always read-only), and the custom mounts in the order given.
 *
 * The rules: no two mounts share a destination; a writable mount is never
 * inside a read-only one, and a read-only mount is never inside a writable
 * one; nothing is mounted at, inside or above a path the plugin mounts itself
 * (in the container home, and its tool server under `/opt/kiro-sidecar`);
 * nothing is mounted at or inside the plugin's state
 * directory. A mount above the state directory is allowed, and the launch
 * covers the state directory with an empty tmpfs, so the container sees
 * nothing of it.
 *
 * The Kiro home, task file and tool server mounts the plugin adds itself are
 * not part of the set: they sit at the reserved destinations, which the rules
 * keep free for them.
 */
import { InvalidInputError } from '../text/errors.ts';

/** `HOME` inside the container. */
export const CONTAINER_HOME = '/home/agent';

/** The Kiro home inside the container. */
export const CONTAINER_KIRO_HOME = `${CONTAINER_HOME}/.kiro`;

/** Where the run's copy of `prompt_file` is mounted, read-only. */
export const CONTAINER_TASK_FILE = `${CONTAINER_HOME}/task.md`;

/** The directory that holds the plugin's own files inside the container. */
export const CONTAINER_PLUGIN_DIR = '/opt/kiro-sidecar';

/**
 * Where the plugin's tool server `sidecar-tools.js` is mounted, read-only.
 * No `package.json` sits beside it in the container, so the `.mjs` name is
 * what tells the image's node that the bundle is an ES module.
 */
export const CONTAINER_TOOL_SERVER_FILE = `${CONTAINER_PLUGIN_DIR}/sidecar-tools.mjs`;

/** The suffix that makes a mount read-only. */
export const READ_ONLY_SUFFIX = ':ro';

/**
 * Container paths the plugin mounts itself: the Kiro home, the task file and
 * the directory of the tool server. No mount may be at, inside or above one
 * of them, so `/opt` is refused too.
 */
export const RESERVED_DESTINATIONS: readonly string[] = Object.freeze([
  CONTAINER_KIRO_HOME,
  CONTAINER_TASK_FILE,
  CONTAINER_PLUGIN_DIR,
]);

/**
 * Characters the `--mount` value syntax interprets: the comma separates
 * fields, a double quote starts quoting, and a line break ends the value.
 * Control characters are refused with them.
 */
const MOUNT_UNSAFE_CHARACTERS = /[,"\x00-\x1f\x7f]/;

/** A mount as given: a host path and whether it is read-only. */
export interface MountSpec {
  readonly path: string;
  readonly readOnly: boolean;
}

/** What a mount of the set is: the work directory, the git common dir, or a custom mount. */
export type MountRole = 'dir' | 'git' | 'mount';

/** A mount whose source is resolved; it is mounted at the same path. */
export interface ResolvedMount {
  readonly role: MountRole;
  /** The resolved source, which is also the destination. */
  readonly path: string;
  readonly readOnly: boolean;
  /** The value the caller gave (`path` or `path:ro`), as an error quotes it. */
  readonly given: string;
}

/** Splits `path:ro` into the path and the read-only flag; any other value is a writable path. */
export function parseMountSpec(value: string): MountSpec {
  if (value.endsWith(READ_ONLY_SUFFIX)) {
    return { path: value.slice(0, -READ_ONLY_SUFFIX.length), readOnly: true };
  }
  return { path: value, readOnly: false };
}

/** The `path` or `path:ro` form of a mount. */
export function formatMountSpec(spec: MountSpec): string {
  return spec.readOnly ? `${spec.path}${READ_ONLY_SUFFIX}` : spec.path;
}

/** True unless the path holds a character the `--mount` syntax interprets. */
export function isMountSafe(path: string): boolean {
  return !MOUNT_UNSAFE_CHARACTERS.test(path);
}

/** The `--mount` value of a mount whose path is resolved and mount-safe. */
export function mountArgument(mount: Pick<ResolvedMount, 'path' | 'readOnly'>): string {
  return bindMountArgument(mount.path, mount.path, mount.readOnly);
}

/** The `--mount` value of an empty tmpfs at `destination`, an absolute and mount-safe path. */
export function tmpfsMountArgument(destination: string): string {
  return `type=tmpfs,dst=${destination}`;
}

/**
 * Checks a set whose paths are resolved against the plugin's resolved state
 * directory: a mount at or inside it is `E_INVALID`, naming the mount's field.
 * Returns the state directory when a mount of the set holds it, as the path
 * the launch covers with an empty tmpfs, else null.
 */
export function stateDirMask(mounts: readonly ResolvedMount[], stateDir: string): string | null {
  for (const mount of mounts) {
    if (isAtOrBelow(mount.path, stateDir)) {
      throw invalid(
        mount,
        `would be mounted at ${JSON.stringify(mount.path)}: nothing may be mounted at or inside ` +
          `the plugin state directory ${JSON.stringify(stateDir)}`,
      );
    }
  }
  return mounts.some((mount) => isAtOrBelow(stateDir, mount.path)) ? stateDir : null;
}

/** The `--mount` value of a bind mount; both paths are absolute and mount-safe. */
export function bindMountArgument(source: string, destination: string, readOnly: boolean): string {
  const value = `type=bind,src=${source},dst=${destination}`;
  return readOnly ? `${value},readonly` : value;
}

/** True when `inner` is `outer` or a path below it; both are normalized absolute paths. */
export function isAtOrBelow(inner: string, outer: string): boolean {
  if (inner === outer) {
    return true;
  }
  const prefix = outer.endsWith('/') ? outer : `${outer}/`;
  return inner.startsWith(prefix);
}

/**
 * Checks the rules of a mount set whose paths are resolved; throws
 * `E_INVALID` for the first broken one. A conflict is reported on the later
 * of the two mounts, except that the git common dir, which nobody gives, is
 * never the one blamed: the field is `mounts` for a custom mount and `dir`
 * otherwise.
 */
export function validateMountSet(mounts: readonly ResolvedMount[]): void {
  for (const mount of mounts) {
    const reserved = RESERVED_DESTINATIONS.find(
      (destination) => isAtOrBelow(mount.path, destination) || isAtOrBelow(destination, mount.path),
    );
    if (reserved !== undefined) {
      throw invalid(
        mount,
        `would be mounted at ${JSON.stringify(mount.path)}: nothing may be mounted at, inside or above ` +
          `${RESERVED_DESTINATIONS.slice(0, -1).join(', ')} or ${RESERVED_DESTINATIONS.at(-1)}`,
      );
    }
  }
  for (let later = 1; later < mounts.length; later += 1) {
    for (let earlier = 0; earlier < later; earlier += 1) {
      const a = mounts[earlier] as ResolvedMount;
      const b = mounts[later] as ResolvedMount;
      const blamed = b.role === 'git' ? a : b;
      const other = blamed === a ? b : a;
      if (a.path === b.path) {
        throw invalid(blamed, `has the same destination ${JSON.stringify(a.path)} as ${describe(other)}`);
      }
      if (a.readOnly === b.readOnly) {
        continue;
      }
      if (isAtOrBelow(blamed.path, other.path)) {
        throw invalid(blamed, `is ${access(blamed)} inside the ${access(other)} ${describe(other)}`);
      }
      if (isAtOrBelow(other.path, blamed.path)) {
        throw invalid(blamed, `is ${access(blamed)} and holds the ${access(other)} ${describe(other)}`);
      }
    }
  }
}

function access(mount: ResolvedMount): string {
  return mount.readOnly ? 'read-only' : 'writable';
}

/** A mount as the object of a sentence. */
function describe(mount: ResolvedMount): string {
  switch (mount.role) {
    case 'dir':
      return `work directory ${JSON.stringify(mount.path)}`;
    case 'git':
      return `git common dir ${JSON.stringify(mount.path)}`;
    case 'mount':
      return `mounts entry ${JSON.stringify(mount.given)}`;
  }
}

/** `E_INVALID` naming the mount's field, with the mount as the subject of `problem`. */
function invalid(mount: ResolvedMount, problem: string): InvalidInputError {
  switch (mount.role) {
    case 'dir':
      return new InvalidInputError('dir', `${JSON.stringify(mount.given)} ${problem}`);
    case 'git':
      return new InvalidInputError('dir', `is a git work tree whose common dir ${problem}`);
    case 'mount':
      return new InvalidInputError('mounts', `entry ${JSON.stringify(mount.given)} ${problem}`);
  }
}
