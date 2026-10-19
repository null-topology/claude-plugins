import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkSkillTrees, copySkills, copySteering, SkillTreeError } from '../../src/session/run-copies.ts';
import { tempDir } from '../helpers/processes.ts';

/** The content of the file a link outside the skill points at; it must never reach a copy or a message. */
const SECRET_TEXT = 'outside-secret-0123';

/** A directory outside any skill holding `id_test`; returns its real path. */
async function outsideSecret(root: string): Promise<string> {
  const dir = join(root, 'outside-keys');
  await mkdir(dir);
  await writeFile(join(dir, 'id_test'), SECRET_TEXT);
  return realpath(dir);
}

/** Every regular file under `dir` (not following links) by its relative path, with its text. */
async function treeTexts(dir: string): Promise<Record<string, string>> {
  const texts: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      texts[path.slice(dir.length + 1)] = await readFile(path, 'utf8');
    }
  }
  return texts;
}

/** The entries and bytes of a skill as its copy holds them, measured on a copy made without limits. */
async function treeSizes(skill: string): Promise<{ entries: number; bytes: number }> {
  const target = await mkdtempIn(join(skill, '..'));
  await copySkills([{ name: 'measured', dir: skill }], target);
  let entries = 1;
  let bytes = 0;
  for (const entry of await readdir(join(target, 'measured'), { recursive: true, withFileTypes: true })) {
    entries += 1;
    if (entry.isFile()) {
      bytes += (await stat(join(entry.parentPath, entry.name))).size;
    }
  }
  return { entries, bytes };
}

async function mkdtempIn(dir: string): Promise<string> {
  return mkdtemp(join(dir, 'copy-'));
}

/**
 * A skill directory with a script, and a symlinked file and a symlinked
 * directory, both pointing into its own `files/` (a link leading outside the
 * skill is refused).
 */
async function skillTree(root: string): Promise<string> {
  const skill = join(root, 'source', 'lint');
  const files = join(skill, 'files');
  await mkdir(join(files, 'shared'), { recursive: true });
  await writeFile(join(files, 'notes.md'), '# Notes\n');
  await writeFile(join(files, 'shared', 'guide.md'), '# Guide\n');
  await mkdir(join(skill, 'scripts'), { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: lint\ndescription: Lint the code.\n---\nRun the linter.\n');
  await writeFile(join(skill, 'scripts', 'run.sh'), '#!/bin/sh\necho lint\n', { mode: 0o755 });
  await symlink(join(files, 'notes.md'), join(skill, 'notes.md'));
  await symlink(join('files', 'shared'), join(skill, 'shared'));
  return realpath(skill);
}

describe('copySkills', () => {
  test('copies a skill tree with every symlink dereferenced and file modes kept', async (t) => {
    const root = await tempDir(t);
    const skill = await skillTree(root);
    const target = join(root, 'run-skills');
    await mkdir(target);
    await copySkills([{ name: 'lint', dir: skill }], target);
    const copy = join(target, 'lint');
    assert.deepEqual((await readdir(copy)).sort(), ['SKILL.md', 'files', 'notes.md', 'scripts', 'shared']);
    assert.equal(await readFile(join(copy, 'SKILL.md'), 'utf8'), await readFile(join(skill, 'SKILL.md'), 'utf8'));
    const notes = await lstat(join(copy, 'notes.md'));
    assert.ok(notes.isFile() && !notes.isSymbolicLink(), 'notes.md is a real file');
    assert.equal(await readFile(join(copy, 'notes.md'), 'utf8'), '# Notes\n');
    const shared = await lstat(join(copy, 'shared'));
    assert.ok(shared.isDirectory() && !shared.isSymbolicLink(), 'shared is a real directory');
    assert.equal(await readFile(join(copy, 'shared', 'guide.md'), 'utf8'), '# Guide\n');
    assert.equal((await stat(join(copy, 'scripts', 'run.sh'))).mode & 0o777, 0o755);
  });

  test('a skill directory that is itself a symlink is copied from its real path, its inner links as real files', async (t) => {
    const root = await tempDir(t);
    const real = await skillTree(root);
    const linked = join(root, 'installed-lint');
    await symlink(real, linked);
    const target = join(root, 'run-skills');
    await mkdir(target);
    await copySkills([{ name: 'lint', dir: await realpath(linked) }], target);
    const copy = join(target, 'lint');
    assert.ok((await lstat(copy)).isDirectory(), 'the copy is a real directory');
    assert.ok((await lstat(join(copy, 'notes.md'))).isFile(), 'notes.md is a real file');
    assert.equal(await readFile(join(copy, 'shared', 'guide.md'), 'utf8'), '# Guide\n');
  });

  for (const kind of ['file', 'directory'] as const) {
    test(`a link to a ${kind} outside the skill fails the copy and nothing of it is copied`, async (t) => {
      const root = await tempDir(t);
      const skill = await skillTree(root);
      const secret = await outsideSecret(root);
      const link = join(skill, 'zz-escape');
      await symlink(kind === 'file' ? join(secret, 'id_test') : secret, link);
      const target = join(root, 'run-skills');
      await mkdir(target);
      await assert.rejects(copySkills([{ name: 'lint', dir: skill }], target), (error: unknown) => {
        assert.ok(error instanceof SkillTreeError, String(error));
        assert.match(error.message, /^skill "lint": ".*zz-escape" is a link that leads outside the skill$/);
        assert.ok(!error.message.includes(SECRET_TEXT));
        return true;
      });
      // The entries before it are copied; the link and what it points at are not.
      const copied = await treeTexts(target);
      assert.ok('lint/SKILL.md' in copied, JSON.stringify(Object.keys(copied)));
      assert.ok(!Object.keys(copied).some((path) => path.includes('zz-escape')), JSON.stringify(Object.keys(copied)));
      assert.ok(!Object.values(copied).includes(SECRET_TEXT));
    });
  }

  test('a link to the skill root or a directory holding it is refused as a loop', async (t) => {
    const root = await tempDir(t);
    const skill = await skillTree(root);
    await symlink(skill, join(skill, 'files', 'shared', 'up'));
    const target = join(root, 'run-skills');
    await mkdir(target);
    await assert.rejects(copySkills([{ name: 'lint', dir: skill }], target), /"lint": ".*up" is a link back to a directory that holds it/);
  });

  test('a fifo inside the skill is refused, never read', async (t) => {
    const root = await tempDir(t);
    const skill = await skillTree(root);
    const made = spawnSync('mkfifo', [join(skill, 'pipe')]);
    if (made.status !== 0) {
      t.skip('mkfifo is not available');
      return;
    }
    const target = join(root, 'run-skills');
    await mkdir(target);
    await assert.rejects(copySkills([{ name: 'lint', dir: skill }], target), /"lint": ".*pipe" is neither a regular file nor a directory/);
  });

  test('a skill directory that is no longer its own real path is refused', async (t) => {
    const root = await tempDir(t);
    const skill = await skillTree(root);
    const secret = await outsideSecret(root);
    // Resolved as a real directory, then replaced by a link to another place.
    await rename(skill, `${skill}-moved`);
    await symlink(secret, skill);
    const target = join(root, 'run-skills');
    await mkdir(target);
    await assert.rejects(copySkills([{ name: 'lint', dir: skill }], target), /has changed since it was resolved/);
    assert.deepEqual(await treeTexts(target), {});
  });

  test('the limits count the entries and the bytes of all skills together', async (t) => {
    const root = await tempDir(t);
    const first = await skillTree(root);
    const second = join(root, 'source', 'review');
    await mkdir(second);
    await writeFile(join(second, 'SKILL.md'), '0123456789');
    const skills = [{ name: 'lint', dir: first }, { name: 'review', dir: await realpath(second) }];
    // lint as the copy holds it, links followed; review: itself and its SKILL.md of 10 bytes.
    const sizes = await treeSizes(first);
    const entries = sizes.entries + 2;
    const bytes = sizes.bytes + 10;
    await checkSkillTrees(skills, { entries, bytes });
    await assert.rejects(checkSkillTrees(skills, { entries: entries - 1, bytes }), {
      name: 'SkillTreeError',
      message: `the skills hold more than ${entries - 1} files and directories together, more than one start copies`,
    });
    await assert.rejects(checkSkillTrees(skills, { entries, bytes: bytes - 1 }), {
      name: 'SkillTreeError',
      message: `the skills hold more than ${bytes - 1} bytes together, more than one start copies`,
    });
    for (const limits of [{ entries: entries - 1, bytes }, { entries, bytes: bytes - 1 }]) {
      const target = await mkdtempIn(root);
      await assert.rejects(copySkills(skills, target, { limits }), { name: 'SkillTreeError' });
    }
    const target = await mkdtempIn(root);
    await copySkills(skills, target, { limits: { entries, bytes } });
    assert.equal(await readFile(join(target, 'review', 'SKILL.md'), 'utf8'), '0123456789');
  });

  test('a file that grew after the check is stopped at the byte limit while it is copied', async (t) => {
    const root = await tempDir(t);
    const skill = await skillTree(root);
    const limits = { entries: 100, bytes: 1000 };
    await checkSkillTrees([{ name: 'lint', dir: skill }], limits);
    await writeFile(join(skill, 'files', 'notes.md'), 'x'.repeat(2000));
    const target = join(root, 'run-skills');
    await mkdir(target);
    await assert.rejects(copySkills([{ name: 'lint', dir: skill }], target, { limits }), {
      name: 'SkillTreeError',
      message: 'the skills hold more than 1000 bytes together, more than one start copies',
    });
  });

  test('an aborted copy stops before the next entry', async (t) => {
    const root = await tempDir(t);
    const skill = await skillTree(root);
    const target = join(root, 'run-skills');
    await mkdir(target);
    await assert.rejects(copySkills([{ name: 'lint', dir: skill }], target, { signal: AbortSignal.abort() }), {
      name: 'AbortError',
    });
    assert.deepEqual(await readdir(join(target, 'lint')), []);
  });

  test('copies several skills, each under its own name', async (t) => {
    const root = await tempDir(t);
    const target = join(root, 'run-skills');
    await mkdir(target);
    const skills = [];
    for (const name of ['lint', 'review']) {
      const dir = join(root, 'source', name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), `# ${name}\n`);
      skills.push({ name, dir: await realpath(dir) });
    }
    await copySkills(skills, target);
    assert.deepEqual((await readdir(target)).sort(), ['lint', 'review']);
    assert.equal(await readFile(join(target, 'review', 'SKILL.md'), 'utf8'), '# review\n');
  });

  test('a copy that is already there fails and is not replaced', async (t) => {
    const root = await tempDir(t);
    const skill = await skillTree(root);
    const target = join(root, 'run-skills');
    await mkdir(join(target, 'lint'), { recursive: true });
    await writeFile(join(target, 'lint', 'SKILL.md'), '# Kept\n');
    await assert.rejects(copySkills([{ name: 'lint', dir: skill }], target));
    assert.equal(await readFile(join(target, 'lint', 'SKILL.md'), 'utf8'), '# Kept\n');
  });

  test('a dangling symlink inside a skill fails the copy', async (t) => {
    const root = await tempDir(t);
    const skill = await skillTree(root);
    await symlink(join(root, 'gone.md'), join(skill, 'gone.md'));
    const target = join(root, 'run-skills');
    await mkdir(target);
    await assert.rejects(copySkills([{ name: 'lint', dir: skill }], target), { code: 'ENOENT' });
  });

  test(
    'a file that cannot be read fails the copy',
    { skip: process.getuid?.() === 0 ? 'root reads every file' : false },
    async (t) => {
      const root = await tempDir(t);
      const skill = await skillTree(root);
      await chmod(join(skill, 'SKILL.md'), 0o000);
      const target = join(root, 'run-skills');
      await mkdir(target);
      await assert.rejects(copySkills([{ name: 'lint', dir: skill }], target), { code: 'EACCES' });
    },
  );
});

describe('copySteering', () => {
  test('copies each file under its name, byte for byte', async (t) => {
    const root = await tempDir(t);
    const content = '---\ninclusion: always\n---\nKeep the public API.\n';
    const source = join(root, 'source-rules.md');
    await writeFile(source, content);
    const target = join(root, 'run-steering');
    await mkdir(target);
    await copySteering([{ name: 'rules.md', file: source }], target);
    assert.deepEqual(await readdir(target), ['rules.md']);
    assert.equal(await readFile(join(target, 'rules.md'), 'utf8'), content);
  });

  test('a file that is already there fails and is not replaced', async (t) => {
    const root = await tempDir(t);
    const source = join(root, 'rules.md');
    await writeFile(source, '# New\n');
    const target = join(root, 'run-steering');
    await mkdir(target);
    await writeFile(join(target, 'rules.md'), '# Kept\n');
    await assert.rejects(copySteering([{ name: 'rules.md', file: source }], target), { code: 'EEXIST' });
    assert.equal(await readFile(join(target, 'rules.md'), 'utf8'), '# Kept\n');
  });
});
