// Helpers for the tests that run the real Docker CLI. They skip when docker
// or the test image is not available; the image is never pulled.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { DockerLaunchOptions } from '../../src/docker/launch.ts';
import { currentDriver, currentOwner, ownerKey } from '../../src/store/identity.ts';
import { buildSecretSet } from '../../src/text/redact.ts';

/** The labels and the secret check of a live launch: this process's identities and a set holding `token`. */
export async function liveLaunchIdentity(token: string): Promise<Pick<DockerLaunchOptions, 'owner' | 'secrets'>> {
  return {
    owner: { ownerKey: ownerKey(await currentOwner()), driver: await currentDriver() },
    secrets: buildSecretSet({ apiKey: token, env: process.env }),
  };
}

/** A local image that contains `kiro-cli`. */
export const TEST_IMAGE = process.env.KIRO_SIDECAR_TEST_IMAGE ?? 'sbx/kiro:latest';

/** Every container a test creates is named with this prefix. */
export const TEST_CONTAINER_PREFIX = 'kiro-sidecar-test-';

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `docker <args>`; an exit code is returned, a failure to start is code null. */
export function docker(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile('docker', [...args], { encoding: 'utf8', timeout: 60_000 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      resolve({ code: typeof error.code === 'number' ? error.code : null, stdout, stderr });
    });
  });
}

async function dockerSkipReason(): Promise<string | false> {
  const info = await docker(['info', '--format', '{{.ServerVersion}}']);
  return info.code === 0 ? false : 'docker is not available';
}

/** Why the tests that need the docker CLI and daemon are skipped, or false. */
export const SKIP_WITHOUT_DOCKER: string | false = await dockerSkipReason();

async function imageSkipReason(): Promise<string | false> {
  if (SKIP_WITHOUT_DOCKER !== false) {
    return SKIP_WITHOUT_DOCKER;
  }
  const image = await docker(['image', 'inspect', '--format', '{{.Id}}', TEST_IMAGE]);
  return image.code === 0 ? false : `test image ${TEST_IMAGE} is not present`;
}

/** Why the tests that run containers of the test image are skipped, or false. */
export const SKIP_WITHOUT_IMAGE: string | false = await imageSkipReason();

/** True when the daemon's security options name rootless, read independently of the plugin. */
export async function daemonIsRootless(): Promise<boolean> {
  const result = await docker(['info', '--format', '{{json .SecurityOptions}}']);
  return result.code === 0 && result.stdout.includes('"name=rootless"');
}

/** A fresh container name with the test prefix. */
export function testContainerName(): string {
  return `${TEST_CONTAINER_PREFIX}${randomBytes(6).toString('hex')}`;
}

function assertTestName(name: string): void {
  if (!name.startsWith(TEST_CONTAINER_PREFIX)) {
    throw new Error(`Not a test container: ${name}`);
  }
}

/** True while a container with exactly this name exists, running or not. */
export async function containerExists(name: string): Promise<boolean> {
  const result = await docker(['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}']);
  if (result.code !== 0) {
    throw new Error(`docker ps failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split('\n').some((line) => line.trim() === name);
}

/** Removes a test container if it is still there. */
export async function removeTestContainer(name: string): Promise<void> {
  assertTestName(name);
  await docker(['rm', '-f', name]);
}

/** Starts an idle test container from the test image; returns its name. */
export async function startIdleTestContainer(): Promise<string> {
  const name = testContainerName();
  const result = await docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--entrypoint',
    'sleep',
    TEST_IMAGE,
    '300',
  ]);
  if (result.code !== 0) {
    throw new Error(`Could not start ${name}: ${result.stderr.trim()}`);
  }
  return name;
}

/** Polls until `check` is true or `timeoutMs` has passed; returns the last result. */
export async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
