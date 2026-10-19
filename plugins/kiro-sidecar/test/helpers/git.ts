// Git repositories for tests, built with the real git CLI and no user or
// system configuration.
import { execFile } from 'node:child_process';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Runs git in `cwd` with `home` as HOME and no user or system configuration; returns stdout trimmed. */
export async function git(cwd: string, home: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      PATH: process.env['PATH'],
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: '',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: '',
    },
  });
  return stdout.trim();
}

export interface RepoWithWorktree {
  /** The main checkout. */
  readonly main: string;
  /** The linked worktree, on branch `feature`. */
  readonly worktree: string;
  /** The common dir as git reports it, resolved. */
  readonly commonDir: string;
}

/** A repository `main` in `base` with one commit and a linked worktree `feature` beside it. */
export async function repoWithWorktree(base: string): Promise<RepoWithWorktree> {
  const main = join(base, 'main');
  await mkdir(main);
  await git(main, base, 'init', '--quiet', '--initial-branch', 'main');
  await writeFile(join(main, 'README.md'), 'test repository\n');
  await git(main, base, 'add', 'README.md');
  await git(main, base, 'commit', '--quiet', '-m', 'initial commit');
  const worktree = join(base, 'feature');
  await git(main, base, 'worktree', 'add', '--quiet', '-b', 'feature', worktree);
  const commonDir = await realpath(await git(worktree, base, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  return { main, worktree, commonDir };
}
