import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORGET_SCAN_MS, SESSION_FORGET_MS } from '../../src/session-lifetime.ts';
import { TICKET_TTL_MS } from '../../src/broker/tickets.ts';
import { missingDependencies, type SystemProbe } from '../../src/hooks/diagnostics.ts';
import { hookLogPath } from '../../src/hooks/log.ts';
import { exitTrapLine, pathLine, sessionStart, stateDirLine, SWEEP_AGE_MS } from '../../src/hooks/session-start.ts';
import { lastSeenPath, sessionDir } from '../../src/paths.ts';
import { readSessionInfo, touchLastSeen } from '../../src/session-files.ts';
import { SDK_INTEGRATION_SETTING } from '../../src/strings.ts';
import { context, OTHER_SESSION_ID, sandbox, SESSION_ID, type Sandbox } from './helpers.ts';

const MAC_LIB = '/Applications/1Password.app/Contents/Frameworks/libop_sdk_ipc_client.dylib';
const HOME = '/home/someone';

/** A probe that sees exactly the given files and executables. */
function probe(platform: NodeJS.Platform, files: readonly string[] = [], executables: readonly string[] = []): SystemProbe {
  return {
    platform,
    home: HOME,
    isFile: (path) => files.includes(path),
    isExecutable: (path) => executables.includes(path),
  };
}

const MAC_READY = probe('darwin', [MAC_LIB], ['/usr/bin/osascript']);

let box: Sandbox;
let envFile: string;

beforeEach(() => {
  box = sandbox();
  envFile = join(box.root, 'claude-env.sh');
});

afterEach(() => {
  box.cleanup();
});

function input(sessionId: unknown = SESSION_ID) {
  return { hook_event_name: 'SessionStart', session_id: sessionId, transcript_path: '/t.jsonl', cwd: '/work', source: 'startup' };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('sessionStart: session directory and env lines', () => {
  test('creates the session directory 0700', () => {
    const out = sessionStart(context(box.stateDir, input(), { CLAUDE_ENV_FILE: envFile }), MAC_READY);
    assert.equal(out, undefined);
    assert.equal(mode(sessionDir(box.stateDir, SESSION_ID)), 0o700);
  });

  test('a file without a final newline gets one before the lines', () => {
    writeFileSync(envFile, 'export OTHER=1');
    sessionStart(context(box.stateDir, input(), { CLAUDE_ENV_FILE: envFile }), MAC_READY);
    assert.equal(
      readFileSync(envFile, 'utf8'),
      ['export OTHER=1', stateDirLine(box.stateDir), pathLine('/plugin-root'), exitTrapLine('/plugin-root'), ''].join('\n'),
    );
  });

  test('the lines quote a state directory holding a single quote and a plugin root holding expansions, and a shell sources them', () => {
    const quoted = sandbox("op-bridge-it's-");
    try {
      const file = join(quoted.root, 'claude-env.sh');
      const root = '/plugins/a"b$c`d\\e';
      sessionStart({ ...context(quoted.stateDir, input(), { CLAUDE_ENV_FILE: file }), pluginRoot: root }, MAC_READY);
      const run = spawnSync('/bin/sh', ['-c', `. "$1"; printf '%s\\n%s' "$OP_BRIDGE_STATE_DIR" "$PATH"`, 'sh', file], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
      });
      assert.equal(run.stdout, `${quoted.stateDir}\n${root}/bin:/usr/bin:/bin`);
    } finally {
      quoted.cleanup();
    }
  });

  test('without CLAUDE_ENV_FILE the directory is still created and nothing fails', () => {
    assert.equal(sessionStart(context(box.stateDir, input(), {}), MAC_READY), undefined);
    assert.equal(existsSync(sessionDir(box.stateDir, SESSION_ID)), true);
    assert.equal(sessionStart(context(box.stateDir, input(), { CLAUDE_ENV_FILE: '' }), MAC_READY), undefined);
  });

  test('an invalid session id creates nothing and writes no line', () => {
    assert.equal(sessionStart(context(box.stateDir, input('../escape'), { CLAUDE_ENV_FILE: envFile }), MAC_READY), undefined);
    assert.equal(existsSync(envFile), false);
    assert.equal(existsSync(join(box.stateDir, 'escape')), false);
    assert.equal(sessionStart(context(box.stateDir, input(7), { CLAUDE_ENV_FILE: envFile }), MAC_READY), undefined);
    assert.equal(existsSync(envFile), false);
  });

  test('sweeps sessions not seen for more than 7 days, keeping recent ones and the current one', () => {
    const now = Date.parse('2026-10-28T12:00:00.000Z');
    touchLastSeen(box.stateDir, OTHER_SESSION_ID, now - SWEEP_AGE_MS - 60_000);
    touchLastSeen(box.stateDir, 'session-2222-test', now - SWEEP_AGE_MS + 60_000);
    touchLastSeen(box.stateDir, SESSION_ID, now - SWEEP_AGE_MS - 60_000);
    sessionStart(context(box.stateDir, input(), {}), MAC_READY, now);
    assert.equal(existsSync(sessionDir(box.stateDir, OTHER_SESSION_ID)), false);
    assert.equal(existsSync(sessionDir(box.stateDir, 'session-2222-test')), true);
    assert.equal(statSync(lastSeenPath(box.stateDir, SESSION_ID)).mtimeMs, now, 'the current session is marked live');
  });

  test('the sweep waits an hour longer than the broker: 7 d + 30 min ago is kept, 7 d + 1 h + 1 min ago is swept', () => {
    const now = Date.parse('2026-10-28T12:00:00.000Z');
    const day = 24 * 60 * 60 * 1000;
    const minute = 60_000;
    touchLastSeen(box.stateDir, 'session-2222-test', now - 7 * day - 30 * minute);
    touchLastSeen(box.stateDir, OTHER_SESSION_ID, now - 7 * day - 61 * minute);
    sessionStart(context(box.stateDir, input(), {}), MAC_READY, now);
    assert.equal(existsSync(sessionDir(box.stateDir, 'session-2222-test')), true);
    assert.equal(existsSync(sessionDir(box.stateDir, OTHER_SESSION_ID)), false);
  });

  test('the broker forgets a session before the sweep can remove its marker, even after a redeem late in a ticket\'s life', () => {
    // The broker's clock is its last request, which can follow the last hook by up to a ticket's lifetime,
    // and its scan finds a quiet session up to one scan interval after the forget age.
    const latest = SESSION_FORGET_MS + TICKET_TTL_MS + FORGET_SCAN_MS;
    assert.ok(latest < SWEEP_AGE_MS, `${SESSION_FORGET_MS} + ${TICKET_TTL_MS} + ${FORGET_SCAN_MS} < ${SWEEP_AGE_MS}`);
    assert.equal(SWEEP_AGE_MS, SESSION_FORGET_MS + 3_600_000);
  });

  test('a session directory without last-seen (0.1.0) is swept by its own mtime', () => {
    const now = Date.parse('2026-10-28T12:00:00.000Z');
    const old = sessionDir(box.stateDir, OTHER_SESSION_ID);
    const recent = sessionDir(box.stateDir, 'session-2222-test');
    mkdirSync(old, { recursive: true });
    mkdirSync(recent, { recursive: true });
    const stale = new Date(now - SWEEP_AGE_MS - 60_000);
    const fresh = new Date(now - SWEEP_AGE_MS + 60_000);
    utimesSync(old, stale, stale);
    utimesSync(recent, fresh, fresh);
    sessionStart(context(box.stateDir, input(), {}), MAC_READY, now);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(recent), true);
  });

  test('a non-session entry in the sessions directory is left alone', () => {
    const stray = join(box.stateDir, 'sessions', 'not a session');
    mkdirSync(stray, { recursive: true });
    const stale = new Date(0);
    utimesSync(stray, stale, stale);
    sessionStart(context(box.stateDir, input(), {}), MAC_READY);
    assert.equal(existsSync(stray), true);
  });
});

describe('SessionStart env lines and session files', () => {
  test('appends the state directory, PATH and exit-trap lines once', () => {
    const ctx = { ...context(box.stateDir, { ...input(), cwd: '/work/site' }, { CLAUDE_ENV_FILE: envFile }), pluginRoot: '/plugins/op bridge' };
    sessionStart(ctx, MAC_READY);
    sessionStart(ctx, MAC_READY);
    assert.equal(
      readFileSync(envFile, 'utf8'),
      [
        `export OP_BRIDGE_STATE_DIR='${box.stateDir}'`,
        'export PATH="/plugins/op bridge/bin:$PATH"',
        "[ -f '/plugins/op bridge/bin/exit-trap.sh' ] && . '/plugins/op bridge/bin/exit-trap.sh'",
        '',
      ].join('\n'),
    );
  });

  test('without a plugin root only the state directory line is written', () => {
    sessionStart({ ...context(box.stateDir, input(), { CLAUDE_ENV_FILE: envFile }), pluginRoot: '' }, MAC_READY);
    assert.equal(readFileSync(envFile, 'utf8'), `${stateDirLine(box.stateDir)}\n`);
  });

  test('paths holding a line break still get each line once, and a shell sources them', () => {
    const broken = sandbox('op-bridge-line\nbreak-');
    try {
      const file = join(broken.root, 'claude-env.sh');
      const root = '/plugins/op\nbridge';
      const ctx = { ...context(broken.stateDir, input(), { CLAUDE_ENV_FILE: file }), pluginRoot: root };
      sessionStart(ctx, MAC_READY);
      sessionStart(ctx, MAC_READY);
      assert.equal(readFileSync(file, 'utf8'), [stateDirLine(broken.stateDir), pathLine(root), exitTrapLine(root), ''].join('\n'));
      const run = spawnSync('/bin/sh', ['-c', `. "$1"; printf '%s' "$OP_BRIDGE_STATE_DIR"; printf '%s' "$PATH" >&2`, 'sh', file], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
      });
      assert.equal(run.stdout, broken.stateDir);
      assert.equal(run.stderr, `${root}/bin:/usr/bin:/bin`, 'one <root>/bin on PATH');
    } finally {
      broken.cleanup();
    }
  });

  test('pathLine escapes what a double-quoted string would expand', () => {
    assert.equal(pathLine('/a"b$c`d\\e'), 'export PATH="/a\\"b\\$c\\`d\\\\e/bin:$PATH"');
    assert.equal(stateDirLine("/it's"), "export OP_BRIDGE_STATE_DIR='/it'\\''s'");
    assert.equal(exitTrapLine('/p'), "[ -f '/p/bin/exit-trap.sh' ] && . '/p/bin/exit-trap.sh'");
  });

  test('records the start directory and touches last-seen', () => {
    sessionStart(context(box.stateDir, { ...input(), cwd: '/work/site' }, {}), MAC_READY, 7_000_000);
    assert.deepEqual(readSessionInfo(box.stateDir, SESSION_ID), { cwd: '/work/site' });
    assert.equal(statSync(lastSeenPath(box.stateDir, SESSION_ID)).mtimeMs, 7_000_000);
  });

  test('deletes the grants and env files 0.1.0 left in any session directory', () => {
    for (const id of [SESSION_ID, OTHER_SESSION_ID]) {
      mkdirSync(sessionDir(box.stateDir, id), { recursive: true });
      writeFileSync(join(sessionDir(box.stateDir, id), 'grants.json'), '[]');
      writeFileSync(join(sessionDir(box.stateDir, id), 'env'), '');
    }
    sessionStart(context(box.stateDir, input(), {}), MAC_READY);
    for (const id of [SESSION_ID, OTHER_SESSION_ID]) {
      assert.equal(existsSync(join(sessionDir(box.stateDir, id), 'grants.json')), false);
      assert.equal(existsSync(join(sessionDir(box.stateDir, id), 'env')), false);
    }
  });

  test('a leftover that cannot be deleted stops neither the sweep nor the other leftover', () => {
    const now = Date.parse('2026-10-28T12:00:00.000Z');
    const recent = 'session-2222-test';
    touchLastSeen(box.stateDir, OTHER_SESSION_ID, now - 8 * 24 * 60 * 60 * 1000);
    mkdirSync(join(sessionDir(box.stateDir, OTHER_SESSION_ID), 'env'));
    touchLastSeen(box.stateDir, recent, now);
    mkdirSync(join(sessionDir(box.stateDir, recent), 'grants.json'));
    writeFileSync(join(sessionDir(box.stateDir, recent), 'env'), '');
    sessionStart(context(box.stateDir, input(), {}), MAC_READY, now);
    assert.equal(existsSync(sessionDir(box.stateDir, OTHER_SESSION_ID)), false, 'the old session is swept');
    assert.equal(existsSync(join(sessionDir(box.stateDir, recent), 'env')), false, 'the other leftover is deleted');
    const lines = readFileSync(hookLogPath(box.stateDir), 'utf8').trim().split('\n');
    const logged = lines.map((line) => {
      const { event, step, code } = JSON.parse(line) as Record<string, unknown>;
      return { event, step, code };
    });
    const line = { event: 'SessionStart', step: 'legacy', code: 'ERR_FS_EISDIR' };
    assert.deepEqual(logged, [line, line]);
  });

  test('the sweep keys on last-seen, not on the directory mtime', () => {
    const now = 100 * SWEEP_AGE_MS;
    touchLastSeen(box.stateDir, OTHER_SESSION_ID, now - SWEEP_AGE_MS - 1);
    const fresh = new Date(now);
    utimesSync(sessionDir(box.stateDir, OTHER_SESSION_ID), fresh, fresh);
    sessionStart(context(box.stateDir, input(), {}), MAC_READY, now);
    assert.equal(existsSync(sessionDir(box.stateDir, OTHER_SESSION_ID)), false);
  });
});

describe('sessionStart: diagnostics', () => {
  test('macOS with the app and osascript: nothing', () => {
    assert.equal(sessionStart(context(box.stateDir, input(), {}), MAC_READY), undefined);
  });

  test('macOS with the app under the home directory: nothing', () => {
    const p = probe('darwin', [`${HOME}${MAC_LIB}`], ['/usr/bin/osascript']);
    assert.equal(sessionStart(context(box.stateDir, input(), {}), p), undefined);
  });

  test('macOS without the app: systemMessage and additionalContext name the library', () => {
    const out = sessionStart(context(box.stateDir, input(), {}), probe('darwin', [], ['/usr/bin/osascript']));
    assert.ok(out?.systemMessage?.startsWith('1password-bridge: '));
    assert.ok(out?.systemMessage?.includes('libop_sdk_ipc_client.dylib'));
    assert.ok(out?.systemMessage?.includes(SDK_INTEGRATION_SETTING));
    assert.equal(out?.hookSpecificOutput?.hookEventName, 'SessionStart');
    const ctx = out?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes(out?.systemMessage ?? '?'));
    assert.ok(ctx.includes('tickets cannot be issued or redeemed'), ctx);
  });

  test('macOS without osascript: the window backend is named; tickets can still be issued', () => {
    const out = sessionStart(context(box.stateDir, input(), {}), probe('darwin', [MAC_LIB], []));
    assert.ok(out?.systemMessage?.includes('osascript'));
    assert.ok(!out?.systemMessage?.includes('libop_sdk_ipc_client'));
    const ctx = out?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('tickets can be issued but not redeemed: every redeem needs the approval window'), ctx);
    assert.ok(!ctx.includes('cannot be issued'), ctx);
  });

  test('macOS without osascript and the app: tickets can be neither issued nor redeemed', () => {
    const out = sessionStart(context(box.stateDir, input(), {}), probe('darwin', [], []));
    assert.ok(out?.systemMessage?.includes('osascript') && out.systemMessage.includes('libop_sdk_ipc_client.dylib'));
    const ctx = out?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('tickets cannot be issued or redeemed'), ctx);
    assert.ok(!ctx.includes('can be issued but'), ctx);
  });

  test('Linux with zenity on PATH and the library in any SDK location: nothing', () => {
    for (const lib of ['/usr/bin/1password', '/opt/1Password', '/snap/bin/1password']) {
      const p = probe('linux', [`${lib}/libop_sdk_ipc_client.so`], ['/opt/tools/zenity']);
      const env = { PATH: '/usr/local/bin::/opt/tools' };
      assert.deepEqual(missingDependencies(env, p), [], lib);
      assert.equal(sessionStart(context(box.stateDir, input(), env), p), undefined, lib);
    }
  });

  test('Linux without zenity: the window backend is named; tickets can still be issued', () => {
    const p = probe('linux', ['/opt/1Password/libop_sdk_ipc_client.so'], []);
    const out = sessionStart(context(box.stateDir, input(), { PATH: '/usr/bin' }), p);
    assert.ok(out?.systemMessage?.includes('zenity'));
    assert.ok(!out?.systemMessage?.includes('libop_sdk_ipc_client'));
    const ctx = out?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('tickets can be issued but not redeemed: every redeem needs the approval window'), ctx);
    assert.ok(!ctx.includes('cannot be issued'), ctx);
  });

  test('Linux without the app: the library is named; tickets can be neither issued nor redeemed', () => {
    const p = probe('linux', [], ['/usr/bin/zenity']);
    const out = sessionStart(context(box.stateDir, input(), { PATH: '/usr/bin' }), p);
    assert.ok(out?.systemMessage?.includes('libop_sdk_ipc_client.so'));
    assert.ok(out?.systemMessage?.includes(SDK_INTEGRATION_SETTING));
    assert.ok(!out?.systemMessage?.includes('zenity'));
    assert.ok(out?.hookSpecificOutput?.additionalContext?.includes('tickets cannot be issued or redeemed'));
  });

  test('another platform is reported as unsupported; tickets can be neither issued nor redeemed', () => {
    const out = sessionStart(context(box.stateDir, input(), {}), probe('win32'));
    assert.ok(out?.systemMessage?.includes('not supported'));
    assert.ok(out?.hookSpecificOutput?.additionalContext?.includes('not supported'));
    assert.ok(out?.hookSpecificOutput?.additionalContext?.includes('tickets cannot be issued or redeemed'));
  });

  test('diagnostics still run for an invalid session id', () => {
    const out = sessionStart(context(box.stateDir, input('../x'), {}), probe('win32'));
    assert.ok(out?.systemMessage?.includes('not supported'));
  });
});
