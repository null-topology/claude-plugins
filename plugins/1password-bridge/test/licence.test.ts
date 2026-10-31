import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('licence', () => {
  test('the package is MIT licensed', () => {
    assert.equal((JSON.parse(read('package.json')) as { license?: unknown }).license, 'MIT');
  });

  test('LICENSE holds the MIT text with the copyright holder', () => {
    const lines = read('LICENSE').split('\n');
    assert.equal(lines[0], 'MIT License');
    assert.equal(lines[2], 'Copyright (c) 2026 null-topology');
    const text = lines.join(' ');
    assert.match(text, /Permission is hereby granted, free of charge, to any person obtaining a copy/);
    assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
  });
});
