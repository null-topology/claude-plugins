/**
 * B9: the README (requirements, the image paragraph, the settings table),
 * the header of `src/docker/image.ts` and the usage skill say that the first
 * docker start of a day may pull the image and take longer.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const flat = (text: string) => text.replace(/\s+/g, ' ');

/** The part of `text` from the line starting with `start` to the next line starting with `end`. */
function section(text: string, start: string, end: string): string {
  const lines = text.split('\n');
  const from = lines.findIndex((line) => line.startsWith(start));
  assert.ok(from >= 0, `no line starting with ${start}`);
  const to = lines.findIndex((line, index) => index > from && line.startsWith(end));
  return flat(lines.slice(from, to < 0 ? undefined : to).join('\n'));
}

const DAY = /first docker start of a day may (?:run `docker pull`|pull the (?:Kiro )?image) and take longer/;

describe('docs: the image refresh', () => {
  const readme = read('../README.md');

  test('README requirements', () => {
    assert.match(section(readme, '### Requirements', '### '), DAY);
  });

  test('README image paragraph of docker mode', () => {
    const image = section(readme, '- **Image.**', '### ');
    assert.match(image, DAY);
    assert.match(image, /`--pull never`/);
  });

  test('README settings table', () => {
    const row = readme.split('\n').find((line) => line.startsWith('| `KIRO_SIDECAR_DOCKER_IMAGE_REFRESH_HOURS` |'));
    assert.ok(row !== undefined, 'the settings table has the variable');
    assert.match(row, /\| `24` \|/);
    assert.match(row, /first docker start of a day may take longer/);
    assert.match(row, /`0`: never pull/);
  });

  test('the header of src/docker/image.ts', () => {
    const source = read('../src/docker/image.ts');
    const header = flat(source.slice(0, source.indexOf('*/')).replace(/\n\s*\*/g, ' '));
    assert.match(header, DAY);
  });

  test('the usage skill', () => {
    assert.match(flat(read('../skills/kiro-sidecar/SKILL.md')), DAY);
  });
});
