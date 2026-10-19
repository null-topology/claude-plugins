import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readPromptFile } from '../../src/session/prompt-file.ts';
import { InvalidInputError } from '../../src/text/errors.ts';
import { tempDir } from '../helpers/processes.ts';

function assertInvalid(error: unknown, fragment: string): boolean {
  assert.ok(error instanceof InvalidInputError, String(error));
  assert.equal(error.code, 'E_INVALID');
  assert.ok(error.message.startsWith('prompt_file '), error.message);
  assert.ok(error.message.includes(fragment), error.message);
  return true;
}

describe('readPromptFile', () => {
  test('a file of exactly the limit is read whole, one byte more is refused', async (t) => {
    const dir = await tempDir(t);
    const atLimit = join(dir, 'at-limit.md');
    const overLimit = join(dir, 'over-limit.md');
    await writeFile(atLimit, 'a'.repeat(16));
    await writeFile(overLimit, 'a'.repeat(17));
    const task = await readPromptFile(atLimit, 16);
    assert.equal(task.text, 'a'.repeat(16));
    assert.deepEqual(task.content, Buffer.from('a'.repeat(16)));
    await assert.rejects(readPromptFile(overLimit, 16), (error) => assertInvalid(error, 'must be at most 16 bytes'));
  });

  test('a file larger than one read chunk is read whole', async (t) => {
    const dir = await tempDir(t);
    const path = join(dir, 'large.md');
    const content = Buffer.alloc(3 * 1024 * 1024 + 5, 'b');
    await writeFile(path, content);
    const task = await readPromptFile(path);
    assert.equal(task.content.length, content.length);
    assert.ok(task.content.equals(content));
  });

  test('the bytes are kept as read and the text is their UTF-8 decoding', async (t) => {
    const dir = await tempDir(t);
    const path = join(dir, 'task.md');
    await writeFile(path, 'Line one\r\nLine two\n');
    const task = await readPromptFile(path);
    assert.ok(task.content.equals(Buffer.from('Line one\r\nLine two\n')));
    assert.equal(task.text, 'Line one\r\nLine two\n');
  });
});
