import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { spawnProcess } from '../../src/acp/process.ts';
import type { ProcessSpec } from '../../src/acp/process.ts';
import { SidecarError } from '../../src/errors.ts';
import { PROTOCOL_STEERING, PROTOCOL_STEERING_FILE } from '../../src/session/protocol-steering.ts';
import { readCall } from '../../src/store/runs.ts';
import { InvalidInputError } from '../../src/text/errors.ts';
import { tempDir } from '../helpers/processes.ts';
import { PROCESS_TIMEOUT, TEST_TOKEN, managerFixture, metaOf, testEnvironment } from './manager-helpers.ts';
import type { ManagerFixture } from './manager-helpers.ts';

const SKILL_TEXT = (name: string): string => `---\nname: ${name}\ndescription: A test skill.\n---\nDo the thing.\n`;
const RULES_TEXT = '---\ninclusion: always\n---\nKeep the public API.\n';
const STYLE_TEXT = '---\ninclusion: always\n---\nUse short functions.\n';

/** A Claude config dir with skills, and steering files, in a temp dir of the test. */
interface Sources {
  readonly root: string;
  /** `CLAUDE_CONFIG_DIR`: its `skills/` is where bare skill names are found. */
  readonly config: string;
  readonly env: Record<string, string | undefined>;
  /** `<config>/skills/lint`: a real directory with a symlinked file and a symlinked directory inside, both into `files/` of it. */
  readonly lint: string;
  /** `<config>/skills/review`: a symlink to a directory named otherwise. */
  readonly review: string;
  /** A regular steering file. */
  readonly rules: string;
  /** A symlink to a steering file named otherwise. */
  readonly style: string;
}

async function sources(t: TestContext): Promise<Sources> {
  const root = await tempDir(t);
  const config = join(root, 'config');
  const skills = join(config, 'skills');
  const outside = join(root, 'outside');
  await mkdir(outside, { recursive: true });
  const lint = join(skills, 'lint');
  // The links point inside the skill: a link leading outside it is refused (spec 7).
  const files = join(lint, 'files');
  await mkdir(join(files, 'shared'), { recursive: true });
  await writeFile(join(files, 'notes.md'), '# Notes\n');
  await writeFile(join(files, 'shared', 'guide.md'), '# Guide\n');
  await writeFile(join(lint, 'SKILL.md'), SKILL_TEXT('lint'));
  await symlink(join(files, 'notes.md'), join(lint, 'notes.md'));
  await symlink(join('files', 'shared'), join(lint, 'shared'));
  const reviewSource = join(outside, 'review-source');
  await mkdir(reviewSource);
  await writeFile(join(reviewSource, 'SKILL.md'), SKILL_TEXT('review'));
  const review = join(skills, 'review');
  await symlink(reviewSource, review);
  const rules = join(root, 'rules.md');
  await writeFile(rules, RULES_TEXT);
  await writeFile(join(outside, 'style-source.md'), STYLE_TEXT);
  const style = join(root, 'style.md');
  await symlink(join(outside, 'style-source.md'), style);
  return { root, config, env: testEnvironment({ CLAUDE_CONFIG_DIR: config }), lint, review, rules, style };
}

/**
 * A manager whose docker host checks pass and whose `docker run` is replaced
 * by the fake agent; `atSpawn` sees each spec at the moment of the spawn,
 * and `afterValidation` runs at the first host check, after the start's
 * arguments were checked and before anything is copied.
 */
async function dockerFixture(
  t: TestContext,
  env: Record<string, string | undefined>,
  atSpawn: (spec: ProcessSpec) => void = () => {},
  afterValidation: () => Promise<void> = async () => {},
): Promise<{ fixture: ManagerFixture; specs: ProcessSpec[] }> {
  const specs: ProcessSpec[] = [];
  let command = '';
  let agentDir = '';
  const fixture = await managerFixture(t, 'default', {
    env,
    settings: { api_key: TEST_TOKEN },
    deps: {
      resolveDockerUser: async () => {
        await afterValidation();
        return '0:0';
      },
      checkImage: async () => {},
      spawn: (spec, options) => {
        atSpawn(spec);
        specs.push(spec);
        // The fake agent runs in its workspace, which holds its scenario, whatever dir the start was given.
        return spawnProcess(
          { argv: [command, 'acp', '--agent-engine', 'v3'], env: testEnvironment() as Record<string, string>, cwd: agentDir },
          options,
        );
      },
      removeContainers: () => {},
    },
  });
  command = fixture.workspace.command;
  agentDir = fixture.workspace.dir;
  return { fixture, specs };
}

/** The source of the `--mount` whose destination is `dst`. */
function mountSource(argv: readonly string[], dst: string): string {
  const value = argv.find((arg) => arg.includes(`,dst=${dst},`) || arg.endsWith(`,dst=${dst}`)) ?? '';
  return /src=([^,]+)/.exec(value)?.[1] ?? '';
}

/** What a spawn sees in the run's copy dirs. */
interface SeenCopies {
  readonly skills: string[];
  readonly lintSkill: string;
  readonly reviewSkill: string;
  readonly notes: { readonly file: boolean; readonly link: boolean; readonly text: string };
  readonly shared: { readonly dir: boolean; readonly link: boolean; readonly text: string };
  readonly reviewLink: boolean;
  readonly steering: string[];
  readonly rules: string;
  readonly style: string;
  readonly styleLink: boolean;
  readonly protocol: string;
}

function seeCopies(spec: ProcessSpec): SeenCopies {
  const skills = mountSource(spec.argv, '/home/agent/.kiro/skills');
  const steering = mountSource(spec.argv, '/home/agent/.kiro/steering');
  const notes = lstatSync(join(skills, 'lint', 'notes.md'));
  const shared = lstatSync(join(skills, 'lint', 'shared'));
  return {
    skills: readdirSync(skills).sort(),
    lintSkill: readFileSync(join(skills, 'lint', 'SKILL.md'), 'utf8'),
    reviewSkill: readFileSync(join(skills, 'review', 'SKILL.md'), 'utf8'),
    notes: { file: notes.isFile(), link: notes.isSymbolicLink(), text: readFileSync(join(skills, 'lint', 'notes.md'), 'utf8') },
    shared: {
      dir: shared.isDirectory(),
      link: shared.isSymbolicLink(),
      text: readFileSync(join(skills, 'lint', 'shared', 'guide.md'), 'utf8'),
    },
    reviewLink: lstatSync(join(skills, 'review')).isSymbolicLink(),
    steering: readdirSync(steering).sort(),
    rules: readFileSync(join(steering, 'rules.md'), 'utf8'),
    style: readFileSync(join(steering, 'style.md'), 'utf8'),
    styleLink: lstatSync(join(steering, 'style.md')).isSymbolicLink(),
    protocol: readFileSync(join(steering, PROTOCOL_STEERING_FILE), 'utf8'),
  };
}

async function runIds(stateDir: string): Promise<string[]> {
  try {
    return await readdir(join(stateDir, 'runs'));
  } catch {
    return [];
  }
}

function assertInvalid(error: unknown, field: string, fragment: string): boolean {
  assert.ok(error instanceof SidecarError || error instanceof InvalidInputError, `unexpected ${String(error)}`);
  assert.equal(error.code, 'E_INVALID', error.message);
  assert.equal((error as InvalidInputError).field, field, error.message);
  assert.ok(error.message.includes(fragment), error.message);
  return true;
}

describe('SessionManager.start with skills and steering in docker mode', () => {
  test('the copies are in the run at spawn, next to the protocol steering, and meta and the reply list them', PROCESS_TIMEOUT, async (t) => {
    const src = await sources(t);
    const seen: SeenCopies[] = [];
    const { fixture, specs } = await dockerFixture(t, src.env, (spec) => seen.push(seeCopies(spec)));
    const result = await fixture.manager.start({
      mode: 'docker',
      dir: fixture.workspace.dir,
      skills: ['lint', 'review'],
      steering: [src.rules, src.style],
    });
    assert.equal(specs.length, 1);
    assert.deepEqual(seen, [
      {
        skills: ['lint', 'review'],
        lintSkill: SKILL_TEXT('lint'),
        reviewSkill: SKILL_TEXT('review'),
        notes: { file: true, link: false, text: '# Notes\n' },
        shared: { dir: true, link: false, text: '# Guide\n' },
        reviewLink: false,
        steering: ['rules.md', PROTOCOL_STEERING_FILE, 'style.md'].sort(),
        rules: RULES_TEXT,
        style: STYLE_TEXT,
        styleLink: false,
        protocol: PROTOCOL_STEERING,
      },
    ]);
    assert.deepEqual(result.skills, ['lint', 'review']);
    assert.deepEqual(result.steering, ['rules.md', 'style.md']);
    const meta = await metaOf(fixture.stateDir, result.launchId);
    assert.deepEqual(meta.skills, ['lint', 'review']);
    assert.deepEqual(meta.steering, [src.rules, src.style]);
  });

  test('empty lists are the same as omitted', PROCESS_TIMEOUT, async (t) => {
    const src = await sources(t);
    const { fixture, specs } = await dockerFixture(t, src.env);
    const result = await fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir, skills: [], steering: [] });
    assert.equal(specs.length, 1);
    assert.deepEqual(result.skills, []);
    assert.deepEqual(result.steering, []);
    const run = join(fixture.stateDir, 'runs', result.launchId);
    assert.deepEqual(await readdir(join(run, 'skills')), []);
    assert.deepEqual(await readdir(join(run, 'steering')), [PROTOCOL_STEERING_FILE]);
    const meta = await metaOf(fixture.stateDir, result.launchId);
    assert.deepEqual([meta.skills, meta.steering], [[], []]);
  });

  test('a skill given twice by its name is copied once', PROCESS_TIMEOUT, async (t) => {
    const src = await sources(t);
    const { fixture } = await dockerFixture(t, src.env);
    const result = await fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir, skills: ['lint', 'lint'] });
    assert.deepEqual(result.skills, ['lint']);
    assert.deepEqual((await metaOf(fixture.stateDir, result.launchId)).skills, ['lint']);
  });

  const refusals: Array<{ name: string; field: 'skills' | 'steering'; fragment: string; params: (src: Sources) => Record<string, unknown> }> = [
    { name: 'an unknown skill', field: 'skills', fragment: '"missing-skill" was not found', params: () => ({ skills: ['missing-skill'] }) },
    { name: 'a skill path', field: 'skills', fragment: 'is a path', params: (src) => ({ skills: [src.lint] }) },
    { name: 'a relative steering path', field: 'steering', fragment: 'must hold absolute paths', params: () => ({ steering: ['rules.md'] }) },
    {
      name: 'a missing steering file',
      field: 'steering',
      fragment: 'does not exist',
      params: (src) => ({ steering: [join(src.root, 'missing.md')] }),
    },
    { name: 'a steering directory', field: 'steering', fragment: 'must hold regular files', params: (src) => ({ steering: [join(src.config, 'skills', 'lint', 'shared.md')] }) },
    {
      name: 'a steering file that is not markdown',
      field: 'steering',
      fragment: 'whose names end in ".md"',
      params: (src) => ({ steering: [join(src.lint, 'SKILL.txt')] }),
    },
    {
      name: 'a second steering file with the same name',
      field: 'steering',
      fragment: 'are two files named "rules.md"',
      params: (src) => ({ steering: [src.rules, join(src.config, 'rules.md')] }),
    },
    {
      name: 'a steering file named sidecar-protocol.md',
      field: 'steering',
      fragment: 'is named "sidecar-protocol.md", which is reserved',
      params: (src) => ({ steering: [join(src.root, PROTOCOL_STEERING_FILE)] }),
    },
    { name: 'a skills value that is not a list', field: 'skills', fragment: 'must be an array of strings', params: () => ({ skills: 'lint' }) },
    {
      name: 'a skill with a link leading outside it',
      field: 'skills',
      fragment: 'cannot be copied: skill "planted": ',
      params: () => ({ skills: ['planted'] }),
    },
  ];
  for (const refusal of refusals) {
    test(`${refusal.name} is refused before anything is written or spawned`, PROCESS_TIMEOUT, async (t) => {
      const src = await sources(t);
      // Files the cases name: a directory with a markdown name, a text file, a second rules.md, a reserved name,
      // a skill with a link to a file outside it.
      const planted = join(src.config, 'skills', 'planted');
      await mkdir(planted);
      await writeFile(join(planted, 'SKILL.md'), SKILL_TEXT('planted'));
      await writeFile(join(src.root, 'outside', 'key.txt'), 'outside-secret-0123\n');
      await symlink(join(src.root, 'outside', 'key.txt'), join(planted, 'key.txt'));
      await mkdir(join(src.config, 'skills', 'lint', 'shared.md'));
      await writeFile(join(src.lint, 'SKILL.txt'), 'Not markdown.\n');
      await writeFile(join(src.config, 'rules.md'), '# Other rules\n');
      await writeFile(join(src.root, PROTOCOL_STEERING_FILE), '# Mine\n');
      const { fixture, specs } = await dockerFixture(t, src.env);
      const toolUseId = 'toolu_skills_refused';
      await assert.rejects(
        fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir, ...refusal.params(src) } as never, { toolUseId }),
        (error) => assertInvalid(error, refusal.field, refusal.fragment),
      );
      assert.deepEqual(specs, []);
      assert.deepEqual(await runIds(fixture.stateDir), []);
      assert.equal(await readCall(fixture.stateDir, toolUseId), undefined);
    });
  }

  for (const kind of ['skill', 'steering file'] as const) {
    test(
      `a ${kind} that cannot be copied fails the start at the spawn step, before any container`,
      { ...PROCESS_TIMEOUT, skip: process.getuid?.() === 0 ? 'root reads every file' : false },
      async (t) => {
        const src = await sources(t);
        const locked = kind === 'skill' ? join(src.lint, 'locked.md') : src.rules;
        await writeFile(locked, '# Locked\n', { flag: 'w' });
        await chmod(locked, 0o000);
        const { fixture, specs } = await dockerFixture(t, src.env);
        const toolUseId = `toolu_copy_failed_${kind === 'skill' ? 'skill' : 'steering'}`;
        const params = kind === 'skill' ? { skills: ['lint'] } : { steering: [src.rules] };
        await assert.rejects(
          fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir, ...params }, { toolUseId }),
          (error: unknown) => {
            assert.ok(error instanceof SidecarError, String(error));
            assert.equal(error.code, 'E_STEP_SPAWN', error.message);
            assert.match(error.message, /^start step spawn failed/);
            return true;
          },
        );
        assert.deepEqual(specs, []);
        const ids = await runIds(fixture.stateDir);
        assert.equal(ids.length, 1);
        assert.equal((await metaOf(fixture.stateDir, ids[0] as string)).state, 'failed');
        const record = (await readCall(fixture.stateDir, toolUseId)) as { failed?: boolean } | undefined;
        assert.equal(record?.failed, true, JSON.stringify(record));
        assert.deepEqual(fixture.errors, []);
      },
    );
  }

  test('a link turned to lead outside after validation fails the start at the spawn step and is not copied', PROCESS_TIMEOUT, async (t) => {
    const src = await sources(t);
    const secret = 'outside-secret-0123';
    await writeFile(join(src.root, 'outside', 'key.txt'), `${secret}\n`);
    const link = join(src.lint, 'zz-later.md');
    await symlink(join(src.lint, 'files', 'notes.md'), link);
    const { fixture, specs } = await dockerFixture(t, src.env, undefined, async () => {
      await rm(link);
      await symlink(join(src.root, 'outside', 'key.txt'), link);
    });
    const toolUseId = 'toolu_copy_escaped';
    await assert.rejects(
      fixture.manager.start({ mode: 'docker', dir: fixture.workspace.dir, skills: ['lint'] }, { toolUseId }),
      (error: unknown) => {
        assert.ok(error instanceof SidecarError, String(error));
        assert.equal(error.code, 'E_STEP_SPAWN', error.message);
        assert.match(error.message, /^start step spawn failed: skill "lint": ".*zz-later\.md" is a link that leads outside the skill/);
        assert.ok(!error.message.includes(secret));
        return true;
      },
    );
    assert.deepEqual(specs, []);
    const ids = await runIds(fixture.stateDir);
    assert.equal(ids.length, 1);
    const run = join(fixture.stateDir, 'runs', ids[0] as string);
    assert.equal((await metaOf(fixture.stateDir, ids[0] as string)).state, 'failed');
    const record = (await readCall(fixture.stateDir, toolUseId)) as { failed?: boolean } | undefined;
    assert.equal(record?.failed, true, JSON.stringify(record));
    const copied = await readdir(join(run, 'skills', 'lint'), { recursive: true });
    assert.ok(copied.includes('SKILL.md'), JSON.stringify(copied));
    assert.ok(!copied.some((path) => path.includes('zz-later')), JSON.stringify(copied));
    for (const path of await readdir(run, { recursive: true, withFileTypes: true })) {
      if (path.isFile()) {
        assert.ok(!readFileSync(join(path.parentPath, path.name), 'utf8').includes(secret), join(path.parentPath, path.name));
      }
    }
    assert.deepEqual(fixture.errors, []);
  });
});

describe('SessionManager.start with skills and steering in local mode', () => {
  for (const field of ['skills', 'steering'] as const) {
    test(`${field} is refused, before anything is written or spawned`, PROCESS_TIMEOUT, async (t) => {
      const src = await sources(t);
      const fixture = await managerFixture(t, 'default', { env: src.env });
      const toolUseId = `toolu_local_${field}`;
      const params = field === 'skills' ? { skills: ['lint'] } : { steering: [src.rules] };
      await assert.rejects(fixture.manager.start({ mode: 'local', dir: fixture.workspace.dir, ...params }, { toolUseId }), (error) =>
        assertInvalid(error, field, `${field} is available in docker mode only in this version`),
      );
      assert.deepEqual(await runIds(fixture.stateDir), []);
      assert.equal(await readCall(fixture.stateDir, toolUseId), undefined);
      await assert.rejects(fixture.workspace.started());
    });
  }

  test('empty lists are the same as omitted', PROCESS_TIMEOUT, async (t) => {
    const fixture = await managerFixture(t, 'default');
    const result = await fixture.manager.start({ mode: 'local', dir: fixture.workspace.dir, skills: [], steering: [] });
    assert.deepEqual([result.skills, result.steering], [[], []]);
    const meta = await metaOf(fixture.stateDir, result.launchId);
    assert.deepEqual([meta.skills, meta.steering], [[], []]);
  });
});
