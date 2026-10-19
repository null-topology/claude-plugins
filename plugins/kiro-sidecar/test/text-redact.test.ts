import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { InvalidInputError } from '../src/text/errors.ts';
import {
  MESSAGING_TOKEN_VARIABLE,
  PROXY_SETTING_VARIABLES,
  REDACTED,
  SECRET_PROXY_VARIABLES,
  SecretSet,
  assertKiroToken,
  buildSecretSet,
  secretForms,
} from '../src/text/redact.ts';
import { isHighSurrogate } from '../src/text/unicode.ts';

const TOKEN = 'ksk_live_0123456789abcdefXYZ';
const SPECIAL = 'tok/with"quote\\and@sign:colon&amp=1';

/** Deterministic pseudo-random numbers in [0, 1). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Reference redaction, independent of the implementation: mark every
 * character covered by any occurrence of any pattern, then replace each
 * maximal run of marked characters at or after `visibleFrom` with one
 * marker and drop everything before `visibleFrom`.
 */
function reference(text: string, patterns: readonly string[], visibleFrom = 0): string {
  const covered = new Array<boolean>(text.length).fill(false);
  for (const pattern of patterns) {
    for (let at = 0; at + pattern.length <= text.length; at += 1) {
      if (text.startsWith(pattern, at)) {
        for (let k = 0; k < pattern.length; k += 1) {
          covered[at + k] = true;
        }
      }
    }
  }
  let output = '';
  let inRun = false;
  for (let i = visibleFrom; i < text.length; i += 1) {
    if (covered[i] === true) {
      if (!inRun) {
        output += REDACTED;
      }
      inRun = true;
    } else {
      output += text[i];
      inRun = false;
    }
  }
  return output;
}

/** `encoded` with the hex letters of every percent escape in lower case. */
function lowerCaseEscapes(encoded: string): string {
  return encoded.replace(/%[0-9A-Fa-f]{2}/g, (escape) => escape.toLowerCase());
}

/** `encoded` with every other percent escape that holds a hex letter in lower case. */
function mixedCaseEscapes(encoded: string): string {
  let lettered = 0;
  return encoded.replace(/%[0-9A-Fa-f]{2}/g, (escape) =>
    /[A-Fa-f]/.test(escape) && lettered++ % 2 === 0 ? escape.toLowerCase() : escape,
  );
}

function streamAll(secrets: SecretSet, chunks: readonly string[]): string {
  const redactor = secrets.stream();
  return chunks.map((chunk) => redactor.push(chunk)).join('') + redactor.end();
}

function randomChunks(text: string, next: () => number, maxChunk: number): string[] {
  const chunks: string[] = [];
  let at = 0;
  while (at < text.length) {
    const size = 1 + Math.floor(next() * maxChunk);
    chunks.push(text.slice(at, at + size));
    at += size;
  }
  return chunks;
}

describe('secret set', () => {
  test('each secret is redacted raw, JSON-escaped and URL-encoded', () => {
    assert.deepEqual(secretForms(SPECIAL), [
      SPECIAL,
      'tok/with\\"quote\\\\and@sign:colon&amp=1',
      'tok%2Fwith%22quote%5Cand%40sign%3Acolon%26amp%3D1',
    ]);
    assert.deepEqual(secretForms(TOKEN), [TOKEN]);
    assert.deepEqual(secretForms(''), []);
  });

  test('it holds api_key, token files, the messaging token and the four proxy URLs', () => {
    const env = {
      [MESSAGING_TOKEN_VARIABLE]: 'messaging-token-value-1',
      HTTP_PROXY: 'http://user:pass1@proxy.example:3128',
      HTTPS_PROXY: 'http://user:pass2@proxy.example:3129',
      http_proxy: 'http://user:pass3@proxy.example:3130',
      https_proxy: 'http://user:pass4@proxy.example:3131',
      NO_PROXY: 'localhost-no-proxy-upper',
      no_proxy: 'localhost-no-proxy-lower',
      PATH: '/usr/bin',
    };
    const secrets = buildSecretSet({
      apiKey: TOKEN,
      tokenFileValues: ['file-token-0123456789', 'file-token-abcdefghij'],
      env,
    });
    const values = [
      TOKEN,
      'file-token-0123456789',
      'file-token-abcdefghij',
      env[MESSAGING_TOKEN_VARIABLE],
      env.HTTP_PROXY,
      env.HTTPS_PROXY,
      env.http_proxy,
      env.https_proxy,
    ];
    for (const value of values) {
      assert.equal(secrets.redact(`a ${value} b`), `a ${REDACTED} b`, value);
    }
    assert.equal(secrets.redact(env.NO_PROXY), env.NO_PROXY);
    assert.equal(secrets.redact(env.no_proxy), env.no_proxy);
    assert.equal(secrets.redact('/usr/bin'), '/usr/bin');
    assert.deepEqual([...SECRET_PROXY_VARIABLES], ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']);
  });

  test('the proxy setting is a secret in both of its variables', () => {
    const env = {
      KIRO_SIDECAR_PROXY: 'http://user:pass5@proxy.example:3132',
      CLAUDE_PLUGIN_OPTION_PROXY: 'http://user:pass6@proxy.example:3133',
      KIRO_SIDECAR_NO_PROXY: 'localhost-no-proxy-setting',
    };
    const secrets = buildSecretSet({ apiKey: TOKEN, env });
    assert.equal(secrets.redact(`a ${env.KIRO_SIDECAR_PROXY} b`), `a ${REDACTED} b`);
    assert.equal(secrets.redact(`a ${env.CLAUDE_PLUGIN_OPTION_PROXY} b`), `a ${REDACTED} b`);
    assert.equal(secrets.redact(env.KIRO_SIDECAR_NO_PROXY), env.KIRO_SIDECAR_NO_PROXY);
    assert.deepEqual([...PROXY_SETTING_VARIABLES], ['KIRO_SIDECAR_PROXY', 'CLAUDE_PLUGIN_OPTION_PROXY']);
  });

  test('an empty api_key and empty variables are not secrets', () => {
    const secrets = buildSecretSet({
      apiKey: '',
      env: { [MESSAGING_TOKEN_VARIABLE]: '', HTTP_PROXY: '' },
    });
    assert.equal(secrets.size, 0);
    assert.equal(secrets.windowChars, 0);
    assert.equal(secrets.redact('nothing to hide'), 'nothing to hide');
    assert.equal(streamAll(secrets, ['nothing ', 'to ', 'hide']), 'nothing to hide');
  });

  test('the environment defaults to the process environment', () => {
    const name = 'HTTPS_PROXY';
    const saved = process.env[name];
    process.env[name] = 'http://process-user:process-pass@proxy.example:1';
    try {
      const secrets = buildSecretSet({});
      assert.equal(secrets.redact(`x ${process.env[name]} y`), `x ${REDACTED} y`);
    } finally {
      if (saved === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved;
      }
    }
  });

  for (const [name, field, sources] of [
    ['a 15-character api_key', 'api_key', { apiKey: 'short-token-15c' }],
    ['a 15-character token file value', 'token_file', { tokenFileValues: ['short-token-15c'] }],
    ['an empty token file value', 'token_file', { tokenFileValues: [''] }],
  ] as const) {
    test(`${name} is refused as E_INVALID without echoing the token`, () => {
      let caught: unknown;
      try {
        buildSecretSet({ ...sources, env: {} });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof InvalidInputError, String(caught));
      assert.equal(caught.code, 'E_INVALID');
      assert.equal(caught.field, field);
      const surfaces = [caught.message, String(caught.stack), inspect(caught), JSON.stringify(caught)];
      for (const surface of surfaces) {
        assert.ok(!surface.includes('short-token-15c'), surface);
      }
    });
  }

  test('a 16-character token is accepted', () => {
    const token = 'exactly-16-chars';
    assert.equal(token.length, 16);
    assert.doesNotThrow(() => assertKiroToken(token, 'api_key'));
    assert.equal(buildSecretSet({ apiKey: token, env: {} }).redact(token), REDACTED);
  });

  test('a Kiro key value is a secret whatever its length, next to the server secrets', () => {
    const env = { CLAUDE_CODE_MESSAGING_TOKEN: 'messaging-secret', HTTPS_PROXY: 'http://user:pw@proxy:3128' };
    let secrets: ReturnType<typeof buildSecretSet> | undefined;
    assert.doesNotThrow(() => {
      secrets = buildSecretSet({ apiKey: TOKEN, env, kiroKeys: ['short_key_12', ''] });
    });
    assert.equal(
      secrets?.redact(`a short_key_12 b ${TOKEN} c messaging-secret d http://user:pw@proxy:3128 e`),
      `a ${REDACTED} b ${REDACTED} c ${REDACTED} d ${REDACTED} e`,
    );
    assert.equal(buildSecretSet({ env: {}, kiroKeys: ['k'] }).redact('a k b'), `a ${REDACTED} b`);
  });

  test('inspecting or serializing the set does not show a secret', () => {
    const secrets = new SecretSet([TOKEN]);
    assert.ok(!inspect(secrets, { depth: null, showHidden: true }).includes(TOKEN));
    assert.ok(!JSON.stringify(secrets).includes(TOKEN));
    assert.ok(!JSON.stringify({ secrets }).includes(TOKEN));
  });
});

describe('redact', () => {
  const secrets = new SecretSet([TOKEN, SPECIAL]);

  test('every occurrence is replaced, inside a larger string too', () => {
    assert.equal(
      secrets.redact(`KIRO_API_KEY=${TOKEN} and again ${TOKEN}.`),
      `KIRO_API_KEY=${REDACTED} and again ${REDACTED}.`,
    );
  });

  test('the JSON-escaped form is replaced', () => {
    const json = JSON.stringify({ env: { TOKEN: SPECIAL }, note: 'x' });
    const redacted = secrets.redact(json);
    assert.equal(redacted, `{"env":{"TOKEN":"${REDACTED}"},"note":"x"}`);
    assert.deepEqual(JSON.parse(redacted), { env: { TOKEN: REDACTED }, note: 'x' });
  });

  test('the URL-encoded form is replaced', () => {
    const url = `https://example.test/cb?token=${encodeURIComponent(SPECIAL)}&next=1`;
    assert.equal(secrets.redact(url), `https://example.test/cb?token=${REDACTED}&next=1`);
  });

  test('the URL-encoded form with lower-case or mixed-case percent escapes is replaced', () => {
    const encoded = encodeURIComponent(SPECIAL);
    for (const variant of [lowerCaseEscapes(encoded), mixedCaseEscapes(encoded)]) {
      assert.notEqual(variant, encoded);
      assert.equal(secrets.redact(`token=${variant}&next=1`), `token=${REDACTED}&next=1`, variant);
    }
  });

  test('outside percent escapes the case still has to match', () => {
    const shouted = encodeURIComponent(SPECIAL).replace('tok', 'TOK');
    assert.equal(secrets.redact(shouted), shouted);
    assert.equal(secrets.redact(SPECIAL.toUpperCase()), SPECIAL.toUpperCase());
  });

  test('a percent escape inside a raw secret matches in either case', () => {
    const proxy = 'http://user:p%2Fss%3a@proxy.test:3128';
    const set = new SecretSet([proxy]);
    assert.equal(set.redact(`via http://user:p%2fss%3A@proxy.test:3128 now`), `via ${REDACTED} now`);
    assert.equal(set.redact(`via ${proxy} now`), `via ${REDACTED} now`);
  });

  test('text without a secret is unchanged', () => {
    assert.equal(secrets.redact('plain text\r\nwith lines'), 'plain text\r\nwith lines');
    assert.equal(secrets.redact(''), '');
  });

  test('when one secret contains another, the longer one is replaced whole', () => {
    const outer = 'outer-prefix-INNER-SECRET-123-outer-suffix';
    const inner = 'INNER-SECRET-123';
    const nested = new SecretSet([inner, outer]);
    assert.equal(nested.redact(`<${outer}>`), `<${REDACTED}>`);
    assert.equal(nested.redact(`<${inner}>`), `<${REDACTED}>`);
    assert.equal(new SecretSet([outer, inner]).redact(`<${outer}>`), `<${REDACTED}>`);
  });

  test('partly overlapping or touching secrets become one run', () => {
    const left = 'AAAA-left-secret-BBBB';
    const right = 'BBBB-right-secret-CCCC';
    const pair = new SecretSet([left, right]);
    assert.equal(pair.redact(`x AAAA-left-secret-BBBB-right-secret-CCCC y`), `x ${REDACTED} y`);
    assert.equal(pair.redact(`x ${left}${right} y`), `x ${REDACTED} y`);
    assert.equal(pair.redact(`x ${left} ${right} y`), `x ${REDACTED} ${REDACTED} y`);
  });
});

describe('stream redaction', () => {
  const secrets = new SecretSet([TOKEN, SPECIAL]);
  const forms = [
    ['raw', TOKEN],
    ['raw with specials', SPECIAL],
    ['JSON-escaped', JSON.stringify(SPECIAL).slice(1, -1)],
    ['URL-encoded', encodeURIComponent(SPECIAL)],
    ['URL-encoded with lower-case escapes', lowerCaseEscapes(encodeURIComponent(SPECIAL))],
    ['URL-encoded with mixed-case escapes', mixedCaseEscapes(encodeURIComponent(SPECIAL))],
  ] as const;

  for (const [name, form] of forms) {
    test(`a ${name} secret split at every position across two chunks is redacted`, () => {
      const text = `before ${form} after`;
      const expected = `before ${REDACTED} after`;
      for (let split = 0; split <= text.length; split += 1) {
        const output = streamAll(secrets, [text.slice(0, split), text.slice(split)]);
        assert.equal(output, expected, `split at ${split}`);
      }
    });
  }

  test('a secret split into single characters is redacted', () => {
    const text = `a ${TOKEN} b ${encodeURIComponent(SPECIAL)} c`;
    assert.equal(streamAll(secrets, [...text]), `a ${REDACTED} b ${REDACTED} c`);
  });

  test('held-back text is emitted only at the end of the stream', () => {
    const redactor = secrets.stream();
    const head = TOKEN.slice(0, 10);
    const emitted = redactor.push(`text then ${head}`);
    assert.ok(!emitted.includes(head), emitted);
    assert.equal(emitted + redactor.end(), `text then ${head}`);
    assert.equal(redactor.end(), '');
  });

  test('the window is the longest redacted form minus one', () => {
    const longest = Math.max(...secretForms(TOKEN).map((form) => form.length), ...secretForms(SPECIAL).map((form) => form.length));
    assert.equal(secrets.windowChars, longest - 1);
  });

  test('any chunking gives the same output as redacting the whole text', () => {
    const next = random(7);
    const pool = [
      'abcdefghijklmnop',
      'mnopqrstuvwxyz01',
      'abcdefghijklmnopqrstuvwxyz01',
      'zzzzzzzzzzzzzzzzzz',
      'z/z"z\\z@z:z&z=z~z',
    ];
    const set = new SecretSet(pool);
    // The redacted forms, plus the URL-encoded form with mixed-case escapes.
    const variants = (secret: string) => [...secretForms(secret), mixedCaseEscapes(encodeURIComponent(secret))];
    const patterns = pool.flatMap(variants);
    const alphabet = 'abcmnoz01 \n/"\\@:';
    for (let round = 0; round < 400; round += 1) {
      let text = '';
      while (text.length < 120) {
        if (next() < 0.3) {
          const secret = pool[Math.floor(next() * pool.length)] ?? '';
          const options = variants(secret);
          const variant = options[Math.floor(next() * options.length)] ?? secret;
          const from = next() < 0.3 ? Math.floor(next() * variant.length) : 0;
          text += variant.slice(from);
        } else {
          text += alphabet[Math.floor(next() * alphabet.length)];
        }
      }
      const expected = reference(text, patterns);
      assert.equal(set.redact(text), expected, `whole text, round ${round}`);
      const chunks = randomChunks(text, next, 1 + Math.floor(next() * 40));
      assert.equal(streamAll(set, chunks), expected, `round ${round}: ${JSON.stringify(chunks)}`);
    }
  });

  test('restart drops earlier text but still redacts a secret that straddles it', () => {
    const next = random(11);
    const pool = ['abcdefghijklmnop', 'ponmlkjihgfedcba', 'aaaaaaaaaaaaaaaa'];
    const set = new SecretSet(pool);
    for (let round = 0; round < 400; round += 1) {
      let text = '';
      while (text.length < 80) {
        text += next() < 0.4 ? (pool[Math.floor(next() * pool.length)] ?? '') : 'abop '[Math.floor(next() * 5)];
      }
      const boundary = Math.floor(next() * text.length);
      const redactor = set.stream();
      for (const chunk of randomChunks(text.slice(0, boundary), next, 20)) {
        redactor.push(chunk);
      }
      redactor.restart();
      let output = '';
      for (const chunk of randomChunks(text.slice(boundary), next, 20)) {
        output += redactor.push(chunk);
      }
      output += redactor.end();
      assert.equal(output, reference(text, pool, boundary), `round ${round}, boundary ${boundary}`);
    }
  });

  test('a stream never emits half of a surrogate pair', () => {
    const set = new SecretSet([TOKEN]);
    const text = `start \u{1F600}\u{1F680} ${TOKEN} \u{1F600} end \u{1F680}`;
    for (let split = 0; split <= text.length; split += 1) {
      const redactor = set.stream();
      const pieces = [redactor.push(text.slice(0, split)), redactor.push(text.slice(split)), redactor.end()];
      for (const piece of pieces.slice(0, 2)) {
        assert.ok(piece === '' || !isHighSurrogate(piece.charCodeAt(piece.length - 1)), `split at ${split}`);
      }
      assert.equal(pieces.join(''), set.redact(text));
    }
    const plain = new SecretSet([]).stream();
    assert.equal(plain.push('a\uD83D'), 'a');
    assert.equal(plain.push('\uDE00b'), '\u{1F600}b');
  });
});

/**
 * Reference for inserted text, independent of the implementation: redact
 * `text` as `reference` does and put each insert before character `at`,
 * except where characters `at - 1` and `at` are both covered.
 */
function referenceWithInserts(
  text: string,
  patterns: readonly string[],
  inserts: ReadonlyArray<{ at: number; text: string }>,
): { output: string; insertedChars: number } {
  const covered = new Array<boolean>(text.length).fill(false);
  for (const pattern of patterns) {
    for (let at = 0; at + pattern.length <= text.length; at += 1) {
      if (text.startsWith(pattern, at)) {
        covered.fill(true, at, at + pattern.length);
      }
    }
  }
  let output = '';
  let insertedChars = 0;
  for (let i = 0; i <= text.length; i += 1) {
    const inside = i > 0 && i < text.length && covered[i - 1] === true && covered[i] === true;
    for (const insert of inserts) {
      if (insert.at === i && !inside) {
        output += insert.text;
        insertedChars += insert.text.length;
      }
    }
    if (i === text.length) {
      break;
    }
    if (covered[i] === true) {
      if (!(i > 0 && covered[i - 1] === true)) {
        output += REDACTED;
      }
    } else {
      output += text[i];
    }
  }
  return { output, insertedChars };
}

describe('stream redaction with inserted text', () => {
  const secrets = new SecretSet([TOKEN]);

  test('text inserted inside a secret is dropped and the secret is redacted whole', () => {
    for (let split = 1; split < TOKEN.length; split += 1) {
      const redactor = secrets.stream();
      let output = redactor.push(`before ${TOKEN.slice(0, split)}`);
      redactor.insert('\n');
      output += redactor.push(`${TOKEN.slice(split)} after`) + redactor.end();
      assert.equal(output, `before ${REDACTED} after`, `split at ${split}`);
      assert.equal(redactor.insertedChars, 0, `split at ${split}`);
    }
  });

  test('text inserted next to a secret or in plain text is kept', () => {
    const cases: Array<[string, string, string]> = [
      [`a ${TOKEN}`, ' b', `a ${REDACTED}\n b`],
      ['a ', `${TOKEN} b`, `a \n${REDACTED} b`],
      ['plain', 'text', 'plain\ntext'],
      ['', 'only after', '\nonly after'],
      ['only before', '', 'only before\n'],
    ];
    for (const [before, after, expected] of cases) {
      const redactor = secrets.stream();
      const output = redactor.push(before) + (redactor.insert('\n'), redactor.push(after)) + redactor.end();
      assert.equal(output, expected, JSON.stringify([before, after]));
      assert.equal(redactor.insertedChars, 1, JSON.stringify([before, after]));
    }
  });

  test('inserted text dropped by restart never reaches the output', () => {
    const redactor = secrets.stream();
    redactor.push(`old ${TOKEN.slice(0, 5)}`);
    redactor.insert('\n');
    redactor.restart();
    const output = redactor.push(`${TOKEN.slice(5)} new`) + redactor.end();
    assert.equal(output, `${REDACTED} new`);
    assert.equal(redactor.insertedChars, 0);
  });

  test('any chunking and inserts give the reference output', () => {
    const next = random(23);
    const pool = ['abcdefghijklmnop', 'mnopqrstuvwxyz01', 'zzzzzzzzzzzzzzzzzz', 'z/z"z\\z@z:z&z=z~z'];
    const set = new SecretSet(pool);
    const variants = (secret: string) => [...secretForms(secret), mixedCaseEscapes(encodeURIComponent(secret))];
    const patterns = pool.flatMap(variants);
    const alphabet = 'abcmnoz01 \n/"\\@:';
    const pieces = ['\n', '<>', 'X'];
    for (let round = 0; round < 400; round += 1) {
      let text = '';
      while (text.length < 120) {
        if (next() < 0.3) {
          const secret = pool[Math.floor(next() * pool.length)] ?? '';
          const options = variants(secret);
          const variant = options[Math.floor(next() * options.length)] ?? secret;
          text += variant.slice(next() < 0.3 ? Math.floor(next() * variant.length) : 0);
        } else {
          text += alphabet[Math.floor(next() * alphabet.length)];
        }
      }
      const chunks = randomChunks(text, next, 1 + Math.floor(next() * 40));
      const inserts: Array<{ at: number; text: string }> = [];
      const redactor = set.stream();
      let output = '';
      let at = 0;
      for (let index = 0; index <= chunks.length; index += 1) {
        while (next() < 0.4) {
          const piece = pieces[Math.floor(next() * pieces.length)] ?? '\n';
          redactor.insert(piece);
          inserts.push({ at, text: piece });
        }
        const chunk = chunks[index];
        if (chunk !== undefined) {
          output += redactor.push(chunk);
          at += chunk.length;
        }
      }
      output += redactor.end();
      const expected = referenceWithInserts(text, patterns, inserts);
      const context = `round ${round}: ${JSON.stringify(chunks)} ${JSON.stringify(inserts)}`;
      assert.equal(output, expected.output, context);
      assert.equal(redactor.insertedChars, expected.insertedChars, context);
    }
  });
});
