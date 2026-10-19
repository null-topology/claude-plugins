import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import {
  currentDriver,
  currentOwner,
  liveness,
  localHostId,
  ownerKey,
  parseOwnerKey,
  parseProcStat,
  processStartTime,
} from '../../src/store/identity.ts';
import { deadIdentity, startIdleProcess } from '../helpers/processes.ts';

/** Set off Linux: these tests read and write `/proc`. */
const LINUX_ONLY = process.platform === 'linux' ? false : 'reads /proc, Linux only';

/** A /proc stat line with the given command name and start time in field 22. */
function statLine(name: string, startTime: string): string {
  const fields = Array.from({ length: 52 }, (_, index) => String(index + 1));
  fields[0] = '4242';
  fields[1] = `(${name})`;
  fields[2] = 'S';
  fields[21] = startTime;
  return `${fields.join(' ')}\n`;
}

async function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  const lines = createInterface({ input: stream });
  const [line] = (await once(lines, 'line')) as [string];
  lines.close();
  return line;
}

describe('start time parsing', () => {
  test('field 22 is found after the last parenthesis of the command name', () => {
    assert.deepEqual(parseProcStat(statLine('node', '987654')), { state: 'S', startTime: '987654' });
    assert.deepEqual(parseProcStat(statLine('a) (b c', '123')), { state: 'S', startTime: '123' });
    assert.deepEqual(parseProcStat(statLine(') ( 1 2 3 ) (', '77')), { state: 'S', startTime: '77' });
  });

  test('a stat line without a start time is rejected', () => {
    assert.throws(() => parseProcStat('4242 node S 1 2 3'), /no command name/);
    assert.throws(() => parseProcStat('4242 (node) S 1 2 3'), /no start time/);
    assert.throws(() => parseProcStat(statLine('node', 'abc')), /no start time/);
  });

  test('a live process renamed to "x) (y z" keeps its start time', { timeout: 15_000, skip: LINUX_ONLY }, async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "require('node:fs').writeFileSync('/proc/self/comm', 'x) (y z'); console.log('renamed'); setInterval(() => {}, 60_000);",
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const exited = once(child, 'exit');
    try {
      const pid = child.pid;
      assert.ok(pid !== undefined);
      const before = await processStartTime(pid);
      assert.ok(child.stdout !== null);
      assert.equal(await firstLine(child.stdout), 'renamed');
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      assert.ok(stat.includes('(x) (y z)'), stat);
      assert.equal(await processStartTime(pid), before);
      assert.match(before ?? '', /^[0-9]+$/);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });
});

describe('host id', () => {
  test('is the hostname, the boot id and the pid namespace inode', { skip: LINUX_ONLY }, async () => {
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const hostId = await localHostId();
    assert.ok(hostId.startsWith(`${hostname()}:${bootId}:`), hostId);
    assert.match(hostId, /:[0-9]+$/);
    assert.equal(await localHostId(), hostId);
  });
});

describe('identities', () => {
  test('the driver is this process and the owner its parent', async () => {
    const driver = await currentDriver();
    const owner = await currentOwner();
    assert.equal(driver.pid, process.pid);
    assert.equal(owner.pid, process.ppid);
    assert.equal(driver.hostId, await localHostId());
    assert.equal(await liveness(driver), 'alive');
    assert.equal(await liveness(owner), 'alive');
  });

  test('an owner key round-trips', async () => {
    const owner = await currentOwner();
    const key = ownerKey(owner);
    assert.equal(key, `pid-${owner.pid}-${owner.startTime}@${owner.hostId}`);
    assert.deepEqual(parseOwnerKey(key), owner);
    assert.deepEqual(parseOwnerKey('pid-12-Sat_Oct_18_02:15:03_2026@laptop:1729220000.5'), {
      pid: 12,
      startTime: 'Sat_Oct_18_02:15:03_2026',
      hostId: 'laptop:1729220000.5',
    });
  });

  test('a malformed owner key parses to null', () => {
    for (const key of ['', 'pid-1-2', 'pid--2@h', 'pid-0-2@h', 'pid-x-2@h', 'process-1-2@h', 'pid-1-@h', 'pid-1-2@']) {
      assert.equal(parseOwnerKey(key), null, key);
    }
  });

  test('an invalid pid is refused before any probe', async () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(processStartTime(pid), TypeError, String(pid));
    }
  });
});

describe('liveness', () => {
  test('a live child is alive', async () => {
    const idle = await startIdleProcess();
    try {
      assert.equal(await liveness(idle.identity), 'alive');
    } finally {
      await idle.stop();
    }
  });

  test('a killed child is dead', async () => {
    const identity = await deadIdentity();
    assert.equal(await processStartTime(identity.pid), null);
    assert.equal(await liveness(identity), 'dead');
  });

  test('a live pid with another start time is dead (pid reuse)', async () => {
    const idle = await startIdleProcess();
    try {
      const reused = { ...idle.identity, startTime: String(Number(idle.identity.startTime) - 1) };
      assert.equal(await liveness(reused), 'dead');
    } finally {
      await idle.stop();
    }
  });

  test('a record of another host is never judged dead', async () => {
    const dead = await deadIdentity();
    const driver = await currentDriver();
    assert.equal(await liveness({ ...dead, hostId: 'elsewhere:boot:1' }), 'other-host');
    assert.equal(await liveness({ ...driver, hostId: 'elsewhere:boot:1' }), 'other-host');
  });

  test('a zombie is not running', { timeout: 15_000, skip: LINUX_ONLY }, async () => {
    // The shell starts `sleep 0` in the background and replaces itself with
    // `sleep 30`, which never reaps it: the background child stays a zombie.
    const parent = spawn('sh', ['-c', 'sleep 0 & echo $!; exec sleep 30'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const exited = once(parent, 'exit');
    try {
      assert.ok(parent.stdout !== null);
      const zombie = Number(await firstLine(parent.stdout));
      let state = '';
      for (let poll = 0; poll < 100 && state !== 'Z'; poll += 1) {
        state = parseProcStat(await readFile(`/proc/${zombie}/stat`, 'utf8')).state;
        if (state !== 'Z') {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      assert.equal(state, 'Z');
      assert.equal(await processStartTime(zombie), null);
    } finally {
      parent.kill('SIGKILL');
      await exited;
    }
  });
});
