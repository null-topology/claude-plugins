import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendJsonLine,
  createJsonOnce,
  ensureDir,
  readJsonIfExists,
  writeJsonAtomic,
} from '../../src/store/files.ts';
import { tempDir } from '../helpers/processes.ts';

const WRITER = fileURLToPath(new URL('../fixtures/json-writer.ts', import.meta.url));

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

/** Runs `body` with the process umask set to `mask`, then restores it. */
async function withUmask<T>(mask: number, body: () => Promise<T>): Promise<T> {
  const previous = process.umask(mask);
  try {
    return await body();
  } finally {
    process.umask(previous);
  }
}

describe('modes', () => {
  // A permissive umask shows the modes come from the code, not from the umask;
  // the usual 022 shows they survive it.
  for (const mask of [0o000, 0o022]) {
    test(`directories are 0700 and files 0600 under umask ${mask.toString(8).padStart(3, '0')}`, async (t) => {
      const root = await tempDir(t);
      const nested = join(root, 'a', 'b', 'c');
      const atomic = join(nested, 'atomic.json');
      const once = join(nested, 'once.json');
      const lines = join(nested, 'lines.jsonl');
      await withUmask(mask, async () => {
        await ensureDir(nested);
        await writeJsonAtomic(atomic, { ok: true });
        await createJsonOnce(once, { ok: true });
        await appendJsonLine(lines, { ok: true });
      });
      for (const dir of [join(root, 'a'), join(root, 'a', 'b'), nested]) {
        assert.equal(await modeOf(dir), 0o700, dir);
      }
      for (const file of [atomic, once, lines]) {
        assert.equal(await modeOf(file), 0o600, file);
      }
    });
  }
});

describe('atomic writes', () => {
  test('the file holds the last value and no temp file is left', async (t) => {
    const dir = await tempDir(t);
    const path = join(dir, 'meta.json');
    for (let version = 1; version <= 50; version += 1) {
      await writeJsonAtomic(path, { version });
    }
    assert.deepEqual(await readJsonIfExists(path), { version: 50 });
    assert.deepEqual(await readdir(dir), ['meta.json']);
  });

  test('a failed rename removes its temp file', async (t) => {
    const dir = await tempDir(t);
    const target = join(dir, 'occupied');
    await mkdir(join(target, 'child'), { recursive: true });
    await assert.rejects(writeJsonAtomic(target, { version: 1 }));
    assert.deepEqual(await readdir(dir), ['occupied']);
  });

  test('a value that is not JSON writes nothing', async (t) => {
    const dir = await tempDir(t);
    await assert.rejects(writeJsonAtomic(join(dir, 'x.json'), undefined), TypeError);
    await assert.rejects(writeJsonAtomic(join(dir, 'x.json'), { big: 1n }), TypeError);
    assert.deepEqual(await readdir(dir), []);
  });

  test('a reader never sees a partial file while another process rewrites it', { timeout: 60_000 }, async (t) => {
    const dir = await tempDir(t);
    const path = join(dir, 'state.json');
    const payloadBytes = 512 * 1024;
    const versions = 200;
    await writeJsonAtomic(path, { version: 0, payload: 'z'.repeat(payloadBytes) });

    const writer = spawn(process.execPath, [WRITER, path, String(versions), String(payloadBytes)], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const exited = once(writer, 'exit');
    let running = true;
    void exited.then(() => {
      running = false;
    });

    let reads = 0;
    let lastVersion = 0;
    const seen = new Set<number>();
    while (running) {
      const text = await readFile(path, 'utf8');
      const value = JSON.parse(text) as { version: number; payload: string };
      assert.equal(value.payload.length, payloadBytes);
      assert.ok(value.version >= lastVersion, 'versions only move forward');
      lastVersion = value.version;
      seen.add(value.version);
      reads += 1;
    }
    const [code] = await exited;
    assert.equal(code, 0);
    assert.deepEqual(await readJsonIfExists(path).then((value) => (value as { version: number }).version), versions);
    assert.deepEqual(await readdir(dir), ['state.json']);
    t.diagnostic(`${reads} complete reads, ${seen.size} distinct versions seen`);
    assert.ok(seen.size > 2, `the reader overlapped the writer (${seen.size} versions seen)`);
  });
});

describe('create-once writes', () => {
  test('the first writer wins and its content survives', async (t) => {
    const dir = await tempDir(t);
    const path = join(dir, '1.json');
    assert.equal(await createJsonOnce(path, { writer: 'first' }), true);
    assert.equal(await createJsonOnce(path, { writer: 'second' }), false);
    assert.deepEqual(await readJsonIfExists(path), { writer: 'first' });
    assert.deepEqual(await readdir(dir), ['1.json']);
  });

  test('of concurrent writers exactly one creates the file', async (t) => {
    const dir = await tempDir(t);
    const path = join(dir, 'once.json');
    const results = await Promise.all(
      Array.from({ length: 32 }, (_, writer) => createJsonOnce(path, { writer })),
    );
    assert.equal(results.filter(Boolean).length, 1);
    const winner = results.indexOf(true);
    assert.deepEqual(await readJsonIfExists(path), { writer: winner });
    assert.deepEqual(await readdir(dir), ['once.json']);
  });
});

describe('appended lines', () => {
  test('each value becomes one JSON line, in order', async (t) => {
    const dir = await tempDir(t);
    const path = join(dir, 'log.jsonl');
    await appendJsonLine(path, { n: 1 });
    await appendJsonLine(path, { n: 2, text: 'line\nbreak' });
    assert.equal(await readFile(path, 'utf8'), '{"n":1}\n{"n":2,"text":"line\\nbreak"}\n');
  });

  test('a missing file reads as undefined', async (t) => {
    const dir = await tempDir(t);
    assert.equal(await readJsonIfExists(join(dir, 'absent.json')), undefined);
  });
});
