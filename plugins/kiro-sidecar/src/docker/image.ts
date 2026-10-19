/**
 * The image check before `docker run`. The plugin never pulls: `docker run`
 * gets `--pull never`, and a missing image is reported with the command that
 * pulls it.
 */
import { SidecarError } from '../errors.ts';
import type { Environment } from '../settings.ts';
import { runDocker, stderrSummary, stripClaudeVariables } from './cli.ts';
import { assertDockerImage } from './launch.ts';

const NO_SUCH_IMAGE = /no such image/i;

/**
 * Checks that `image` is present locally. Throws `E_INVALID` for a malformed
 * reference, `E_IMAGE_MISSING` (with the exact `docker pull` command) when the
 * image is absent, and `E_DOCKER` when docker fails otherwise.
 */
export async function checkImage(image: string, env: Environment = process.env): Promise<void> {
  assertDockerImage(image);
  const result = await runDocker(['image', 'inspect', '--format', '{{.Id}}', image], {
    env: stripClaudeVariables(env),
  });
  if (result.code === 0 && result.stdout.trim() !== '') {
    return;
  }
  if (NO_SUCH_IMAGE.test(result.stderr)) {
    throw new SidecarError(
      'E_IMAGE_MISSING',
      `Docker image ${image} is not present locally. Pull it with: docker pull ${image}`,
    );
  }
  throw new SidecarError(
    'E_DOCKER',
    `docker image inspect ${image} failed: ${stderrSummary(result.stderr)}`,
  );
}
