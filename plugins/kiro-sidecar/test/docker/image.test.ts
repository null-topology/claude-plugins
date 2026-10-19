import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { checkImage } from '../../src/docker/image.ts';
import { SKIP_WITHOUT_DOCKER, SKIP_WITHOUT_IMAGE, TEST_IMAGE } from './live.ts';

describe('image check', () => {
  test('a malformed reference is E_INVALID naming image, before docker runs', async () => {
    for (const image of ['--help', '', '-q']) {
      await assert.rejects(checkImage(image, { PATH: '/nonexistent-kiro-sidecar-path' }), {
        code: 'E_INVALID',
        field: 'image',
      });
    }
  });

  test('without a docker CLI the check is E_DOCKER', async () => {
    await assert.rejects(checkImage('example/kiro:1.0', { PATH: '/nonexistent-kiro-sidecar-path' }), {
      code: 'E_DOCKER',
    });
  });

  test('live: a present image passes', { skip: SKIP_WITHOUT_IMAGE }, async () => {
    await checkImage(TEST_IMAGE);
  });

  test('live: a missing image is E_IMAGE_MISSING with the pull command', { skip: SKIP_WITHOUT_DOCKER }, async () => {
    const image = `kiro-sidecar-test-missing-${randomBytes(4).toString('hex')}:none`;
    await assert.rejects(checkImage(image), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'E_IMAGE_MISSING');
      assert.ok((error as Error).message.includes(`docker pull ${image}`), (error as Error).message);
      return true;
    });
  });

  test('live: an unreachable daemon is E_DOCKER, not a missing image', { skip: SKIP_WITHOUT_DOCKER }, async () => {
    const env = { ...process.env, DOCKER_HOST: 'unix:///nonexistent-kiro-sidecar/docker.sock' };
    await assert.rejects(checkImage(TEST_IMAGE, env), { code: 'E_DOCKER' });
  });
});
