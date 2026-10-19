import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  autoDockerUser,
  isDockerDesktop,
  isExplicitDockerUser,
  isRootlessDaemon,
  parseDockerInfo,
  resolveDockerUser,
} from '../../src/docker/user.ts';
import type { DockerInfo } from '../../src/docker/user.ts';
import { SKIP_WITHOUT_DOCKER, daemonIsRootless } from './live.ts';

async function fixtureInfo(name: string): Promise<DockerInfo> {
  const json = await readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
  return parseDockerInfo(json);
}

/** An environment in which no docker CLI can be found. */
const NO_DOCKER_ENV = { PATH: '/nonexistent-kiro-sidecar-path' };

describe('docker_user auto from docker info output', () => {
  test('rootless daemon (captured output) gives 0:0', async () => {
    const info = await fixtureInfo('docker-info-rootless.json');
    assert.equal(isRootlessDaemon(info), true);
    assert.equal(isDockerDesktop(info), false);
    assert.equal(autoDockerUser(info), '0:0');
  });

  test('Docker Desktop (synthetic output) gives 0:0', async () => {
    const info = await fixtureInfo('docker-info-desktop.json');
    assert.equal(isRootlessDaemon(info), false);
    assert.equal(isDockerDesktop(info), true);
    assert.equal(autoDockerUser(info), '0:0');
  });

  test('Docker Desktop is recognised by its name or by its address label alone', () => {
    const byName: DockerInfo = { securityOptions: [], operatingSystem: 'Docker Desktop', labels: [] };
    const byLabel: DockerInfo = {
      securityOptions: [],
      operatingSystem: 'Ubuntu 24.04 LTS',
      labels: ['com.docker.desktop.address=unix:///var/run/docker-cli.sock'],
    };
    assert.equal(isDockerDesktop(byName), true);
    assert.equal(isDockerDesktop(byLabel), true);
  });

  test('rootful daemon (synthetic output) is refused with E_DOCKER', async () => {
    const info = await fixtureInfo('docker-info-rootful.json');
    assert.equal(isRootlessDaemon(info), false);
    assert.equal(isDockerDesktop(info), false);
    assert.throws(() => autoDockerUser(info), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'E_DOCKER');
      assert.match((error as Error).message, /KIRO_SIDECAR_DOCKER_USER/);
      return true;
    });
  });

  test('rootless must be its own security option, not a value inside another', () => {
    const info: DockerInfo = {
      securityOptions: ['name=seccomp,profile=rootless', 'name=apparmor'],
      operatingSystem: 'Ubuntu 24.04 LTS',
      labels: [],
    };
    assert.equal(isRootlessDaemon(info), false);
  });

  test('output that is not a docker info object, or that reports server errors, is E_DOCKER', () => {
    for (const json of ['', 'not json', '[]', 'null']) {
      assert.throws(() => parseDockerInfo(json), { code: 'E_DOCKER' });
    }
    assert.throws(
      () => parseDockerInfo('{"ServerErrors":["daemon is shutting down"]}'),
      (error: unknown) => {
        assert.equal((error as { code?: unknown }).code, 'E_DOCKER');
        assert.match((error as Error).message, /daemon is shutting down/);
        return true;
      },
    );
  });

  test('missing fields read as empty', () => {
    assert.deepEqual(parseDockerInfo('{}'), { securityOptions: [], operatingSystem: '', labels: [] });
  });
});

describe('explicit docker_user', () => {
  test('a well-formed value is used as given, without asking docker', async () => {
    for (const user of ['0:0', '1000:1000', '1000', 'agent', 'agent:agent', 'build_user:staff']) {
      assert.equal(isExplicitDockerUser(user), true, user);
      assert.equal(await resolveDockerUser(user, NO_DOCKER_ENV), user);
    }
  });

  test('a malformed value is E_INVALID naming docker_user', async () => {
    const malformed = [
      '',
      '-1',
      '--privileged',
      '1000:',
      ':1000',
      '1000:1000:1000',
      'a b',
      'user;id',
      '12345678901',
      'x'.repeat(33),
    ];
    for (const user of malformed) {
      assert.equal(isExplicitDockerUser(user), false, user);
      await assert.rejects(resolveDockerUser(user, NO_DOCKER_ENV), {
        code: 'E_INVALID',
        field: 'docker_user',
      });
    }
  });
});

describe('docker_user auto against docker', () => {
  test('without a docker CLI, auto is E_DOCKER', async () => {
    await assert.rejects(resolveDockerUser('auto', NO_DOCKER_ENV), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'E_DOCKER');
      assert.match((error as Error).message, /not found/);
      return true;
    });
  });

  test('with an unreachable daemon, auto is E_DOCKER', { skip: SKIP_WITHOUT_DOCKER }, async () => {
    const env = { ...process.env, DOCKER_HOST: 'unix:///nonexistent-kiro-sidecar/docker.sock' };
    await assert.rejects(resolveDockerUser('auto', env), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'E_DOCKER');
      assert.match((error as Error).message, /docker info failed/);
      return true;
    });
  });

  test('live: a rootless daemon gives 0:0', { skip: SKIP_WITHOUT_DOCKER }, async (t) => {
    if (!(await daemonIsRootless())) {
      t.skip('the daemon is not rootless');
      return;
    }
    assert.equal(await resolveDockerUser('auto'), '0:0');
  });
});
