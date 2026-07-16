// Unit tests for the NIP-55 (Amber) web-flow helpers in signing-form/amber.js.
//
// Run with:  node --test signing-form/test/
//
// These are pure-function tests (URL building, result extraction, result
// decoding including the gzip "Signer1" variant). The full round-trip
// against a real signer requires an Android device with Amber installed —
// see the manual test plan in the PR / docs/signing-with-amber.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAndroid,
  isIOS,
  buildAmberSignerUrl,
  extractAmberResult,
  decodeAmberResult
} from '../amber.js';

const SAMPLE_EVENT = {
  kind: 1791,
  created_at: 1752700000,
  tags: [
    ['a', '30023:877d7acaa4c0c0c517f511c7e72275de726ceb34aee99988ee2f2ed67040c8ac:office-coffee-2026'],
    ['content_hash', 'ab'.repeat(32)],
    ['entity_type', 'human'],
    ['client', 'signum-web', 'https://github.com/NOVA-Openclaw/signum']
  ],
  content: 'I support this & sign it = wholeheartedly #coffee'
};

// ── platform detection ────────────────────────────────────────────────────

test('isAndroid matches Android user agents only', () => {
  assert.equal(isAndroid('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126'), true);
  assert.equal(isAndroid('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), false);
  assert.equal(isAndroid('Mozilla/5.0 (X11; Linux x86_64) Firefox/128'), false);
  assert.equal(isAndroid(undefined), false);
});

test('isIOS matches iPhone/iPad/iPod user agents only', () => {
  assert.equal(isIOS('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), true);
  assert.equal(isIOS('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), true);
  assert.equal(isIOS('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126'), false);
  assert.equal(isIOS(undefined), false);
});

// ── buildAmberSignerUrl ───────────────────────────────────────────────────

test('buildAmberSignerUrl produces a well-formed nostrsigner: URL', () => {
  const url = buildAmberSignerUrl(SAMPLE_EVENT, {
    callbackUrl: 'https://example.com/sign/index.html?event='
  });

  assert.ok(url.startsWith('nostrsigner:'), 'starts with nostrsigner:');

  // Payload (the URI "path") round-trips back to the exact event.
  const payload = url.slice('nostrsigner:'.length, url.indexOf('?'));
  assert.deepEqual(JSON.parse(decodeURIComponent(payload)), SAMPLE_EVENT);

  // Query params per the NIP-55 web-flow example, callbackUrl appended raw.
  const query = url.slice(url.indexOf('?') + 1);
  assert.ok(query.includes('type=sign_event'), 'has type=sign_event');
  assert.ok(query.includes('returnType=event'), 'defaults to returnType=event');
  assert.ok(query.includes('compressionType=none'), 'defaults to compressionType=none');
  assert.ok(
    url.endsWith('&callbackUrl=https://example.com/sign/index.html?event='),
    'callbackUrl is the last param and unencoded'
  );
});

test('buildAmberSignerUrl omits callbackUrl when not provided (clipboard variant)', () => {
  const url = buildAmberSignerUrl(SAMPLE_EVENT);
  assert.ok(!url.includes('callbackUrl'), 'no callbackUrl param');
});

test('buildAmberSignerUrl supports returnType/compressionType overrides', () => {
  const url = buildAmberSignerUrl(SAMPLE_EVENT, {
    returnType: 'signature',
    compressionType: 'gzip'
  });
  assert.ok(url.includes('returnType=signature'));
  assert.ok(url.includes('compressionType=gzip'));
});

test('buildAmberSignerUrl rejects callbackUrl containing "&"', () => {
  assert.throws(
    () => buildAmberSignerUrl(SAMPLE_EVENT, {
      callbackUrl: 'https://example.com/?a=1&event='
    }),
    /must not contain "&"/
  );
});

test('buildAmberSignerUrl rejects a missing event', () => {
  assert.throws(() => buildAmberSignerUrl(null), /event object/);
});

test('buildAmberSignerUrl percent-encodes payload characters that break URIs', () => {
  const url = buildAmberSignerUrl(SAMPLE_EVENT, {
    callbackUrl: 'https://example.com/?event='
  });
  const payload = url.slice('nostrsigner:'.length, url.indexOf('?'));
  // The event content contains &, =, and # — none may appear raw in the payload.
  assert.ok(!payload.includes('&'), 'no raw & in payload');
  assert.ok(!payload.includes('#'), 'no raw # in payload');
  assert.ok(!payload.includes('='), 'no raw = in payload');
});

// ── extractAmberResult ────────────────────────────────────────────────────

test('extractAmberResult returns null when no result is present', () => {
  assert.equal(extractAmberResult('https://example.com/index.html'), null);
  assert.equal(extractAmberResult('https://example.com/index.html?event='), null);
  assert.equal(extractAmberResult(''), null);
  assert.equal(extractAmberResult(undefined), null);
});

test('extractAmberResult captures everything after event=', () => {
  const signed = JSON.stringify({ ...SAMPLE_EVENT, id: 'aa', sig: 'bb' });
  const href = 'https://example.com/index.html?event=' + encodeURIComponent(signed);
  assert.equal(extractAmberResult(href), encodeURIComponent(signed));
});

test('extractAmberResult survives raw JSON with &, =, and # after event=', () => {
  // A signer that appends the result unencoded: the JSON content contains
  // characters that would break URLSearchParams-based parsing.
  const signed = '{"content":"a&b=c#d","kind":1791}';
  const href = 'https://example.com/index.html?event=' + signed;
  assert.equal(extractAmberResult(href), signed);
});

test('extractAmberResult keeps inner "&event=" sequences intact', () => {
  const raw = '{"content":"x?event=y"}&event={"k":1}';
  const href = 'https://example.com/?event=' + raw;
  // Split/join round-trip must not lose the inner separator.
  assert.equal(extractAmberResult(href), raw.replace('?event=', '&event='));
});

// ── decodeAmberResult ─────────────────────────────────────────────────────

async function gzipSigner1(text) {
  const stream = new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return 'Signer1' + btoa(bin);
}

test('decodeAmberResult parses plain JSON (paste / clipboard variant)', async () => {
  const signed = { ...SAMPLE_EVENT, id: 'aa', sig: 'bb', pubkey: 'cc' };
  assert.deepEqual(await decodeAmberResult(JSON.stringify(signed)), signed);
});

test('decodeAmberResult parses percent-encoded JSON (callback variant)', async () => {
  const signed = { ...SAMPLE_EVENT, id: 'aa', sig: 'bb', pubkey: 'cc' };
  assert.deepEqual(
    await decodeAmberResult(encodeURIComponent(JSON.stringify(signed))),
    signed
  );
});

test('decodeAmberResult unwraps { event: {...} } shapes', async () => {
  const signed = { ...SAMPLE_EVENT, id: 'aa', sig: 'bb', pubkey: 'cc' };
  assert.deepEqual(
    await decodeAmberResult(JSON.stringify({ event: signed })),
    signed
  );
});

test('decodeAmberResult inflates the gzip "Signer1" variant', async () => {
  const signed = { ...SAMPLE_EVENT, id: 'aa', sig: 'bb', pubkey: 'cc' };
  const raw = await gzipSigner1(JSON.stringify(signed));
  assert.deepEqual(await decodeAmberResult(raw), signed);
});

test('decodeAmberResult repairs base64 "+" mangled to spaces in URL transit', async () => {
  // Find a payload whose gzip base64 actually contains '+' so the repair
  // path is exercised, then simulate the '+' → ' ' mangling.
  let raw = null;
  for (let i = 0; i < 500; i++) {
    const candidate = { ...SAMPLE_EVENT, id: 'aa', sig: 'bb', pubkey: 'cc', content: 'pad-' + i };
    const encoded = await gzipSigner1(JSON.stringify(candidate));
    if (encoded.includes('+')) {
      raw = { encoded, candidate };
      break;
    }
  }
  assert.ok(raw, 'found a gzip payload containing "+"');
  const mangled = raw.encoded.replace(/\+/g, ' ');
  assert.deepEqual(await decodeAmberResult(mangled), raw.candidate);
});

test('decodeAmberResult rejects garbage input', async () => {
  await assert.rejects(() => decodeAmberResult(''), /empty/);
  await assert.rejects(() => decodeAmberResult('not json at all'), /not valid JSON/);
  await assert.rejects(() => decodeAmberResult('Signer1!!!notbase64!!!'), /base64/);
  await assert.rejects(() => decodeAmberResult('"just a string"'), /not an event object/);
});
