import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markTicket, touchLastSeen } from '../src/session-files.ts';

const TRAP = fileURLToPath(new URL('../bin/exit-trap.sh', import.meta.url));
const SESSION = 'session-0000-test';
const SHELLS = ['/bin/sh', 'dash', 'bash', 'zsh'].filter((shell) => spawnSync('sh', ['-c', `command -v ${shell}`]).status === 0);

function run(shell: string, script: string, env: Record<string, string>): { status: number | null; stdout: string } {
  const result = spawnSync(shell, ['-c', `. "$1"; ${script}`, 'exit-trap-test', TRAP], {
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout };
}

describe('bin/exit-trap.sh', () => {
  for (const shell of SHELLS) {
    test(`${shell}: the status is untouched without the marker; with it a failure exits 0 and ends with [exit N]`, () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'op-trap-'));
      const env = { OP_BRIDGE_STATE_DIR: stateDir, CLAUDE_CODE_SESSION_ID: SESSION };
      try {
        assert.deepEqual(run(shell, 'echo out; exit 3', env), { status: 3, stdout: 'out\n' });
        touchLastSeen(stateDir, SESSION, Date.now());
        const marker = join(stateDir, 'sessions', SESSION, 'masked');
        assert.deepEqual(run(shell, `echo out; touch "${marker}"; exit 4`, env), { status: 0, stdout: 'out\n\n[exit 4]\n' }, 'checked at exit');
        markTicket(stateDir, SESSION, 'tkt_aaaaaaaaaaaaaaaa');
        assert.deepEqual(run(shell, 'echo out; false', env), { status: 0, stdout: 'out\n\n[exit 1]\n' });
        assert.deepEqual(run(shell, 'echo out', env), { status: 0, stdout: 'out\n' });
        assert.deepEqual(run(shell, 'echo out; exit 3', { CLAUDE_CODE_SESSION_ID: SESSION }), { status: 3, stdout: 'out\n' }, 'no state dir');
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    test(`${shell}: a command that fails under set -e is treated the same way`, () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'op-trap-'));
      const env = { OP_BRIDGE_STATE_DIR: stateDir, CLAUDE_CODE_SESSION_ID: SESSION };
      const script = "set -e; echo out; sh -c 'exit 5'; echo after";
      try {
        assert.deepEqual(run(shell, script, env), { status: 5, stdout: 'out\n' }, 'no marker');
        touchLastSeen(stateDir, SESSION, Date.now());
        markTicket(stateDir, SESSION, 'tkt_aaaaaaaaaaaaaaaa');
        assert.deepEqual(run(shell, script, env), { status: 0, stdout: 'out\n\n[exit 5]\n' }, 'marker');
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  }
});
