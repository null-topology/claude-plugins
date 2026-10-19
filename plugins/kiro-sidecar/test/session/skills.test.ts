import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveSkills, skillSourcesFromEnv } from '../../src/session/skills.ts';
import type { SkillSources } from '../../src/session/skills.ts';
import { InvalidInputError } from '../../src/text/errors.ts';
import { tempDir } from '../helpers/processes.ts';

interface Account {
  readonly organizationUuid: string;
  readonly accountUuid: string;
}

const ACCOUNT: Account = {
  organizationUuid: '11111111-aaaa-4aaa-8aaa-111111111111',
  accountUuid: '22222222-bbbb-4bbb-8bbb-222222222222',
};
const OTHER_ACCOUNT: Account = {
  organizationUuid: '33333333-cccc-4ccc-8ccc-333333333333',
  accountUuid: '44444444-dddd-4ddd-8ddd-444444444444',
};

/** A fake home with a Claude config dir and a project dir, in a temp dir of the test. */
interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly config: string;
  readonly project: string;
  readonly sources: SkillSources;
  /** The `plugins` map of the config's `installed_plugins.json`, as written so far. */
  readonly registry: Record<string, unknown[]>;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const root = await tempDir(t);
  const home = join(root, 'home');
  const config = join(home, '.claude');
  const project = join(root, 'project');
  await mkdir(config, { recursive: true });
  await mkdir(project, { recursive: true });
  return {
    root,
    home,
    config,
    project,
    sources: { configDir: config, claudeJsonPath: join(home, '.claude.json'), projectDir: project },
    registry: {},
  };
}

/** Creates `<parent>/<name>/SKILL.md`; returns the skill directory's real path. */
async function addSkill(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: A test skill.\n---\nDo the thing.\n`);
  return realpath(dir);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

interface InstallOptions {
  readonly scope?: 'user' | 'project' | 'local';
  readonly projectPath?: string;
  readonly skills?: readonly string[];
  readonly pluginJson?: unknown;
  /** The last segment of the install path; defaults to the scope. */
  readonly dir?: string;
}

/**
 * Installs `<plugin>@<marketplace>` in the config's plugin cache with the
 * given skills and records it in `installed_plugins.json`; returns the install path.
 */
async function install(fx: Fixture, key: string, options: InstallOptions = {}): Promise<string> {
  const [plugin, marketplace] = key.split('@') as [string, string];
  const scope = options.scope ?? 'user';
  const installPath = join(fx.config, 'plugins', 'cache', marketplace, plugin, options.dir ?? scope);
  await mkdir(installPath, { recursive: true });
  for (const skill of options.skills ?? []) {
    await addSkill(join(installPath, 'skills'), skill);
  }
  if (options.pluginJson !== undefined) {
    await writeJson(join(installPath, '.claude-plugin', 'plugin.json'), options.pluginJson);
  }
  const entry = {
    scope,
    installPath,
    version: '1.0.0',
    installedAt: '2026-10-19T00:00:00.000Z',
    ...(options.projectPath === undefined ? {} : { projectPath: options.projectPath }),
  };
  (fx.registry[key] ??= []).push(entry);
  await writeJson(join(fx.config, 'plugins', 'installed_plugins.json'), { version: 2, plugins: fx.registry });
  return installPath;
}

const userSettings = (fx: Fixture) => join(fx.config, 'settings.json');
const projectSettings = (fx: Fixture) => join(fx.project, '.claude', 'settings.json');
const localSettings = (fx: Fixture) => join(fx.project, '.claude', 'settings.local.json');

async function enable(path: string, plugins: Record<string, boolean>): Promise<void> {
  await writeJson(path, { model: 'test-model', enabledPlugins: plugins });
}

async function signIn(fx: Fixture, account: Account = ACCOUNT): Promise<void> {
  await writeJson(fx.sources.claudeJsonPath, {
    numStartups: 3,
    oauthAccount: { ...account, emailAddress: 'user@example.com' },
  });
}

function syncedDir(config: string, account: Account = ACCOUNT): string {
  return join(config, 'skills', 'synced', `${account.organizationUuid}_${account.accountUuid}`);
}

/** An `assert.rejects` check: `E_INVALID` on `skills`, with every fragment in the message. */
function invalid(...fragments: string[]): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof InvalidInputError, String(error));
    assert.equal(error.code, 'E_INVALID');
    assert.equal(error.field, 'skills');
    assert.ok(error.message.startsWith('skills '), error.message);
    for (const fragment of fragments) {
      assert.ok(error.message.includes(fragment), `${error.message}\n  does not include: ${fragment}`);
    }
    return true;
  };
}

async function resolvedDirs(names: readonly string[], sources: SkillSources): Promise<string[]> {
  return (await resolveSkills(names, sources)).map((skill) => skill.dir);
}

describe('resolveSkills: bare names', () => {
  test('the project root wins over the user root', async (t) => {
    const fx = await fixture(t);
    const projectReview = await addSkill(join(fx.project, '.claude', 'skills'), 'review');
    await addSkill(join(fx.config, 'skills'), 'review');
    const userNotes = await addSkill(join(fx.config, 'skills'), 'notes');
    assert.deepEqual(await resolveSkills(['review', 'notes'], fx.sources), [
      { requested: 'review', name: 'review', dir: projectReview },
      { requested: 'notes', name: 'notes', dir: userNotes },
    ]);
  });

  test('the user root wins over the synced root, and the synced root over the enabled plugins', async (t) => {
    const fx = await fixture(t);
    await signIn(fx);
    const userAlpha = await addSkill(join(fx.config, 'skills'), 'alpha');
    await addSkill(syncedDir(fx.config), 'alpha');
    const syncedBeta = await addSkill(syncedDir(fx.config), 'beta');
    const root = await install(fx, 'tools@market', { skills: ['alpha', 'beta', 'gamma'] });
    await enable(userSettings(fx), { 'tools@market': true });
    assert.deepEqual(await resolvedDirs(['alpha', 'beta', 'gamma'], fx.sources), [
      userAlpha,
      syncedBeta,
      await realpath(join(root, 'skills', 'gamma')),
    ]);
  });

  test('without a project dir the project root is not searched', async (t) => {
    const fx = await fixture(t);
    await addSkill(join(fx.project, '.claude', 'skills'), 'review');
    const userReview = await addSkill(join(fx.config, 'skills'), 'review');
    const sources = { ...fx.sources, projectDir: null };
    assert.deepEqual(await resolvedDirs(['review'], sources), [userReview]);
  });

  test("the synced dir of the signed-in account is read and another account's dir is ignored", async (t) => {
    const fx = await fixture(t);
    await signIn(fx);
    const ownPdf = await addSkill(syncedDir(fx.config), 'pdf');
    await addSkill(syncedDir(fx.config, OTHER_ACCOUNT), 'pdf');
    await addSkill(syncedDir(fx.config, OTHER_ACCOUNT), 'only-other');
    assert.deepEqual(await resolvedDirs(['pdf'], fx.sources), [ownPdf]);
    await assert.rejects(
      resolveSkills(['only-other'], fx.sources),
      invalid('"only-other" was not found', syncedDir(fx.config)),
    );
  });

  test('no oauthAccount gives no synced root', async (t) => {
    const fx = await fixture(t);
    await addSkill(syncedDir(fx.config), 'pdf');
    await addSkill(syncedDir(fx.config, OTHER_ACCOUNT), 'pdf');
    // No .claude.json at all.
    await assert.rejects(
      resolveSkills(['pdf'], fx.sources),
      invalid('"pdf" was not found', `no synced skills (no signed-in account in ${JSON.stringify(fx.sources.claudeJsonPath)})`),
    );
    // A .claude.json without oauthAccount.
    await writeJson(fx.sources.claudeJsonPath, { numStartups: 1, theme: 'dark' });
    await assert.rejects(resolveSkills(['pdf'], fx.sources), invalid('"pdf" was not found', 'no synced skills'));
  });

  test('a signed-in account without a synced dir finds nothing there', async (t) => {
    const fx = await fixture(t);
    await signIn(fx);
    await addSkill(syncedDir(fx.config, OTHER_ACCOUNT), 'pdf');
    await assert.rejects(resolveSkills(['pdf'], fx.sources), invalid('"pdf" was not found', syncedDir(fx.config)));
  });
});

describe('resolveSkills: plugins', () => {
  test('plugin:skill resolves through an installed and enabled plugin', async (t) => {
    const fx = await fixture(t);
    const root = await install(fx, 'tools@market', { skills: ['lint'] });
    await install(fx, 'extras@market', { skills: ['tidy'] });
    await enable(userSettings(fx), { 'tools@market': true, 'ghost@market': true });
    assert.deepEqual(await resolveSkills(['tools:lint'], fx.sources), [
      { requested: 'tools:lint', name: 'lint', dir: await realpath(join(root, 'skills', 'lint')) },
    ]);
    // Installed but not enabled.
    await assert.rejects(
      resolveSkills(['extras:tidy'], fx.sources),
      invalid('"extras:tidy" was not found: no installed and enabled plugin is named "extras"'),
    );
    // Enabled but not installed.
    await assert.rejects(
      resolveSkills(['ghost:lint'], fx.sources),
      invalid('no installed and enabled plugin is named "ghost"'),
    );
    // Enabled, without that skill.
    await assert.rejects(
      resolveSkills(['tools:missing'], fx.sources),
      invalid('"tools:missing" was not found; searched', join(root, 'skills')),
    );
  });

  test("a disabled plugin's duplicate is ignored, also when a later settings file disables it", async (t) => {
    const fx = await fixture(t);
    const alpha = await install(fx, 'alpha@market', { skills: ['format'] });
    await install(fx, 'beta@market', { skills: ['format'] });
    await install(fx, 'gamma@market', { skills: ['format'] });
    const delta = await install(fx, 'delta@market', { skills: ['tidy'] });
    await enable(userSettings(fx), { 'alpha@market': true, 'beta@market': true, 'delta@market': false });
    await enable(projectSettings(fx), { 'gamma@market': false, 'delta@market': true });
    await enable(localSettings(fx), { 'beta@market': false });
    assert.deepEqual(await resolvedDirs(['format'], fx.sources), [await realpath(join(alpha, 'skills', 'format'))]);
    await assert.rejects(resolveSkills(['beta:format'], fx.sources), invalid('no installed and enabled plugin is named "beta"'));
    await assert.rejects(resolveSkills(['gamma:format'], fx.sources), invalid('no installed and enabled plugin is named "gamma"'));
    // A later file can also enable what an earlier one disabled.
    assert.deepEqual(await resolvedDirs(['delta:tidy'], fx.sources), [await realpath(join(delta, 'skills', 'tidy'))]);
  });

  test('a plugin.json skills path is searched, as one path or a list', async (t) => {
    const fx = await fixture(t);
    const tools = await install(fx, 'tools@market', { pluginJson: { name: 'tools', skills: './custom' } });
    const deploy = await addSkill(join(tools, 'custom'), 'deploy');
    const more = await install(fx, 'more@market', { skills: ['base'], pluginJson: { name: 'more', skills: ['./a', 'b/c'] } });
    const first = await addSkill(join(more, 'a'), 'first');
    const second = await addSkill(join(more, 'b', 'c'), 'second');
    await enable(userSettings(fx), { 'tools@market': true, 'more@market': true });
    assert.deepEqual(await resolvedDirs(['tools:deploy', 'deploy'], fx.sources), [deploy]);
    assert.deepEqual(await resolvedDirs(['more:first', 'second', 'more:base'], fx.sources), [
      first,
      second,
      await realpath(join(more, 'skills', 'base')),
    ]);
  });

  test('a plugin.json skills path outside the plugin is refused naming the file', async (t) => {
    for (const outside of ['../outside', '/abs/skills', './a/../../outside']) {
      const fx = await fixture(t);
      const root = await install(fx, 'tools@market', { skills: ['lint'], pluginJson: { skills: [outside] } });
      await enable(userSettings(fx), { 'tools@market': true });
      await assert.rejects(
        resolveSkills(['tools:lint'], fx.sources),
        invalid(JSON.stringify(join(root, '.claude-plugin', 'plugin.json')), 'outside the plugin'),
      );
    }
  });

  test('two hits within one root are ambiguous and the message lists both', async (t) => {
    const fx = await fixture(t);
    const root = await install(fx, 'tools@market', { skills: ['check'], pluginJson: { skills: './extra' } });
    const inSkills = await realpath(join(root, 'skills', 'check'));
    const inExtra = await addSkill(join(root, 'extra'), 'check');
    await enable(userSettings(fx), { 'tools@market': true });
    await assert.rejects(resolveSkills(['tools:check'], fx.sources), invalid('"tools:check" is ambiguous', inSkills, inExtra));
    await assert.rejects(resolveSkills(['check'], fx.sources), invalid('"check" is ambiguous', inSkills, inExtra));
  });

  test('a bare name found in two enabled plugins is ambiguous', async (t) => {
    const fx = await fixture(t);
    const alpha = await install(fx, 'alpha@market', { skills: ['format'] });
    const beta = await install(fx, 'beta@market', { skills: ['format'] });
    await enable(userSettings(fx), { 'alpha@market': true, 'beta@market': true });
    const alphaFormat = await realpath(join(alpha, 'skills', 'format'));
    await assert.rejects(
      resolveSkills(['format'], fx.sources),
      invalid(
        '"format" is ambiguous',
        `${alphaFormat} (plugin alpha@market)`,
        `${await realpath(join(beta, 'skills', 'format'))} (plugin beta@market)`,
      ),
    );
    // The qualified name picks one.
    assert.deepEqual(await resolvedDirs(['alpha:format'], fx.sources), [alphaFormat]);
  });

  test('plugin:skill of a plugin enabled from two marketplaces is ambiguous', async (t) => {
    const fx = await fixture(t);
    await install(fx, 'tools@one', { skills: ['lint'] });
    await install(fx, 'tools@two', { skills: ['lint'] });
    await enable(userSettings(fx), { 'tools@one': true, 'tools@two': true });
    await assert.rejects(
      resolveSkills(['tools:lint'], fx.sources),
      invalid('"tools:lint" is ambiguous: plugin "tools" is installed and enabled as tools@one, tools@two'),
    );
  });

  test('a symlinked duplicate with the same real path is not ambiguous', async (t) => {
    const fx = await fixture(t);
    const tools = await install(fx, 'tools@market', { skills: ['check'], pluginJson: { skills: './extra' } });
    const check = await realpath(join(tools, 'skills', 'check'));
    await mkdir(join(tools, 'extra'), { recursive: true });
    await symlink(check, join(tools, 'extra', 'check'));
    const other = await install(fx, 'other@market');
    await mkdir(join(other, 'skills'), { recursive: true });
    await symlink(check, join(other, 'skills', 'check'));
    await enable(userSettings(fx), { 'tools@market': true, 'other@market': true });
    // Within one plugin and across two plugins.
    assert.deepEqual(await resolveSkills(['tools:check', 'check'], fx.sources), [
      { requested: 'tools:check', name: 'check', dir: check },
    ]);
  });

  test('an install for this project is taken before the user install', async (t) => {
    const fx = await fixture(t);
    await install(fx, 'tools@market', { skills: ['lint'], scope: 'user' });
    await install(fx, 'tools@market', { skills: ['lint'], scope: 'local', projectPath: join(fx.root, 'elsewhere'), dir: 'other-local' });
    const forProject = await install(fx, 'tools@market', { skills: ['lint'], scope: 'project', projectPath: fx.project });
    await enable(userSettings(fx), { 'tools@market': true });
    assert.deepEqual(await resolvedDirs(['tools:lint'], fx.sources), [await realpath(join(forProject, 'skills', 'lint'))]);
    const local = await install(fx, 'tools@market', { skills: ['lint'], scope: 'local', projectPath: fx.project });
    assert.deepEqual(await resolvedDirs(['tools:lint'], fx.sources), [await realpath(join(local, 'skills', 'lint'))]);
    const userOnly = { ...fx.sources, projectDir: null };
    assert.deepEqual(await resolvedDirs(['tools:lint'], userOnly), [
      await realpath(join(fx.config, 'plugins', 'cache', 'market', 'tools', 'user', 'skills', 'lint')),
    ]);
  });
});

describe('resolveSkills: names and errors', () => {
  test('a name that is a path is refused with E_INVALID', async (t) => {
    const fx = await fixture(t);
    await addSkill(join(fx.config, 'skills'), 'review');
    for (const name of ['../review', 'skills/review', 'skills\\review', '/abs/review', `${fx.config}/skills/review`]) {
      await assert.rejects(resolveSkills([name], fx.sources), invalid(`${JSON.stringify(name)} is a path`));
    }
    for (const name of ['.', '..', '', 'tools:', ':review', 'tools:..', 'a:b:c', 'two words', 'tools@market:review']) {
      await assert.rejects(resolveSkills([name], fx.sources), invalid(`${JSON.stringify(name)} is not a skill name`));
    }
    // Every name is checked before any lookup: the path is reported, not the unknown name before it.
    await assert.rejects(resolveSkills(['missing', '../review'], fx.sources), invalid('"../review" is a path'));
  });

  test('a name that is not found names the searched roots', async (t) => {
    const fx = await fixture(t);
    await signIn(fx);
    await install(fx, 'tools@market', { skills: ['lint'] });
    await install(fx, 'more@market', { skills: ['tidy'] });
    await enable(userSettings(fx), { 'tools@market': true, 'more@market': true });
    await assert.rejects(
      resolveSkills(['missing'], fx.sources),
      invalid(
        '"missing" was not found; searched',
        join(fx.project, '.claude', 'skills'),
        join(fx.config, 'skills'),
        syncedDir(fx.config),
        'the enabled plugins tools@market, more@market',
      ),
    );
    const bare = await fixture(t);
    await assert.rejects(resolveSkills(['missing'], bare.sources), invalid('"missing" was not found', 'no enabled plugins'));
  });

  test('two names resolving to the same directory are kept once', async (t) => {
    const fx = await fixture(t);
    const review = await addSkill(join(fx.config, 'skills'), 'review');
    assert.deepEqual(await resolveSkills(['review', 'review'], fx.sources), [
      { requested: 'review', name: 'review', dir: review },
    ]);
  });

  test('two different skills with one directory name are refused', async (t) => {
    const fx = await fixture(t);
    const userLint = await addSkill(join(fx.config, 'skills'), 'lint');
    const root = await install(fx, 'tools@market', { skills: ['lint'] });
    await enable(userSettings(fx), { 'tools@market': true });
    await assert.rejects(
      resolveSkills(['lint', 'tools:lint'], fx.sources),
      invalid(
        '"lint" and "tools:lint" are two skills named "lint"',
        userLint,
        await realpath(join(root, 'skills', 'lint')),
        'must be unique',
      ),
    );
  });

  test('two different skills whose names differ only in case are refused', async (t) => {
    const fx = await fixture(t);
    const lower = await addSkill(join(fx.config, 'skills'), 'lint');
    // On a case-insensitive file system (the macOS default) "Lint" is the same directory.
    if (await stat(join(fx.config, 'skills', 'LINT')).then(() => true, () => false)) {
      t.skip('the file system ignores case');
      return;
    }
    const upper = await addSkill(join(fx.config, 'skills'), 'Lint');
    await assert.rejects(
      resolveSkills(['lint', 'Lint'], fx.sources),
      invalid('"lint" and "Lint" are two skills named "lint" and "Lint"', lower, upper, 'must be unique, ignoring case'),
    );
  });

  test('a malformed settings file fails naming the file, without its content', async (t) => {
    const fx = await fixture(t);
    await addSkill(join(fx.config, 'skills'), 'review');
    await install(fx, 'tools@market', { skills: ['lint'] });
    await enable(userSettings(fx), { 'tools@market': true });
    await writeText(localSettings(fx), '{"enabledPlugins": {"tools@market": true}, "env": {"TOKEN": "fake-token-value-0123"');
    const named = JSON.stringify(localSettings(fx));
    for (const names of [['tools:lint'], ['missing']]) {
      await assert.rejects(resolveSkills(names, fx.sources), (error) => {
        invalid(`cannot be resolved: ${named} is not valid JSON`)(error);
        assert.ok(!(error as Error).message.includes('fake-token-value'), (error as Error).message);
        return true;
      });
    }
    // A name the user root holds never needs the settings.
    assert.equal((await resolveSkills(['review'], fx.sources)).length, 1);

    await enable(localSettings(fx), {});
    await writeJson(projectSettings(fx), { enabledPlugins: { 'tools@market': 'yes' } });
    await assert.rejects(
      resolveSkills(['tools:lint'], fx.sources),
      invalid(JSON.stringify(projectSettings(fx)), 'value for "tools@market" that is not true or false'),
    );
    await writeJson(projectSettings(fx), { enabledPlugins: ['tools@market'] });
    await assert.rejects(
      resolveSkills(['tools:lint'], fx.sources),
      invalid(JSON.stringify(projectSettings(fx)), '"enabledPlugins" that is not an object'),
    );
  });

  test('a malformed registry, plugin.json or .claude.json fails naming the file', async (t) => {
    const registryFx = await fixture(t);
    await enable(userSettings(registryFx), { 'tools@market': true });
    const registry = join(registryFx.config, 'plugins', 'installed_plugins.json');
    await writeText(registry, '[not json');
    await assert.rejects(resolveSkills(['tools:lint'], registryFx.sources), invalid(JSON.stringify(registry), 'is not valid JSON'));
    await writeJson(registry, { version: 2, plugins: { 'tools@market': { scope: 'user' } } });
    await assert.rejects(resolveSkills(['tools:lint'], registryFx.sources), invalid(JSON.stringify(registry), 'not a list of objects'));
    await writeJson(registry, { version: 2, plugins: { 'tools@market': [{ scope: 'user', installPath: 'relative/path' }] } });
    await assert.rejects(resolveSkills(['tools:lint'], registryFx.sources), invalid(JSON.stringify(registry), 'without an absolute "installPath"'));

    const pluginFx = await fixture(t);
    const root = await install(pluginFx, 'tools@market', { skills: ['lint'] });
    await enable(userSettings(pluginFx), { 'tools@market': true });
    const pluginJson = join(root, '.claude-plugin', 'plugin.json');
    await writeText(pluginJson, '{"skills": ');
    await assert.rejects(resolveSkills(['tools:lint'], pluginFx.sources), invalid(JSON.stringify(pluginJson), 'is not valid JSON'));
    await writeJson(pluginJson, { skills: 42 });
    await assert.rejects(resolveSkills(['tools:lint'], pluginFx.sources), invalid(JSON.stringify(pluginJson), 'not a path or a list of paths'));

    const accountFx = await fixture(t);
    const claudeJson = accountFx.sources.claudeJsonPath;
    await writeText(claudeJson, '{"oauthAccount": {"accountUuid": "fake-token-value-0123"');
    await assert.rejects(resolveSkills(['missing'], accountFx.sources), (error) => {
      invalid(JSON.stringify(claudeJson), 'is not valid JSON')(error);
      assert.ok(!(error as Error).message.includes('fake-token-value'), (error as Error).message);
      return true;
    });
    await writeJson(claudeJson, { oauthAccount: { organizationUuid: ACCOUNT.organizationUuid, accountUuid: '../../escape' } });
    await assert.rejects(
      resolveSkills(['missing'], accountFx.sources),
      invalid(JSON.stringify(claudeJson), 'without a valid organizationUuid and accountUuid'),
    );
  });
});

describe('skillSourcesFromEnv', () => {
  test('$CLAUDE_CONFIG_DIR honoured: it replaces ~/.claude and ~/.claude.json', async (t) => {
    assert.deepEqual(
      skillSourcesFromEnv({ HOME: '/home/tester', CLAUDE_CONFIG_DIR: '/opt/claude-config', CLAUDE_PROJECT_DIR: '/work/project' }),
      { configDir: '/opt/claude-config', claudeJsonPath: '/opt/claude-config/.claude.json', projectDir: '/work/project' },
    );
    assert.deepEqual(skillSourcesFromEnv({ HOME: '/home/tester', CLAUDE_CONFIG_DIR: '' }), {
      configDir: '/home/tester/.claude',
      claudeJsonPath: '/home/tester/.claude.json',
      projectDir: null,
    });

    // End to end: every lookup goes to the config dir; the decoys under ~/.claude are never used.
    const fx = await fixture(t);
    await signIn(fx, ACCOUNT);
    await addSkill(join(fx.config, 'skills'), 'review');
    await addSkill(syncedDir(fx.config, ACCOUNT), 'pdf');
    await addSkill(syncedDir(fx.config, OTHER_ACCOUNT), 'pdf');
    await install(fx, 'tools@market', { skills: ['lint'] });
    await enable(userSettings(fx), { 'tools@market': true });

    const altConfig = join(fx.root, 'alt-config');
    const alt: Fixture = { ...fx, config: altConfig, registry: {} };
    const altReview = await addSkill(join(altConfig, 'skills'), 'review');
    const altPdf = await addSkill(syncedDir(altConfig, OTHER_ACCOUNT), 'pdf');
    await addSkill(syncedDir(altConfig, ACCOUNT), 'pdf');
    await writeJson(join(altConfig, '.claude.json'), { oauthAccount: OTHER_ACCOUNT });
    const altTools = await install(alt, 'tools@market', { skills: ['lint'], dir: 'alt' });
    await enable(join(altConfig, 'settings.json'), { 'tools@market': true });

    const sources = skillSourcesFromEnv({ HOME: fx.home, CLAUDE_CONFIG_DIR: altConfig, CLAUDE_PROJECT_DIR: fx.project });
    assert.deepEqual(sources, { configDir: altConfig, claudeJsonPath: join(altConfig, '.claude.json'), projectDir: fx.project });
    assert.deepEqual(await resolvedDirs(['review', 'pdf', 'tools:lint'], sources), [
      altReview,
      altPdf,
      await realpath(join(altTools, 'skills', 'lint')),
    ]);
    // Without the variable the same tree resolves under ~/.claude.
    const homeSources = skillSourcesFromEnv({ HOME: fx.home, CLAUDE_PROJECT_DIR: fx.project });
    assert.deepEqual(homeSources, fx.sources);
    assert.deepEqual(await resolvedDirs(['pdf'], homeSources), [await realpath(join(syncedDir(fx.config, ACCOUNT), 'pdf'))]);
  });
});

describe('resolveSkills: the copy rules', () => {
  const SECRET = 'outside-secret-0123';

  test('a project skill with a link leading outside it is refused naming the skill and the link, never content', async (t) => {
    const fx = await fixture(t);
    const keys = join(fx.root, 'keys');
    await writeText(join(keys, 'id_test'), SECRET);
    const skill = await addSkill(join(fx.project, '.claude', 'skills'), 'planted');
    for (const [name, target] of [['key-file', join(keys, 'id_test')], ['key-dir', keys]] as const) {
      const link = join(skill, name);
      await symlink(target, link);
      await assert.rejects(resolveSkills(['planted'], fx.sources), (error: unknown) => {
        invalid('cannot be copied: skill "planted"', JSON.stringify(link), 'is a link that leads outside the skill')(error);
        assert.ok(!(error as Error).message.includes(SECRET));
        return true;
      });
      await rm(link);
    }
  });

  test('a skill directory that is itself a symlink resolves with links inside it', async (t) => {
    const fx = await fixture(t);
    const real = await addSkill(join(fx.root, 'store'), 'lint');
    await writeText(join(real, 'docs', 'guide.md'), '# Guide\n');
    await symlink(join(real, 'docs', 'guide.md'), join(real, 'guide.md'));
    await symlink('docs', join(real, 'more'));
    await mkdir(join(fx.config, 'skills'), { recursive: true });
    await symlink(real, join(fx.config, 'skills', 'lint'));
    assert.deepEqual(await resolveSkills(['lint'], fx.sources), [{ requested: 'lint', name: 'lint', dir: real }]);
  });

  test('a dangling link inside a skill is refused naming the link', async (t) => {
    const fx = await fixture(t);
    const skill = await addSkill(join(fx.config, 'skills'), 'lint');
    const link = join(skill, 'gone.md');
    await symlink(join(skill, 'missing.md'), link);
    await assert.rejects(resolveSkills(['lint'], fx.sources), invalid('cannot be copied:', JSON.stringify(link), '(ENOENT)'));
  });

  test('the injected limits count all skills together', async (t) => {
    const fx = await fixture(t);
    const lint = await addSkill(join(fx.config, 'skills'), 'lint');
    const review = await addSkill(join(fx.config, 'skills'), 'review');
    const bytes = (await stat(join(lint, 'SKILL.md'))).size + (await stat(join(review, 'SKILL.md'))).size;
    // Two skills: each its directory and its SKILL.md.
    assert.equal((await resolveSkills(['lint', 'review'], fx.sources, { entries: 4, bytes })).length, 2);
    await assert.rejects(
      resolveSkills(['lint', 'review'], fx.sources, { entries: 3, bytes }),
      invalid('cannot be copied: the skills hold more than 3 files and directories together'),
    );
    await assert.rejects(
      resolveSkills(['lint', 'review'], fx.sources, { entries: 4, bytes: bytes - 1 }),
      invalid(`cannot be copied: the skills hold more than ${bytes - 1} bytes together`),
    );
  });

  test('more than 10 000 entries for one start is refused', async (t) => {
    const fx = await fixture(t);
    const skill = await addSkill(join(fx.config, 'skills'), 'big');
    // The directory and SKILL.md are two entries: 9 998 more files make 10 000, one more is over.
    const names = Array.from({ length: 9_998 }, (_, index) => `f${index}`);
    for (let at = 0; at < names.length; at += 500) {
      await Promise.all(names.slice(at, at + 500).map((name) => writeFile(join(skill, name), '')));
    }
    assert.equal((await resolveSkills(['big'], fx.sources)).length, 1);
    await writeFile(join(skill, 'one-more'), '');
    await assert.rejects(
      resolveSkills(['big'], fx.sources),
      invalid('cannot be copied: the skills hold more than 10000 files and directories together'),
    );
  });

  test('more than 100 MiB for one start is refused, counted from the sizes before anything is read', async (t) => {
    const fx = await fixture(t);
    const skill = await addSkill(join(fx.config, 'skills'), 'big');
    const skillBytes = (await stat(join(skill, 'SKILL.md'))).size;
    // A sparse file: its size counts, no disk space is used.
    await writeFile(join(skill, 'blob.bin'), '');
    await truncate(join(skill, 'blob.bin'), 100 * 1024 * 1024 - skillBytes);
    assert.equal((await resolveSkills(['big'], fx.sources)).length, 1);
    await writeFile(join(skill, 'one-more'), 'x');
    await assert.rejects(
      resolveSkills(['big'], fx.sources),
      invalid(`cannot be copied: the skills hold more than ${100 * 1024 * 1024} bytes together`),
    );
  });
});
