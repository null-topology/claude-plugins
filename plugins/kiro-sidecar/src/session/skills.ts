/**
 * Skill resolution (spec 7). A `skills` name of `start` becomes the absolute
 * directory that holds its `SKILL.md`:
 *
 * - `plugin:skill` looks only in the installed and enabled plugin named
 *   `plugin`: its `skills/` and the skill directories its `plugin.json` lists.
 * - A bare name looks in these roots in order, and the first root with a hit
 *   wins: the project's `.claude/skills`, the config directory's `skills`, the
 *   signed-in account's synced skills, then the enabled plugins together.
 *
 * Two different directories found in one root (the enabled plugins together
 * count as one root for a bare name) are an ambiguity listing the candidates;
 * directories with the same real path are one. Every refusal is `E_INVALID`
 * for the field `skills`. A file that decides the answer and cannot be read or
 * parsed is reported by its path, never guessed around, and its content never
 * reaches a message. A file that cannot change the answer is not read: a bare
 * name found in the project root reads no account and no plugin file.
 *
 * The module only reads the file system; every location comes in through
 * {@link SkillSources}, which {@link skillSourcesFromEnv} derives from the
 * environment.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Environment } from '../settings.ts';
import { errorCode } from '../store/files.ts';
import { InvalidInputError } from '../text/errors.ts';
import { checkSkillTrees, copyNameKey, SKILL_COPY_LIMITS, SkillTreeError } from './run-copies.ts';
import type { SkillCopyLimits } from './run-copies.ts';

const FIELD = 'skills';
const SKILL_FILE = 'SKILL.md';
const NAME_PART = /^[A-Za-z0-9._-]+$/;
const ACCOUNT_ID = /^[A-Za-z0-9-]+$/;

/** Where the skills and the files that decide them are. */
export interface SkillSources {
  /** The Claude config directory: `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`. Absolute. */
  readonly configDir: string;
  /** The account file: `$CLAUDE_CONFIG_DIR/.claude.json` when that is set, else `~/.claude.json`. Absolute. */
  readonly claudeJsonPath: string;
  /** The project directory (`$CLAUDE_PROJECT_DIR`), absolute; null when there is none. */
  readonly projectDir: string | null;
}

/** One resolved entry of `skills`. */
export interface ResolvedSkill {
  /** The name as given. */
  readonly requested: string;
  /** The skill's directory name, which its copy gets (spec 7); unique in one call. */
  readonly name: string;
  /** The skill directory: absolute, symlinks resolved, holding a regular `SKILL.md`. */
  readonly dir: string;
}

/**
 * The sources from the environment: `CLAUDE_CONFIG_DIR` replaces `~/.claude`
 * and moves `.claude.json` into it; the home is `HOME`, else the OS home.
 */
export function skillSourcesFromEnv(env: Environment = process.env): SkillSources {
  const projectEnv = nonEmpty(env['CLAUDE_PROJECT_DIR']);
  const projectDir = projectEnv === null ? null : resolve(projectEnv);
  const configEnv = nonEmpty(env['CLAUDE_CONFIG_DIR']);
  if (configEnv !== null) {
    const configDir = resolve(configEnv);
    return { configDir, claudeJsonPath: join(configDir, '.claude.json'), projectDir };
  }
  const home = nonEmpty(env['HOME']) ?? homedir();
  return { configDir: join(home, '.claude'), claudeJsonPath: join(home, '.claude.json'), projectDir };
}

/**
 * Resolves `names` in order. Every name is checked before any file is read.
 * Names that resolve to the same directory are kept once (the first); two
 * different directories with the same directory name are refused, since the
 * copies would collide (spec 6.1). The resolved skills must then pass the
 * copy rules within `limits` ({@link checkSkillTrees}).
 */
export async function resolveSkills(
  names: readonly string[],
  sources: SkillSources,
  limits: SkillCopyLimits = SKILL_COPY_LIMITS,
): Promise<ResolvedSkill[]> {
  const resolved = await resolveNames(names, sources);
  try {
    await checkSkillTrees(resolved, limits);
  } catch (error) {
    if (error instanceof SkillTreeError) {
      throw new InvalidInputError(FIELD, `cannot be copied: ${error.message}`);
    }
    const path = (error as { path?: unknown } | null)?.path;
    throw new InvalidInputError(
      FIELD,
      `cannot be copied: ${typeof path === 'string' ? quote(path) : 'a skill file'} cannot be read (${errorCode(error) ?? 'unknown error'})`,
    );
  }
  return resolved;
}

async function resolveNames(names: readonly string[], sources: SkillSources): Promise<ResolvedSkill[]> {
  const parsed = names.map(parseSkillName);
  const search = new SkillSearch(sources);
  const resolved: ResolvedSkill[] = [];
  for (const name of parsed) {
    const dir = name.plugin === null ? await search.bare(name) : await search.qualified(name, name.plugin);
    if (resolved.some((skill) => skill.dir === dir)) {
      continue;
    }
    // Compared ignoring case and normalization: on such a file system the copies would be one directory.
    const clash = resolved.find((skill) => copyNameKey(skill.name) === copyNameKey(name.skill));
    if (clash !== undefined) {
      const named = clash.name === name.skill ? quote(name.skill) : `${quote(clash.name)} and ${quote(name.skill)}`;
      throw new InvalidInputError(
        FIELD,
        `${quote(clash.requested)} and ${quote(name.requested)} are two skills named ${named} ` +
          `(${clash.dir}, ${dir}); skill names must be unique, ignoring case`,
      );
    }
    resolved.push({ requested: name.requested, name: name.skill, dir });
  }
  return resolved;
}

interface SkillName {
  readonly requested: string;
  /** The plugin name of `plugin:skill`; null for a bare name. */
  readonly plugin: string | null;
  readonly skill: string;
}

/** `name` or `plugin:name`; a path, an empty part or another character is refused. */
function parseSkillName(value: string): SkillName {
  if (value.includes('/') || value.includes('\\')) {
    throw new InvalidInputError(FIELD, `${quote(value)} is a path; give a skill name ("name" or "plugin:name")`);
  }
  const parts = value.split(':');
  const valid = parts.length <= 2 && parts.every((part) => part !== '.' && part !== '..' && NAME_PART.test(part));
  if (!valid) {
    throw new InvalidInputError(
      FIELD,
      `${quote(value)} is not a skill name: give "name" or "plugin:name", each part of [A-Za-z0-9._-], not "." or ".."`,
    );
  }
  const [first, second] = parts as [string, string?];
  return second === undefined
    ? { requested: value, plugin: null, skill: first }
    : { requested: value, plugin: first, skill: second };
}

/** A directory whose `<dir>/<skill>/SKILL.md` is looked up, and what to call a hit in it. */
interface SearchDir {
  readonly parent: string;
  readonly label: string;
}

interface EnabledPlugin {
  /** `<plugin>@<marketplace>`, as in `enabledPlugins`. */
  readonly key: string;
  /** The plugin name: the key before `@`. */
  readonly name: string;
  /** `<installPath>/skills`, then the `plugin.json` skill directories. */
  readonly skillParents: readonly string[];
}

/** One resolution call: each file is read at most once, and only when it can change the answer. */
class SkillSearch {
  readonly #sources: SkillSources;
  #accountSkills: Promise<string | null> | undefined;
  #plugins: Promise<readonly EnabledPlugin[]> | undefined;

  constructor(sources: SkillSources) {
    this.#sources = sources;
  }

  async bare(name: SkillName): Promise<string> {
    const { projectDir, configDir, claudeJsonPath } = this.#sources;
    const searched: string[] = [];
    const roots: SearchDir[] = [];
    if (projectDir !== null) {
      roots.push({ parent: join(projectDir, '.claude', 'skills'), label: 'project' });
    }
    roots.push({ parent: join(configDir, 'skills'), label: 'user' });
    for (const root of roots) {
      const hit = await findOne(name, [root]);
      if (hit !== null) {
        return hit;
      }
      searched.push(root.parent);
    }
    const synced = await this.#loadAccountSkills();
    if (synced === null) {
      searched.push(`no synced skills (no signed-in account in ${quote(claudeJsonPath)})`);
    } else {
      const hit = await findOne(name, [{ parent: synced, label: 'synced' }]);
      if (hit !== null) {
        return hit;
      }
      searched.push(synced);
    }
    const plugins = await this.#loadPlugins();
    const hit = await findOne(
      name,
      plugins.flatMap((plugin) => plugin.skillParents.map((parent) => ({ parent, label: `plugin ${plugin.key}` }))),
    );
    if (hit !== null) {
      return hit;
    }
    searched.push(
      plugins.length === 0 ? 'no enabled plugins' : `the enabled plugins ${plugins.map((plugin) => plugin.key).join(', ')}`,
    );
    throw new InvalidInputError(FIELD, `${quote(name.requested)} was not found; searched ${searched.join(', ')}`);
  }

  async qualified(name: SkillName, pluginName: string): Promise<string> {
    const plugins = (await this.#loadPlugins()).filter((plugin) => plugin.name === pluginName);
    const [plugin] = plugins;
    if (plugin === undefined) {
      throw new InvalidInputError(
        FIELD,
        `${quote(name.requested)} was not found: no installed and enabled plugin is named ${quote(pluginName)}`,
      );
    }
    if (plugins.length > 1) {
      throw new InvalidInputError(
        FIELD,
        `${quote(name.requested)} is ambiguous: plugin ${quote(pluginName)} is installed and enabled as ` +
          plugins.map((each) => each.key).join(', '),
      );
    }
    const hit = await findOne(
      name,
      plugin.skillParents.map((parent) => ({ parent, label: `plugin ${plugin.key}` })),
    );
    if (hit !== null) {
      return hit;
    }
    throw new InvalidInputError(
      FIELD,
      `${quote(name.requested)} was not found; searched ${plugin.skillParents.join(', ')}`,
    );
  }

  #loadAccountSkills(): Promise<string | null> {
    this.#accountSkills ??= readAccountSkills(this.#sources);
    return this.#accountSkills;
  }

  #loadPlugins(): Promise<readonly EnabledPlugin[]> {
    this.#plugins ??= readEnabledPlugins(this.#sources);
    return this.#plugins;
  }
}

/**
 * The one skill directory for `name` among `dirs`, null when there is none.
 * Hits with the same real path count once; two different ones are ambiguous.
 */
async function findOne(name: SkillName, dirs: readonly SearchDir[]): Promise<string | null> {
  const hits: { readonly dir: string; readonly label: string }[] = [];
  for (const { parent, label } of dirs) {
    const dir = await skillDir(parent, name.skill);
    if (dir !== null && !hits.some((hit) => hit.dir === dir)) {
      hits.push({ dir, label });
    }
  }
  const [first] = hits;
  if (first === undefined) {
    return null;
  }
  if (hits.length > 1) {
    throw new InvalidInputError(
      FIELD,
      `${quote(name.requested)} is ambiguous: ${hits.map((hit) => `${hit.dir} (${hit.label})`).join(', ')}`,
    );
  }
  return first.dir;
}

/** The real path of `<parent>/<skill>` when it holds a regular `SKILL.md`, else null. */
async function skillDir(parent: string, skill: string): Promise<string | null> {
  const dir = join(parent, skill);
  const file = join(dir, SKILL_FILE);
  try {
    if (!(await stat(file)).isFile()) {
      return null;
    }
    return await realpath(dir);
  } catch (error) {
    if (isAbsent(error)) {
      return null;
    }
    throw unreadable(file, error);
  }
}

/**
 * The synced skills of the signed-in account: `<config>/skills/synced/<organizationUuid>_<accountUuid>`
 * from `oauthAccount` in `.claude.json`. Null when the file or the account is
 * absent; the directory of any other account is never read.
 */
async function readAccountSkills(sources: SkillSources): Promise<string | null> {
  const path = sources.claudeJsonPath;
  const json = await readJson(path);
  if (json === undefined) {
    return null;
  }
  if (!isRecord(json)) {
    throw malformed(path, 'is not a JSON object');
  }
  const account = json['oauthAccount'];
  if (account === undefined || account === null) {
    return null;
  }
  if (!isRecord(account)) {
    throw malformed(path, 'has an "oauthAccount" that is not an object');
  }
  const organization = account['organizationUuid'];
  const accountId = account['accountUuid'];
  if (!isAccountId(organization) || !isAccountId(accountId)) {
    throw malformed(path, 'has an "oauthAccount" without a valid organizationUuid and accountUuid');
  }
  return join(sources.configDir, 'skills', 'synced', `${organization}_${accountId}`);
}

/**
 * The installed plugins whose `enabledPlugins` value, merged over the user,
 * project and local settings files (a later file wins per key), is true.
 */
async function readEnabledPlugins(sources: SkillSources): Promise<readonly EnabledPlugin[]> {
  const { configDir, projectDir } = sources;
  const settingsFiles = [join(configDir, 'settings.json')];
  if (projectDir !== null) {
    settingsFiles.push(join(projectDir, '.claude', 'settings.json'), join(projectDir, '.claude', 'settings.local.json'));
  }
  const enabled = new Map<string, boolean>();
  for (const file of settingsFiles) {
    for (const [key, value] of await readEnabledSetting(file)) {
      enabled.set(key, value);
    }
  }
  const keys = [...enabled].filter(([, on]) => on).map(([key]) => key);
  if (keys.length === 0) {
    return [];
  }
  const registryPath = join(configDir, 'plugins', 'installed_plugins.json');
  const registry = await readRegistry(registryPath);
  const plugins: EnabledPlugin[] = [];
  for (const key of keys) {
    const installPath = pickInstallPath(registry, key, projectDir, registryPath);
    if (installPath === null) {
      continue;
    }
    const extra = await readPluginSkillDirs(installPath);
    plugins.push({ key, name: pluginName(key), skillParents: [join(installPath, 'skills'), ...extra] });
  }
  return plugins;
}

/** The `enabledPlugins` of one settings file; a missing file or key is empty. */
async function readEnabledSetting(path: string): Promise<[string, boolean][]> {
  const json = await readJson(path);
  if (json === undefined) {
    return [];
  }
  if (!isRecord(json)) {
    throw malformed(path, 'is not a JSON object');
  }
  const value = json['enabledPlugins'];
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    throw malformed(path, 'has an "enabledPlugins" that is not an object');
  }
  const entries: [string, boolean][] = [];
  for (const [key, on] of Object.entries(value)) {
    if (typeof on !== 'boolean') {
      throw malformed(path, `has an "enabledPlugins" value for ${quote(key)} that is not true or false`);
    }
    entries.push([key, on]);
  }
  return entries;
}

/** The `plugins` map of `installed_plugins.json`; a missing file is empty. */
async function readRegistry(path: string): Promise<Readonly<Record<string, unknown>>> {
  const json = await readJson(path);
  if (json === undefined) {
    return {};
  }
  if (!isRecord(json) || !isRecord(json['plugins'])) {
    throw malformed(path, 'has no "plugins" object');
  }
  return json['plugins'];
}

/**
 * The install path of `key` for this project, null when it is not installed
 * for it.
 *
 * Inferred from the Claude Code documentation, not measured here (every
 * install measured had scope `user`): an install of scope `local` or `project`
 * applies only to its `projectPath`, and one for this project is taken before
 * a `user` install; `local` is taken before `project`.
 */
function pickInstallPath(
  registry: Readonly<Record<string, unknown>>,
  key: string,
  projectDir: string | null,
  registryPath: string,
): string | null {
  const entries = registry[key];
  if (entries === undefined) {
    return null;
  }
  if (!Array.isArray(entries) || !entries.every(isRecord)) {
    throw malformed(registryPath, `has a ${quote(key)} entry that is not a list of objects`);
  }
  const forProject = (scope: string) =>
    entries.find(
      (entry) =>
        entry['scope'] === scope &&
        projectDir !== null &&
        typeof entry['projectPath'] === 'string' &&
        resolve(entry['projectPath']) === resolve(projectDir),
    );
  const chosen = forProject('local') ?? forProject('project') ?? entries.find((entry) => entry['scope'] === 'user');
  if (chosen === undefined) {
    return null;
  }
  const installPath = chosen['installPath'];
  if (typeof installPath !== 'string' || !isAbsolute(installPath)) {
    throw malformed(registryPath, `has a ${quote(key)} install without an absolute "installPath"`);
  }
  return installPath;
}

/**
 * The extra skill directories a plugin lists in `.claude-plugin/plugin.json`
 * (`skills`: one path or a list, relative to the plugin root, each a directory
 * of skill directories). A path outside the plugin root is refused.
 */
async function readPluginSkillDirs(installPath: string): Promise<string[]> {
  const path = join(installPath, '.claude-plugin', 'plugin.json');
  const json = await readJson(path);
  if (json === undefined) {
    return [];
  }
  if (!isRecord(json)) {
    throw malformed(path, 'is not a JSON object');
  }
  const value = json['skills'];
  if (value === undefined) {
    return [];
  }
  const paths = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(paths) || !paths.every((each) => typeof each === 'string')) {
    throw malformed(path, 'has a "skills" that is not a path or a list of paths');
  }
  return paths.map((each: string) => {
    const dir = resolve(installPath, each);
    const inside = relative(installPath, dir);
    if (isAbsolute(each) || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw malformed(path, `has a "skills" path ${quote(each)} outside the plugin`);
    }
    return dir;
  });
}

/** The plugin name of an `enabledPlugins` key: the part before `@`. */
function pluginName(key: string): string {
  const at = key.indexOf('@');
  return at === -1 ? key : key.slice(0, at);
}

/** The parsed JSON of `path`; undefined when it does not exist. */
async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isAbsent(error)) {
      return undefined;
    }
    throw unreadable(path, error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // The parser's message quotes the text, which may hold a secret.
    throw malformed(path, 'is not valid JSON');
  }
}

function isAbsent(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_ID.test(value);
}

function malformed(path: string, what: string): InvalidInputError {
  return new InvalidInputError(FIELD, `cannot be resolved: ${quote(path)} ${what}`);
}

function unreadable(path: string, error: unknown): InvalidInputError {
  return new InvalidInputError(FIELD, `cannot be resolved: ${quote(path)} cannot be read (${errorCode(error) ?? 'unknown error'})`);
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}
