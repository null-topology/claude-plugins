import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveSteering } from '../../src/session/steering.ts';
import { InvalidInputError } from '../../src/text/errors.ts';
import { tempDir } from '../helpers/processes.ts';

function assertInvalid(error: unknown, fragment: string): boolean {
  assert.ok(error instanceof InvalidInputError, `unexpected ${String(error)}`);
  assert.equal(error.code, 'E_INVALID', error.message);
  assert.equal(error.field, 'steering', error.message);
  assert.ok(error.message.startsWith('steering '), error.message);
  assert.ok(error.message.includes(fragment), error.message);
  return true;
}

describe('resolveSteering', () => {
  test('resolves each path to its real file and names the copy after the given path', async (t) => {
    const root = await realpath(await tempDir(t));
    const rules = join(root, 'rules.md');
    await writeFile(rules, '# Rules\n');
    await mkdir(join(root, 'shared'));
    const target = join(root, 'shared', 'style-source.md');
    await writeFile(target, '# Style\n');
    const link = join(root, 'style.md');
    await symlink(target, link);
    assert.deepEqual(await resolveSteering([rules, link]), [
      { requested: rules, name: 'rules.md', file: rules },
      { requested: link, name: 'style.md', file: target },
    ]);
  });

  test('an empty list resolves to nothing', async () => {
    assert.deepEqual(await resolveSteering([]), []);
  });

  test('paths that resolve to one file are kept once, the first', async (t) => {
    const root = await realpath(await tempDir(t));
    const rules = join(root, 'rules.md');
    await writeFile(rules, '# Rules\n');
    const link = join(root, 'link.md');
    await symlink(rules, link);
    assert.deepEqual(await resolveSteering([rules, link, rules]), [{ requested: rules, name: 'rules.md', file: rules }]);
  });

  test('a relative path is refused', async () => {
    await assert.rejects(resolveSteering(['rules.md']), (error) => assertInvalid(error, 'must hold absolute paths, got "rules.md"'));
  });

  test('a missing file is refused', async (t) => {
    const missing = join(await tempDir(t), 'missing.md');
    await assert.rejects(resolveSteering([missing]), (error) => assertInvalid(error, `${JSON.stringify(missing)} does not exist`));
  });

  test('a path below a file is refused as missing', async (t) => {
    const root = await tempDir(t);
    await writeFile(join(root, 'rules.md'), '# Rules\n');
    const below = join(root, 'rules.md', 'more.md');
    await assert.rejects(resolveSteering([below]), (error) => assertInvalid(error, 'does not exist'));
  });

  test('a dangling symlink is refused as missing', async (t) => {
    const root = await tempDir(t);
    const link = join(root, 'rules.md');
    await symlink(join(root, 'gone.md'), link);
    await assert.rejects(resolveSteering([link]), (error) => assertInvalid(error, 'does not exist'));
  });

  test('a directory is refused', async (t) => {
    const dir = join(await tempDir(t), 'notes.md');
    await mkdir(dir);
    await assert.rejects(resolveSteering([dir]), (error) => assertInvalid(error, 'must hold regular files'));
  });

  test('a file whose name does not end in .md is refused', async (t) => {
    const root = await tempDir(t);
    for (const name of ['rules.txt', 'rules.MD', 'rules.md.bak', '.md']) {
      const path = join(root, name);
      await writeFile(path, '# Rules\n');
      await assert.rejects(resolveSteering([path]), (error) => assertInvalid(error, 'whose names end in ".md"'), name);
    }
  });

  test('two different files with one name are refused', async (t) => {
    const root = await tempDir(t);
    const first = join(root, 'a', 'rules.md');
    const second = join(root, 'b', 'rules.md');
    await mkdir(join(root, 'a'));
    await mkdir(join(root, 'b'));
    await writeFile(first, '# A\n');
    await writeFile(second, '# B\n');
    await assert.rejects(resolveSteering([first, second]), (error) =>
      assertInvalid(error, `${JSON.stringify(first)} and ${JSON.stringify(second)} are two files named "rules.md"`),
    );
  });

  test('two files whose names differ only in case or normalization are refused', async (t) => {
    const root = await tempDir(t);
    // "Cafe" with a composed e-acute, then with e and a combining acute accent.
    // Built from code points, so the file stays ASCII and no editor normalizes them.
    const composed = `Caf${String.fromCodePoint(0xe9)}.md`;
    const decomposed = `cafe${String.fromCodePoint(0x301)}.md`;
    for (const [firstName, secondName] of [['Rules.md', 'rules.md'], [composed, decomposed]] as const) {
      const first = join(root, 'a', firstName);
      const second = join(root, 'b', secondName);
      await mkdir(join(root, 'a'), { recursive: true });
      await mkdir(join(root, 'b'), { recursive: true });
      await writeFile(first, '# A\n');
      await writeFile(second, '# B\n');
      await assert.rejects(resolveSteering([first, second]), (error) =>
        assertInvalid(
          error,
          `${JSON.stringify(first)} and ${JSON.stringify(second)} are two files named ` +
            `${JSON.stringify(firstName)} and ${JSON.stringify(secondName)}; steering file names must be unique, ignoring case`,
        ),
      );
    }
  });

  test('a file named sidecar-protocol.md is refused', async (t) => {
    const path = join(await tempDir(t), 'sidecar-protocol.md');
    await writeFile(path, '# Mine\n');
    await assert.rejects(resolveSteering([path]), (error) => assertInvalid(error, 'is named "sidecar-protocol.md", which is reserved'));
  });

  test('a file named like sidecar-protocol.md in another case is refused as reserved', async (t) => {
    for (const name of ['Sidecar-Protocol.md', 'SIDECAR-PROTOCOL.md']) {
      const path = join(await tempDir(t), name);
      await writeFile(path, '# Mine\n');
      await assert.rejects(resolveSteering([path]), (error) =>
        assertInvalid(error, `${JSON.stringify(path)} is named "sidecar-protocol.md" ignoring case, which is reserved`),
      );
    }
  });

  test('the name check comes before the file system: a reserved name is refused even when missing', async (t) => {
    const path = join(await tempDir(t), 'sidecar-protocol.md');
    await assert.rejects(resolveSteering([path]), (error) => assertInvalid(error, 'reserved'));
  });

  test(
    'a file that cannot be looked up is refused with its error code',
    { skip: process.getuid?.() === 0 ? 'root searches every directory' : false },
    async (t) => {
      const root = await tempDir(t);
      const locked = join(root, 'locked');
      await mkdir(locked);
      await writeFile(join(locked, 'rules.md'), '# Rules\n');
      await chmod(locked, 0o000);
      try {
        await assert.rejects(resolveSteering([join(locked, 'rules.md')]), (error) =>
          assertInvalid(error, 'cannot be looked up (EACCES)'),
        );
      } finally {
        // Searchable again, so the temp dir can be removed.
        await chmod(locked, 0o700);
      }
    },
  );
});
