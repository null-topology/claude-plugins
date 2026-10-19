// Runs the built `docker run` command for real and checks that `kiro-cli acp`
// inside the container answers the ACP `initialize` request. `initialize`
// needs a non-empty KIRO_API_KEY but does not check it, so a placeholder
// token is used.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { buildDockerLaunch, resolveMountSet } from '../../src/docker/launch.ts';
import { resolveDockerUser } from '../../src/docker/user.ts';
import { SidecarError } from '../../src/errors.ts';
import { newLaunchId } from '../../src/store/paths.ts';
import { ensureHome, ensureRunCopyDirs } from '../../src/store/runs.ts';
import { tempDir } from '../helpers/processes.ts';
import { SKIP_WITHOUT_IMAGE, TEST_IMAGE, liveLaunchIdentity, removeTestContainer, testContainerName } from './live.ts';

const PLACEHOLDER_TOKEN = 'placeholder-token-not-a-real-key';
const ANSWER_TIMEOUT_MS = 90_000;

/** `auto`, or on a rootful daemon the uid and gid of this process. */
async function containerUser(): Promise<string> {
  try {
    return await resolveDockerUser('auto');
  } catch (error) {
    if (error instanceof SidecarError && error.code === 'E_DOCKER' && process.getuid !== undefined) {
      return `${process.getuid()}:${process.getgid?.() ?? 0}`;
    }
    throw error;
  }
}

describe('docker launch, live', () => {
  test(
    'kiro-cli acp answers initialize in a container started with the built arguments',
    { skip: SKIP_WITHOUT_IMAGE, timeout: ANSWER_TIMEOUT_MS + 30_000 },
    async (t) => {
      // After hooks run in the order they are registered and stop at the first
      // that fails, so the container goes first: a directory still mounted in
      // a running container cannot be removed on Docker Desktop.
      const name = testContainerName();
      let child: ChildProcessWithoutNullStreams | undefined;
      t.after(async () => {
        child?.stdin.end();
        child?.kill('SIGKILL');
        await removeTestContainer(name);
      });
      const dir = await tempDir(t);
      const stateDir = await tempDir(t);
      const launchId = newLaunchId();
      const home = await ensureHome(stateDir, 'default');
      const copies = await ensureRunCopyDirs(stateDir, launchId);
      const launch = await buildDockerLaunch({
        launchId,
        mountSet: await resolveMountSet({ dir, stateDir }),
        user: await containerUser(),
        image: TEST_IMAGE,
        token: PLACEHOLDER_TOKEN,
        env: process.env,
        kiroHome: { home: home.dir, skills: copies.skills, steering: copies.steering },
        ...(await liveLaunchIdentity(PLACEHOLDER_TOKEN)),
      });
      assert.ok(launch.args.every((arg) => !arg.includes(PLACEHOLDER_TOKEN)));

      // Only the container name differs from the built command: tests create
      // containers under the test prefix alone.
      const nameIndex = launch.args.indexOf('--name') + 1;
      assert.match(launch.args[nameIndex] ?? '', /^kiro-sidecar-[0-9a-f]{12}$/);
      const args = launch.args.map((arg, index) => (index === nameIndex ? name : arg));

      child = spawn(launch.command, args, {
        env: { ...launch.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < 8_192) {
          stderr += chunk;
        }
      });
      const lines = createInterface({ input: child.stdout });
      const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no initialize answer within ${ANSWER_TIMEOUT_MS} ms; stderr:\n${stderr}`)),
          ANSWER_TIMEOUT_MS,
        );
        lines.on('line', (line) => {
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            return;
          }
          if (typeof message === 'object' && message !== null && (message as { id?: unknown }).id === 1) {
            clearTimeout(timer);
            resolve(message as Record<string, unknown>);
          }
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`docker run exited with ${String(code)} before answering; stderr:\n${stderr}`));
        });
      });

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          },
        })}\n`,
      );

      const response = await answer;
      lines.close();
      assert.equal(response.jsonrpc, '2.0');
      assert.equal(response.error, undefined);
      const result = response.result as { protocolVersion?: unknown } | undefined;
      assert.equal(result?.protocolVersion, 1);
    },
  );
});
