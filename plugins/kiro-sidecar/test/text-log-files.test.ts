import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_LOG_CAP_BYTES, MiB, STDERR_LOG_CAP_BYTES, TURN_TEXT_CAP_BYTES } from '../src/text/limits.ts';
import { AcpLog, StderrLog, TurnTextWriter } from '../src/text/log-files.ts';
import { REDACTED, SecretSet } from '../src/text/redact.ts';

const TOKEN = 'ksk_test_0123456789abcdefXYZ';
const QUOTED = 'pass"word\\0123456789';
const secrets = new SecretSet([TOKEN, QUOTED]);

let root = '';
let counter = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'kiro-sidecar-text-'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function freshDir(): string {
  counter += 1;
  return mkdtempSync(join(root, `case-${counter}-`));
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function lines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').slice(0, -1);
}

describe('acp.jsonl writer', () => {
  test('it creates the file with mode 0600 and redacts every line', () => {
    const path = join(freshDir(), 'acp.jsonl');
    const log = AcpLog.open(path, { secrets });
    assert.equal(log.write(JSON.stringify({ event: 'spawn', argv: ['-e', `KIRO_API_KEY=${TOKEN}`] })), true);
    assert.equal(log.write(JSON.stringify({ event: 'error', message: `bad ${QUOTED}` }), { lifecycle: true }), true);
    log.close();
    assert.equal(mode(path), 0o600);
    const written = lines(path).map((line) => JSON.parse(line) as unknown);
    assert.deepEqual(written, [
      { event: 'spawn', argv: ['-e', `KIRO_API_KEY=${REDACTED}`] },
      { event: 'error', message: `bad ${REDACTED}` },
    ]);
    const raw = readFileSync(path, 'utf8');
    assert.ok(!raw.includes(TOKEN) && !raw.includes(JSON.stringify(QUOTED).slice(1, -1)));
  });

  test('past the cap ordinary lines are dropped whole, lifecycle lines still written, and one marker added', () => {
    const path = join(freshDir(), 'acp.jsonl');
    const log = AcpLog.open(path, { secrets, capBytes: 100 });
    const line = (n: number): string => JSON.stringify({ event: 'len', n, pad: 'x'.repeat(10) });
    const results: boolean[] = [];
    for (let n = 0; n < 6; n += 1) {
      results.push(log.write(line(n)));
    }
    assert.equal(log.capped, true);
    assert.equal(log.write(JSON.stringify({ event: 'turn_end', turn: 1 }), { lifecycle: true }), true);
    assert.equal(log.write(line(99)), false);
    log.close();
    const written = lines(path).map((text) => JSON.parse(text) as { event: string; n?: number });
    const lineBytes = Buffer.byteLength(`${line(0)}\n`);
    const fitting = Math.floor(100 / lineBytes);
    assert.deepEqual(results, [...Array(6).keys()].map((n) => n < fitting));
    assert.deepEqual(
      written.map((entry) => entry.event),
      [...Array(fitting).fill('len'), 'acp_log_capped', 'turn_end'],
    );
    assert.deepEqual(written[fitting], { event: 'acp_log_capped', capBytes: 100 });
  });

  test('an existing file is appended to, counts towards the cap and is set to 0600', () => {
    const path = join(freshDir(), 'acp.jsonl');
    writeFileSync(path, `${JSON.stringify({ event: 'earlier', pad: 'y'.repeat(70) })}\n`);
    chmodSync(path, 0o644);
    const log = AcpLog.open(path, { secrets, capBytes: 100 });
    assert.equal(mode(path), 0o600);
    assert.equal(log.bytes, statSync(path).size);
    assert.equal(log.write(JSON.stringify({ event: 'len', pad: 'z'.repeat(30) })), false);
    log.close();
    assert.deepEqual(
      lines(path).map((text) => (JSON.parse(text) as { event: string }).event),
      ['earlier', 'acp_log_capped'],
    );
  });

  test('a symlink at the path is not followed', () => {
    const dir = freshDir();
    const target = join(dir, 'elsewhere.txt');
    writeFileSync(target, 'keep\n');
    symlinkSync(target, join(dir, 'acp.jsonl'));
    assert.throws(() => AcpLog.open(join(dir, 'acp.jsonl'), { secrets }), { code: 'ELOOP' });
    assert.equal(readFileSync(target, 'utf8'), 'keep\n');
  });
});

describe('stderr.log writer', () => {
  test('bytes are decoded across chunks and a split secret is redacted', () => {
    const path = join(freshDir(), 'stderr.log');
    const log = StderrLog.open(path, { secrets });
    const bytes = Buffer.from(`warning: café token=${TOKEN} done\n`, 'utf8');
    const accentAt = bytes.indexOf(0xc3);
    const tokenAt = bytes.indexOf(Buffer.from(TOKEN));
    const cuts = [0, accentAt + 1, tokenAt + 5, tokenAt + 20, bytes.length];
    for (let i = 0; i + 1 < cuts.length; i += 1) {
      log.write(bytes.subarray(cuts[i], cuts[i + 1]));
    }
    log.close();
    assert.equal(mode(path), 0o600);
    assert.equal(readFileSync(path, 'utf8'), `warning: café token=${REDACTED} done\n`);
  });

  test('held-back text reaches the file on close', () => {
    const path = join(freshDir(), 'stderr.log');
    const log = StderrLog.open(path, { secrets });
    log.write(`line one\nends with ${TOKEN.slice(0, 8)}`);
    assert.ok(!readFileSync(path, 'utf8').includes(TOKEN.slice(0, 8)));
    log.close();
    assert.equal(readFileSync(path, 'utf8'), `line one\nends with ${TOKEN.slice(0, 8)}`);
  });

  test('at the cap the part that fits is written, then the marker, then nothing', () => {
    const path = join(freshDir(), 'stderr.log');
    const log = StderrLog.open(path, { secrets: new SecretSet(), capBytes: 51 });
    log.write('é'.repeat(40));
    log.write('later output\n');
    log.close();
    assert.equal(log.capped, true);
    const text = readFileSync(path, 'utf8');
    const marker = '\n[kiro-sidecar] stderr.log reached its 51 bytes cap; later output was dropped\n';
    assert.equal(text, 'é'.repeat(25) + marker);
  });
});

describe('a URL-encoded secret with lower-case percent escapes', () => {
  // `pass%22word%5c0123456789`: `encodeURIComponent(QUOTED)` with `%5C` written as `%5c`.
  const encoded = encodeURIComponent(QUOTED).replace('%5C', '%5c');

  test('is redacted in acp.jsonl', () => {
    const path = join(freshDir(), 'acp.jsonl');
    const log = AcpLog.open(path, { secrets });
    assert.equal(log.write(JSON.stringify({ event: 'error', message: `url ?p=${encoded}&x=1` })), true);
    log.close();
    assert.deepEqual(lines(path).map((line) => JSON.parse(line) as unknown), [{ event: 'error', message: `url ?p=${REDACTED}&x=1` }]);
  });

  test('is redacted in stderr.log when split across chunks', () => {
    const path = join(freshDir(), 'stderr.log');
    const log = StderrLog.open(path, { secrets });
    const bytes = Buffer.from(`proxy ?p=${encoded}&x=1\n`, 'utf8');
    const at = bytes.indexOf(Buffer.from('%5c'));
    for (const piece of [bytes.subarray(0, at + 1), bytes.subarray(at + 1, at + 2), bytes.subarray(at + 2)]) {
      log.write(piece);
    }
    log.close();
    assert.equal(readFileSync(path, 'utf8'), `proxy ?p=${REDACTED}&x=1\n`);
  });

  test('is redacted in the turn text when split across chunks', () => {
    const dir = freshDir();
    const writer = TurnTextWriter.open(dir, 1, { secrets });
    for (const chunk of ['Use ', encoded.slice(0, 13), encoded.slice(13), ' now.\n']) {
      writer.write(chunk);
    }
    writer.finalize();
    assert.equal(readFileSync(writer.path, 'utf8'), `Use ${REDACTED} now.\n`);
  });
});

describe('turn text writer', () => {
  test('text streams to <n>.md.part and finalize renames it to <n>.md', () => {
    const dir = freshDir();
    const writer = TurnTextWriter.open(dir, 3, { secrets });
    assert.equal(writer.partPath, join(dir, '3.md.part'));
    assert.equal(writer.path, join(dir, '3.md'));
    for (const chunk of ['Plan: use ', TOKEN.slice(0, 11), TOKEN.slice(11), ' then report.\n']) {
      writer.write(chunk);
    }
    assert.ok(existsSync(writer.partPath));
    assert.ok(!existsSync(writer.path));
    const result = writer.finalize();
    assert.deepEqual(result, {
      path: join(dir, '3.md'),
      bytes: Buffer.byteLength(`Plan: use ${REDACTED} then report.\n`),
      truncated: false,
    });
    assert.ok(!existsSync(writer.partPath));
    assert.equal(mode(writer.path), 0o600);
    assert.equal(readFileSync(writer.path, 'utf8'), `Plan: use ${REDACTED} then report.\n`);
  });

  test('past the cap the text is marked and the turn is truncated', () => {
    const dir = freshDir();
    const writer = TurnTextWriter.open(dir, 1, { secrets, capBytes: 64 });
    for (let i = 0; i < 10; i += 1) {
      writer.write('0123456789abcdef');
    }
    assert.equal(writer.truncated, true);
    const result = writer.finalize();
    assert.equal(result.truncated, true);
    const marker = '\n\n[kiro-sidecar] The turn text reached its 64 bytes cap; the rest was not saved.\n';
    assert.equal(readFileSync(result.path, 'utf8'), '0123456789abcdef'.repeat(4) + marker);
  });

  test('finalize runs once and later writes are ignored', () => {
    const writer = TurnTextWriter.open(freshDir(), 2, { secrets });
    writer.write('done\n');
    writer.finalize();
    writer.write('ignored');
    assert.throws(() => writer.finalize(), /already finalized/);
    assert.equal(readFileSync(writer.path, 'utf8'), 'done\n');
  });

  test('the turn number must be a positive integer', () => {
    for (const turn of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => TurnTextWriter.open(freshDir(), turn, { secrets }), RangeError);
    }
  });
});

describe('real caps', () => {
  test('the default caps are 20 MiB, 5 MiB and 2 MiB and each is enforced', () => {
    assert.equal(ACP_LOG_CAP_BYTES, 20 * MiB);
    assert.equal(STDERR_LOG_CAP_BYTES, 5 * MiB);
    assert.equal(TURN_TEXT_CAP_BYTES, 2 * MiB);
    const dir = freshDir();
    const block = 'a'.repeat(64 * 1024 - 1);

    const turn = TurnTextWriter.open(dir, 1, { secrets });
    for (let written = 0; written < TURN_TEXT_CAP_BYTES + 128 * 1024; written += block.length) {
      turn.write(block);
    }
    const result = turn.finalize();
    const turnMarker = '\n\n[kiro-sidecar] The turn text reached its 2 MiB cap; the rest was not saved.\n';
    assert.equal(result.truncated, true);
    assert.equal(statSync(result.path).size, TURN_TEXT_CAP_BYTES + Buffer.byteLength(turnMarker));

    const stderr = StderrLog.open(join(dir, 'stderr.log'), { secrets });
    for (let written = 0; written < STDERR_LOG_CAP_BYTES + 128 * 1024; written += block.length) {
      stderr.write(block);
    }
    stderr.close();
    const stderrMarker = '\n[kiro-sidecar] stderr.log reached its 5 MiB cap; later output was dropped\n';
    assert.equal(statSync(join(dir, 'stderr.log')).size, STDERR_LOG_CAP_BYTES + Buffer.byteLength(stderrMarker));

    const acp = AcpLog.open(join(dir, 'acp.jsonl'), { secrets });
    const line = JSON.stringify({ event: 'frame', pad: 'b'.repeat(MiB - 32) });
    let accepted = 0;
    for (let i = 0; i < 22; i += 1) {
      accepted += acp.write(line) ? 1 : 0;
    }
    acp.close();
    const lineBytes = Buffer.byteLength(`${line}\n`);
    assert.equal(accepted, Math.floor(ACP_LOG_CAP_BYTES / lineBytes));
    const acpMarker = `${JSON.stringify({ event: 'acp_log_capped', capBytes: ACP_LOG_CAP_BYTES })}\n`;
    assert.equal(
      statSync(join(dir, 'acp.jsonl')).size,
      accepted * lineBytes + Buffer.byteLength(acpMarker),
    );
  });
});
