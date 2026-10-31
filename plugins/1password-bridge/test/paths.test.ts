import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  boardDir,
  isSessionId,
  lastSeenPath,
  maskedMarkerPath,
  resolveStateDir,
  sessionDir,
  sessionInfoPath,
  socketPath,
} from '../src/paths.ts';
import { PROTOCOL_VERSION } from '../src/version.ts';

const SOCKET = `broker-v${PROTOCOL_VERSION}.sock`;

describe('resolveStateDir', () => {
  test('CLAUDE_PLUGIN_DATA wins over every fallback', () => {
    assert.equal(
      resolveStateDir({ CLAUDE_PLUGIN_DATA: '/data/plugin', XDG_STATE_HOME: '/xdg', HOME: '/home/u' }),
      '/data/plugin',
    );
  });

  test('a relative CLAUDE_PLUGIN_DATA is resolved to an absolute path', () => {
    assert.equal(resolveStateDir({ CLAUDE_PLUGIN_DATA: 'rel/data' }), resolve('rel/data'));
  });

  test('an empty CLAUDE_PLUGIN_DATA falls back to XDG_STATE_HOME', () => {
    assert.equal(
      resolveStateDir({ CLAUDE_PLUGIN_DATA: '', XDG_STATE_HOME: '/xdg', HOME: '/home/u' }),
      '/xdg/1password-bridge',
    );
  });

  test('a relative XDG_STATE_HOME is ignored', () => {
    assert.equal(
      resolveStateDir({ XDG_STATE_HOME: 'relative', HOME: '/home/u' }),
      '/home/u/.local/state/1password-bridge',
    );
  });

  test('HOME is the last fallback, then the OS home directory', () => {
    assert.equal(resolveStateDir({ HOME: '/home/u' }), '/home/u/.local/state/1password-bridge');
    assert.equal(resolveStateDir({}), join(homedir(), '.local', 'state', '1password-bridge'));
  });
});

describe('session ids and session paths', () => {
  test('accepts letters, digits, dash and underscore up to 128 characters', () => {
    assert.ok(isSessionId('0b6f3c1e-8f0a-4a57-9d43-2f1f0c9a7e11'));
    assert.ok(isSessionId('a_B-9'));
    assert.ok(isSessionId('x'.repeat(128)));
  });

  test('refuses traversal, separators, dots, empty and over-long ids', () => {
    for (const id of ['../x', '', 'x'.repeat(129), 'a/b', 'a.b', '..', 'a b', 'a\nb']) {
      assert.equal(isSessionId(id), false, JSON.stringify(id));
    }
  });

  test('session paths live under <stateDir>/sessions/<id>', () => {
    assert.equal(sessionDir('/state', 'abc'), '/state/sessions/abc');
    assert.equal(boardDir('/state', 'abc'), '/state/sessions/abc/board');
    assert.equal(maskedMarkerPath('/state', 'abc'), '/state/sessions/abc/masked');
    assert.equal(lastSeenPath('/state', 'abc'), '/state/sessions/abc/last-seen');
    assert.equal(sessionInfoPath('/state', 'abc'), '/state/sessions/abc/session.json');
  });

  test('every session path throws on an invalid id', () => {
    for (const id of ['../x', '', 'x'.repeat(129)]) {
      for (const path of [sessionDir, boardDir, maskedMarkerPath, lastSeenPath, sessionInfoPath]) {
        assert.throws(() => path('/state', id), TypeError, `${path.name} ${id}`);
      }
    }
  });
});

describe('socketPath', () => {
  const suffix = `/run/${SOCKET}`;
  /** A state directory whose preferred socket path is 101 bytes, one too long. */
  const longStateDir = `/${'s'.repeat(100 - suffix.length)}`;

  test('the socket lives in <stateDir>/run when the path is short enough', () => {
    assert.equal(socketPath('/state', 501, '/tmp', undefined), `/state/run/${SOCKET}`);
  });

  test('a path of exactly 100 bytes stays in the state directory', () => {
    const stateDir = `/${'s'.repeat(100 - suffix.length - 1)}`;
    assert.equal(Buffer.byteLength(`${stateDir}${suffix}`), 100);
    assert.equal(socketPath(stateDir, 501, '/tmp', undefined), `${stateDir}${suffix}`);
  });

  test('a path longer than 100 bytes moves to a per-user directory in tmp', () => {
    assert.equal(Buffer.byteLength(`${longStateDir}${suffix}`), 101);
    assert.equal(socketPath(longStateDir, 501, '/tmp', undefined), `/tmp/1password-bridge-501/${SOCKET}`);
  });

  test('the limit counts bytes, not characters', () => {
    // 60 two-byte characters: 60 characters, 120 bytes.
    const stateDir = `/${'я'.repeat(60)}`;
    assert.ok(`${stateDir}${suffix}`.length <= 100);
    assert.equal(socketPath(stateDir, 1000, '/var/tmp', undefined), `/var/tmp/1password-bridge-1000/${SOCKET}`);
  });

  test('a path too long for the state directory prefers XDG_RUNTIME_DIR over tmp', () => {
    assert.equal(socketPath(longStateDir, 1000, '/tmp', '/run/user/1000'), `/run/user/1000/1password-bridge/${SOCKET}`);
  });

  test('a short enough state directory path wins over XDG_RUNTIME_DIR', () => {
    assert.equal(socketPath('/state', 1000, '/tmp', '/run/user/1000'), `/state/run/${SOCKET}`);
  });

  test('an empty or relative XDG_RUNTIME_DIR is ignored', () => {
    for (const runtimeDir of ['', 'run/user/1000', './run']) {
      assert.equal(socketPath(longStateDir, 1000, '/tmp', runtimeDir), `/tmp/1password-bridge-1000/${SOCKET}`, runtimeDir);
    }
  });

  test('an XDG_RUNTIME_DIR whose socket path is longer than 100 bytes is skipped', () => {
    const tail = `/1password-bridge/${SOCKET}`;
    const fits = `/${'r'.repeat(100 - tail.length - 1)}`;
    assert.equal(Buffer.byteLength(`${fits}${tail}`), 100);
    assert.equal(socketPath(longStateDir, 1000, '/tmp', fits), `${fits}${tail}`);
    const tooLong = `${fits}r`;
    assert.equal(socketPath(longStateDir, 1000, '/tmp', tooLong), `/tmp/1password-bridge-1000/${SOCKET}`);
  });
});
