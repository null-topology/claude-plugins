import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { encodeAck, encodeLine, FAILURE_CODES, FrameError, lineReader, parseAck, parseRequest, parseResponse, readLine, type Request, type Response } from '../src/protocol.ts';
import { PROTOCOL_VERSION } from '../src/version.ts';

const ISSUE: Request = {
  v: PROTOCOL_VERSION,
  op: 'issue_tickets',
  account: 'ACCOUNTUUID',
  accountLabel: 'example.1password.test · someone@example.test',
  ref: 'op://Vault/Item/token',
  reason: 'deploy the staging stack',
  count: 1,
  session: { id: 'session-0000-test', title: 'Deploy' },
  agent: { id: 'main' },
};

const FIELD = { id: 'fieldid', title: 'token', sectionId: 'sectionid', section: 'API', type: 'Concealed', masked: true };

describe('encodeLine', () => {
  test('one JSON document on one line, ending in a newline', () => {
    const line = encodeLine(ISSUE);
    assert.ok(line.endsWith('\n'));
    assert.equal(line.indexOf('\n'), line.length - 1);
    assert.deepEqual(parseRequest(line.slice(0, -1)), ISSUE);
  });
});

describe('parseRequest', () => {
  test('accepts every op and keeps only the known fields', () => {
    assert.deepEqual(parseRequest(`{"v":${PROTOCOL_VERSION},"op":"status","extra":1}`), { v: PROTOCOL_VERSION, op: 'status' });
    assert.deepEqual(parseRequest(`{"v":${PROTOCOL_VERSION},"op":"fields","account":"a","ref":"op://V/I","x":true}`), { v: PROTOCOL_VERSION, op: 'fields', account: 'a', ref: 'op://V/I' });
    const untitled = { id: 'session-0000-test' };
    const issue = parseRequest(JSON.stringify({ ...ISSUE, session: untitled, extra: 'x' }));
    assert.deepEqual(issue, { ...ISSUE, session: untitled });
  });

  test('rejects another protocol version, an unknown op, missing or mistyped fields, and non-JSON', () => {
    const bad = [
      JSON.stringify({ v: PROTOCOL_VERSION - 1, op: 'status' }),
      '{"op":"status"}',
      `{"v":${PROTOCOL_VERSION},"op":"delete"}`,
      `{"v":${PROTOCOL_VERSION},"op":"fields","account":"a"}`,
      `{"v":${PROTOCOL_VERSION},"op":"fields","account":1,"ref":"r"}`,
      JSON.stringify({ ...ISSUE, reason: undefined }),
      JSON.stringify({ ...ISSUE, session: { id: 7 } }),
      JSON.stringify({ ...ISSUE, session: { id: 'session-0000-test', title: 3 } }),
      JSON.stringify({ ...ISSUE, agent: { id: 'main', type: 3 } }),
      JSON.stringify({ ...ISSUE, agent: 'main' }),
      // `get` was removed with the grants.
      `{"v":${PROTOCOL_VERSION},"op":"get","account":"a","accountLabel":"a","ref":"op://V/I/f","reason":"r","session":{"id":"session-0000-test"},"held":{}}`,
      '[]',
      'null',
      `{"v":${PROTOCOL_VERSION},`,
    ];
    for (const line of bad) assert.equal(parseRequest(line), null, line);
  });
});

describe('parseResponse', () => {
  test('accepts each success for the op that was asked', () => {
    const status = { ok: true, op: 'status', accounts: [{ account: 'a', warm: true }], exitsAt: '2026-10-28T13:00:00.000Z' };
    assert.deepEqual(parseResponse(JSON.stringify(status), 'status'), status);
    const fields = { ok: true, op: 'fields', vault: 'Vault', item: { title: 'Item', category: 'Login' }, fields: [FIELD, { ...FIELD, sectionId: undefined, section: undefined }] };
    assert.deepEqual(parseResponse(JSON.stringify(fields), 'fields'), JSON.parse(JSON.stringify(fields)));
  });

  test('accepts every failure code with a message; the grant-era codes are gone', () => {
    for (const code of FAILURE_CODES) {
      assert.deepEqual(parseResponse(JSON.stringify({ ok: false, code, message: 'm' }), 'fields'), { ok: false, code, message: 'm' });
    }
    for (const code of ['timeout', 'name_conflict']) {
      assert.equal(parseResponse(JSON.stringify({ ok: false, code, message: 'm' }), 'fields'), null, code);
    }
  });

  test('rejects a success for another op, an unknown code and malformed bodies', () => {
    const bad: [string, Request['op']][] = [
      ['{"ok":true,"op":"status","accounts":[],"exitsAt":"t"}', 'fields'],
      ['{"ok":false,"code":"exploded","message":"m"}', 'fields'],
      ['{"ok":false,"code":"denied"}', 'fields'],
      ['{"ok":true,"op":"status","accounts":[{"account":"a"}],"exitsAt":"t"}', 'status'],
      [JSON.stringify({ ok: true, op: 'fields', vault: 'V', item: { title: 'I', category: 'C' }, fields: [{ ...FIELD, id: undefined }] }), 'fields'],
      [JSON.stringify({ ok: true, op: 'fields', vault: 'V', item: { title: 'I', category: 'C' }, fields: [{ ...FIELD, sectionId: 1 }] }), 'fields'],
      ['{"ok":"true"}', 'status'],
      ['not json', 'status'],
    ];
    for (const [line, op] of bad) assert.equal(parseResponse(line, op), null, line);
  });
});

describe('readLine', () => {
  test('returns the first line across chunks, multi-byte characters included', async () => {
    const stream = new PassThrough();
    const pending = readLine(stream);
    const bytes = Buffer.from('{"a":"é·x"}\nrest');
    stream.write(bytes.subarray(0, 7));
    stream.write(bytes.subarray(7));
    assert.equal(await pending, '{"a":"é·x"}');
  });

  test('a stream that ends or fails before a newline gives null', async () => {
    const ended = new PassThrough();
    const pending = readLine(ended);
    ended.end('{"partial":');
    assert.equal(await pending, null);
    const failed = new PassThrough();
    const pendingFailed = readLine(failed);
    failed.destroy(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    assert.equal(await pendingFailed, null);
  });

  test('a line longer than the limit is a FrameError', async () => {
    const stream = new PassThrough();
    const pending = readLine(stream, 16);
    stream.write('x'.repeat(17));
    await assert.rejects(pending, FrameError);
  });
});

describe('protocol v2', () => {
  const v = PROTOCOL_VERSION;
  const issue: Request = {
    v,
    op: 'issue_tickets',
    account: 'example.1password.test',
    accountLabel: 'Work',
    ref: 'op://Deploy/Deploy server/api token',
    reason: 'deploy the staging site',
    count: 2,
    session: { id: 'session-0000-test', title: 'Deploy' },
    agent: { id: 'agent-1', type: 'general-purpose' },
  };

  test('the protocol version is 2', () => {
    assert.equal(PROTOCOL_VERSION, 2);
  });

  test('issue_tickets parses back and checks count, session and agent', () => {
    assert.deepEqual(parseRequest(encodeLine(issue).trimEnd()), issue);
    for (const count of [0, 6, 1.5, '2']) assert.equal(parseRequest(JSON.stringify({ ...issue, count })), null, String(count));
    assert.equal(parseRequest(JSON.stringify({ ...issue, session: { id: '../x' } })), null);
    assert.equal(parseRequest(JSON.stringify({ ...issue, agent: { id: '' } })), null);
  });

  test('redeem, mask, release and end_session parse back; a bad session id is rejected', () => {
    const requests: Request[] = [
      { v, op: 'redeem', ticket: 'tkt_abcdefghijklmnop', session: 'session-0000-test' },
      { v, op: 'mask', session: 'session-0000-test', tickets: ['tkt_abcdefghijklmnop'], output: { stdout: 'x', interrupted: false } },
      { v, op: 'release', session: 'session-0000-test', tickets: ['tkt_abcdefghijklmnop'] },
      { v, op: 'end_session', session: 'session-0000-test' },
    ];
    for (const req of requests) {
      assert.deepEqual(parseRequest(encodeLine(req).trimEnd()), req, req.op);
      assert.equal(parseRequest(JSON.stringify({ ...req, session: 'a/b' })), null, req.op);
    }
    // An empty ticket list is valid; a mask request without `output` is not.
    const unmarked: Request = { v, op: 'mask', session: 'session-0000-test', tickets: [], output: 'x' };
    assert.deepEqual(parseRequest(JSON.stringify(unmarked)), unmarked);
    assert.equal(parseRequest(JSON.stringify({ v, op: 'mask', session: 'session-0000-test', tickets: ['tkt_abcdefghijklmnop'] })), null);
    assert.equal(parseRequest(JSON.stringify({ v, op: 'mask', session: 'session-0000-test', output: 'x' })), null);
    assert.equal(parseRequest(JSON.stringify({ v, op: 'mask', session: 'session-0000-test', tickets: [1], output: 'x' })), null);
    assert.equal(parseRequest(JSON.stringify({ v, op: 'release', session: 'session-0000-test', tickets: [1] })), null);
  });

  test('the new answers parse back for their op only', () => {
    const issued: Response = {
      ok: true,
      op: 'issue_tickets',
      tickets: ['tkt_abcdefghijklmnop'],
      expiresAt: '2026-10-29T12:10:00.000Z',
      field: { vault: 'Deploy', item: 'Deploy server', field: 'api token', type: 'Concealed', masked: true, short: false },
    };
    const answers: [Request['op'], Response][] = [
      ['issue_tickets', issued],
      ['redeem', { ok: true, op: 'redeem', value: 'synthetic-api-token-value' }],
      ['mask', { ok: true, op: 'mask', known: true, changed: true, output: ['<masked ticket=tkt_abcdefghijklmnop>'], missing: [] }],
      ['mask', { ok: true, op: 'mask', known: false, changed: false, output: null, missing: ['tkt_abcdefghijklmnop'] }],
      ['release', { ok: true, op: 'release', results: [{ ticket: 'tkt_abcdefghijklmnop', result: 'voided' }] }],
      ['release', { ok: true, op: 'release', results: [{ ticket: 'tkt_abcdefghijklmnop', result: 'in_flight' }] }],
      ['release', { ok: true, op: 'release', results: [{ ticket: 'tkt_abcdefghijklmnop', result: 'mask_kept' }] }],
      ['end_session', { ok: true, op: 'end_session' }],
    ];
    for (const [op, answer] of answers) {
      assert.deepEqual(parseResponse(encodeLine(answer).trimEnd(), op), answer, op);
      assert.equal(parseResponse(encodeLine(answer).trimEnd(), 'status'), null, op);
    }
    // Valid but for the ticket id.
    assert.equal(parseResponse(JSON.stringify({ ...issued, tickets: ['tkt_abcdefghijklmnop', 'nope'] }), 'issue_tickets'), null);
    assert.equal(parseResponse(JSON.stringify({ ok: true, op: 'release', results: [{ ticket: 't', result: 'gone' }] }), 'release'), null);
    assert.equal(parseResponse(JSON.stringify({ ok: true, op: 'mask', known: false, changed: false, output: null }), 'mask'), null);
    assert.equal(parseResponse(JSON.stringify({ ok: true, op: 'mask', known: false, changed: false, output: null, missing: [1] }), 'mask'), null);
  });

  test('the ticket failure codes exist', () => {
    for (const code of ['expired', 'busy', 'not_owner', 'other_agent', 'no_command', 'unknown', 'used', 'voided', 'field_gone']) {
      assert.ok((FAILURE_CODES as readonly string[]).includes(code), code);
    }
  });

  test('acknowledgements', () => {
    assert.equal(encodeAck('received'), `{"v":${v},"op":"received"}\n`);
    assert.equal(parseAck(encodeAck('delivered').trimEnd()), 'delivered');
    assert.equal(parseAck(encodeAck('not_delivered').trimEnd()), 'not_delivered');
    assert.equal(parseAck(JSON.stringify({ v: v - 1, op: 'delivered' })), null);
    assert.equal(parseAck(null), null);
  });
});

describe('lineReader', () => {
  test('reads successive lines, several from one chunk, then null at the end', async () => {
    const stream = new PassThrough();
    const lines = lineReader(stream);
    stream.write('{"a":1}\n{"b":2}\n{"c"');
    stream.end(':3}\n');
    assert.equal(await lines.next(), '{"a":1}');
    assert.equal(await lines.next(), '{"b":2}');
    assert.equal(await lines.next(), '{"c":3}');
    assert.equal(await lines.next(), null);
  });

  test('a line longer than the limit is a FrameError', async () => {
    const stream = new PassThrough();
    const lines = lineReader(stream, 8);
    stream.write('0123456789');
    await assert.rejects(lines.next(), FrameError);
  });

  test('a lowered limit holds for lines already received', async () => {
    const stream = new PassThrough();
    const lines = lineReader(stream, 64);
    stream.write('{"first":1}\n0123456789012345\n');
    assert.equal(await lines.next(), '{"first":1}');
    lines.limit(8);
    await assert.rejects(lines.next(), FrameError);
  });

  test('lowering the limit below a buffered partial line fails a pending read', async () => {
    const stream = new PassThrough();
    const lines = lineReader(stream, 64);
    const pending = lines.next();
    stream.write('0123456789012345');
    // Let the partial line reach the reader while next() waits for its newline.
    await new Promise((resolve) => setImmediate(resolve));
    lines.limit(8);
    await assert.rejects(pending, FrameError);
  });
});

describe('fields without variable names', () => {
  test('a field needs no name and a name is not kept', () => {
    const line = JSON.stringify({
      ok: true,
      op: 'fields',
      vault: 'Deploy',
      item: { title: 'Deploy server', category: 'Login' },
      fields: [
        { id: 'f', title: 'api token', type: 'Concealed', masked: true, name: 'LEGACY_VARIABLE' },
        { id: 'g', title: 'region', type: 'Text', masked: false },
      ],
    });
    const res = parseResponse(line, 'fields');
    assert.ok(res !== null && res.ok && res.op === 'fields');
    assert.deepEqual(res.fields, [
      { id: 'f', title: 'api token', type: 'Concealed', masked: true },
      { id: 'g', title: 'region', type: 'Text', masked: false },
    ]);
  });
});
