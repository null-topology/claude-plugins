import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESERVED_DESTINATIONS,
  formatMountSpec,
  isAtOrBelow,
  isMountSafe,
  mountArgument,
  parseMountSpec,
  validateMountSet,
} from '../../src/docker/mounts.ts';
import type { MountRole, ResolvedMount } from '../../src/docker/mounts.ts';

function mount(role: MountRole, path: string, readOnly = false, given?: string): ResolvedMount {
  return { role, path, readOnly, given: given ?? (readOnly && role !== 'git' ? `${path}:ro` : path) };
}

const dir = (path: string, readOnly = false) => mount('dir', path, readOnly);
const git = (path: string) => mount('git', path, true);
const custom = (path: string, readOnly = false, given?: string) => mount('mount', path, readOnly, given);

function assertRefused(mounts: readonly ResolvedMount[], field: string, message: RegExp): void {
  assert.throws(
    () => validateMountSet(mounts),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'E_INVALID');
      assert.equal((error as { field?: unknown }).field, field);
      assert.ok((error as Error).message.startsWith(`${field} `), (error as Error).message);
      assert.match((error as Error).message, message);
      return true;
    },
  );
}

describe('mount syntax', () => {
  test('a ":ro" suffix makes a mount read-only; anything else is a writable path', () => {
    assert.deepEqual(parseMountSpec('/work/notes:ro'), { path: '/work/notes', readOnly: true });
    assert.deepEqual(parseMountSpec('/work/notes'), { path: '/work/notes', readOnly: false });
    assert.deepEqual(parseMountSpec('/work/notes:rw'), { path: '/work/notes:rw', readOnly: false });
    assert.deepEqual(parseMountSpec('/work/a:b'), { path: '/work/a:b', readOnly: false });
    assert.deepEqual(parseMountSpec(':ro'), { path: '', readOnly: true });
  });

  test('formatting gives back the given form', () => {
    for (const value of ['/work/notes:ro', '/work/notes']) {
      assert.equal(formatMountSpec(parseMountSpec(value)), value);
    }
  });

  test('the --mount value has the same source and destination, and readonly when read-only', () => {
    assert.equal(mountArgument({ path: '/work/a', readOnly: false }), 'type=bind,src=/work/a,dst=/work/a');
    assert.equal(mountArgument({ path: '/work/a', readOnly: true }), 'type=bind,src=/work/a,dst=/work/a,readonly');
  });

  test('a comma, a double quote or a control character is not mount-safe', () => {
    assert.equal(isMountSafe('/work/plain dir'), true);
    for (const path of ['/work/a,b', '/work/a"b', '/work/a\nb', '/work/a\tb', '/work/a\x7fb']) {
      assert.equal(isMountSafe(path), false, JSON.stringify(path));
    }
  });

  test('a path is at or below another only on a path boundary', () => {
    assert.equal(isAtOrBelow('/a', '/a'), true);
    assert.equal(isAtOrBelow('/a/b', '/a'), true);
    assert.equal(isAtOrBelow('/a/b/c', '/a'), true);
    assert.equal(isAtOrBelow('/ab', '/a'), false);
    assert.equal(isAtOrBelow('/a', '/a/b'), false);
  });
});

describe('mount set rules', () => {
  test('a set without conflicts passes: siblings, and nesting in the same mode', () => {
    validateMountSet([dir('/w'), git('/r/.git'), custom('/data'), custom('/docs', true)]);
    validateMountSet([dir('/w'), custom('/w/sub')]);
    validateMountSet([dir('/w', true), custom('/w/sub', true)]);
    validateMountSet([dir('/w'), custom('/wx', true)]);
    validateMountSet([dir('/home/agentx'), custom('/home/agent/.kiro2'), custom('/home/agent/task.md.bak')]);
  });

  test('two mounts with the same destination are refused on the later one', () => {
    assertRefused([dir('/w'), custom('/w')], 'mounts', /^mounts entry "\/w" has the same destination "\/w" as work directory "\/w"$/);
    assertRefused(
      [dir('/w'), custom('/data', false, '/link-a'), custom('/data', true, '/link-b:ro')],
      'mounts',
      /^mounts entry "\/link-b:ro" has the same destination "\/data" as mounts entry "\/link-a"$/,
    );
    assertRefused([dir('/w'), git('/r/.git'), custom('/r/.git', true)], 'mounts', /same destination "\/r\/.git" as git common dir/);
  });

  test('a writable mount inside a read-only one is refused', () => {
    assertRefused(
      [dir('/w', true), custom('/w/out')],
      'mounts',
      /^mounts entry "\/w\/out" is writable inside the read-only work directory "\/w"$/,
    );
    assertRefused(
      [dir('/w/sub'), custom('/w', true)],
      'mounts',
      /^mounts entry "\/w:ro" is read-only and holds the writable work directory "\/w\/sub"$/,
    );
    assertRefused(
      [dir('/w'), custom('/data', true), custom('/data/out')],
      'mounts',
      /^mounts entry "\/data\/out" is writable inside the read-only mounts entry "\/data:ro"$/,
    );
  });

  test('a read-only mount inside a writable one is refused', () => {
    assertRefused(
      [dir('/w'), custom('/w/docs', true)],
      'mounts',
      /^mounts entry "\/w\/docs:ro" is read-only inside the writable work directory "\/w"$/,
    );
    assertRefused(
      [dir('/w/docs', true), custom('/w')],
      'mounts',
      /^mounts entry "\/w" is writable and holds the read-only work directory "\/w\/docs"$/,
    );
    assertRefused(
      [dir('/w'), custom('/data'), custom('/data/docs', true)],
      'mounts',
      /^mounts entry "\/data\/docs:ro" is read-only inside the writable mounts entry "\/data"$/,
    );
  });

  test('the git common dir counts as a read-only mount, and the blame goes to the other mount', () => {
    assertRefused(
      [dir('/w'), git('/r/.git'), custom('/r/.git/extra')],
      'mounts',
      /^mounts entry "\/r\/.git\/extra" is writable inside the read-only git common dir "\/r\/.git"$/,
    );
    assertRefused(
      [dir('/w'), git('/r/.git'), custom('/r')],
      'mounts',
      /^mounts entry "\/r" is writable and holds the read-only git common dir "\/r\/.git"$/,
    );
    assertRefused(
      [dir('/r/.git/trees/w'), git('/r/.git')],
      'dir',
      /^dir "\/r\/.git\/trees\/w" is writable inside the read-only git common dir "\/r\/.git"$/,
    );
    assertRefused(
      [dir('/w'), git('/w/nested/.git')],
      'dir',
      /^dir "\/w" is writable and holds the read-only git common dir "\/w\/nested\/.git"$/,
    );
    validateMountSet([dir('/w', true), git('/w/nested/.git'), custom('/r', true)]);
  });

  test('nothing may be mounted at, inside or above a reserved destination', () => {
    const rule =
      /nothing may be mounted at, inside or above \/home\/agent\/.kiro, \/home\/agent\/task.md or \/opt\/kiro-sidecar$/;
    for (const path of [
      '/home/agent/.kiro',
      '/home/agent/.kiro/skills',
      '/home/agent/task.md',
      '/home/agent/task.md/below',
      '/home/agent',
      '/home',
      '/opt/kiro-sidecar',
      '/opt/kiro-sidecar/sidecar-tools.mjs',
      '/opt/kiro-sidecar/below',
      '/opt',
    ]) {
      assertRefused([dir('/w'), custom(path, true)], 'mounts', rule);
      assertRefused([dir('/w'), custom(path)], 'mounts', rule);
    }
    assertRefused([dir('/home/agent/.kiro/work')], 'dir', /^dir "\/home\/agent\/.kiro\/work" would be mounted at/);
    assertRefused(
      [dir('/w'), git('/home/agent/.kiro/repo.git')],
      'dir',
      /^dir is a git work tree whose common dir would be mounted at "\/home\/agent\/.kiro\/repo.git"/,
    );
    assertRefused([dir('/opt/kiro-sidecar/work')], 'dir', /^dir "\/opt\/kiro-sidecar\/work" would be mounted at/);
    // A sibling of the plugin directory is not reserved.
    validateMountSet([dir('/w'), custom('/opt/other', true)]);
    assert.deepEqual(RESERVED_DESTINATIONS, ['/home/agent/.kiro', '/home/agent/task.md', '/opt/kiro-sidecar']);
  });
});
