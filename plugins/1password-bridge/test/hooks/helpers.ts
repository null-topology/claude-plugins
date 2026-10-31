import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookContext, HookInput } from '../../src/hooks/common.ts';
import type { Environment } from '../../src/paths.ts';

/** Synthetic ids; no real session is involved. */
export const SESSION_ID = 'session-0000-test';
export const OTHER_SESSION_ID = 'session-1111-test';

/** A synthetic value long enough to be masked. */
export const SECRET = 'not-a-real-secret-value';

export interface Sandbox {
  readonly root: string;
  readonly stateDir: string;
  cleanup(): void;
}

export function sandbox(prefix = 'op-bridge-hooks-'): Sandbox {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    stateDir: join(root, 'state'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function context(stateDir: string, input: HookInput, env: Environment = {}): HookContext {
  return { input, stateDir, pluginRoot: '/plugin-root', env };
}
