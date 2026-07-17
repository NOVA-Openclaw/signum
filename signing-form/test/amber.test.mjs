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
  decodeAmberResult,
  buildAmberConnectUrl,
  extractAmberPubkey,
  decodeAmberPubkeyResult,
  composeAmberAppName
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

test('buildAmberSignerUrl percent-encodes appName and keeps callbackUrl last', () => {
  const url = buildAmberSignerUrl(SAMPLE_EVENT, {
    callbackUrl: 'https://example.com/sign/index.html?event=',
    appName: 'Signum \u2014 "Real Coffee"'
  });
  // Spaces, em-dash, and quotes must all be percent-encoded.
  assert.ok(
    url.includes('&appName=Signum%20%E2%80%94%20%22Real%20Coffee%22'),
    'appName percent-encoded (spaces, em-dash, quotes)'
  );
  assert.ok(
    url.endsWith('&callbackUrl=https://example.com/sign/index.html?event='),
    'callbackUrl remains the last param and unencoded'
  );
  assert.ok(
    url.indexOf('&appName=') < url.indexOf('&callbackUrl='),
    'appName appears before callbackUrl'
  );
});

test('buildAmberSignerUrl appName works without callbackUrl (clipboard variant)', () => {
  const url = buildAmberSignerUrl(SAMPLE_EVENT, { appName: 'Signum' });
  assert.ok(url.endsWith('&appName=Signum'), 'appName appended');
  assert.ok(!url.includes('callbackUrl'), 'still no callbackUrl param');
});

test('buildAmberSignerUrl omits appName when not provided', () => {
  const url = buildAmberSignerUrl(SAMPLE_EVENT, {
    callbackUrl: 'https://example.com/?event='
  });
  assert.ok(!url.includes('appName'), 'no appName param');
});

test('buildAmberSignerUrl strips characters Amber would re-split on from appName', () => {
  // Amber URL-decodes the whole nostrsigner: string BEFORE splitting on
  // ? and &, so encoded %26/%3F would re-emerge and truncate the value.
  const url = buildAmberSignerUrl(SAMPLE_EVENT, {
    appName: 'Coffee & Tea? Now'
  });
  assert.ok(url.endsWith('&appName=Coffee%20Tea%20Now'), '& and ? collapsed to spaces');
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

// ── buildAmberConnectUrl ───────────────────────────────────────────────

test('buildAmberConnectUrl builds a get_public_key request with callbackUrl', () => {
  const url = buildAmberConnectUrl({
    callbackUrl: 'https://example.com/sign/index.html?pubkey='
  });
  assert.ok(url.startsWith('nostrsigner:?'), 'empty payload for get_public_key');
  assert.ok(url.includes('type=get_public_key'), 'has type=get_public_key');
  assert.ok(
    url.endsWith('&callbackUrl=https://example.com/sign/index.html?pubkey='),
    'callbackUrl is the last param and unencoded'
  );
});

test('buildAmberConnectUrl omits callbackUrl when not provided (clipboard variant)', () => {
  const url = buildAmberConnectUrl();
  assert.equal(url, 'nostrsigner:?type=get_public_key');
});

test('buildAmberConnectUrl percent-encodes appName and keeps callbackUrl last', () => {
  const url = buildAmberConnectUrl({
    callbackUrl: 'https://example.com/sign/index.html?pubkey=',
    appName: 'Signum \u2014 Office Coffee'
  });
  assert.equal(
    url,
    'nostrsigner:?type=get_public_key' +
      '&appName=Signum%20%E2%80%94%20Office%20Coffee' +
      '&callbackUrl=https://example.com/sign/index.html?pubkey='
  );
});

test('buildAmberConnectUrl omits appName when not provided', () => {
  const url = buildAmberConnectUrl({ callbackUrl: 'https://example.com/?pubkey=' });
  assert.ok(!url.includes('appName'), 'no appName param');
});

// ── composeAmberAppName ────────────────────────────────────────────────

test('composeAmberAppName falls back to "Signum" without a title', () => {
  assert.equal(composeAmberAppName(), 'Signum');
  assert.equal(composeAmberAppName(null), 'Signum');
  assert.equal(composeAmberAppName(''), 'Signum');
  assert.equal(composeAmberAppName('   '), 'Signum');
});

test('composeAmberAppName composes "Signum \u2014 <title>"', () => {
  assert.equal(
    composeAmberAppName('The Office Should Serve Real Coffee'),
    'Signum \u2014 The Office Should Serve Real Coffee'
  );
});

test('composeAmberAppName truncates long titles with an ellipsis', () => {
  const long = 'Petition for the Recognition of Entity Dignity Without Substrate Test';
  const name = composeAmberAppName(long);
  assert.ok(name.length <= 60, `stays within 60 chars (got ${name.length})`);
  assert.ok(name.startsWith('Signum \u2014 Petition for the Recognition'), 'keeps the prefix');
  assert.ok(name.endsWith('\u2026'), 'ends with an ellipsis');
  assert.ok(!/\s\u2026$/.test(name), 'no dangling whitespace before the ellipsis');
});

test('buildAmberConnectUrl rejects callbackUrl containing "&"', () => {
  assert.throws(
    () => buildAmberConnectUrl({ callbackUrl: 'https://example.com/?a=1&pubkey=' }),
    /must not contain "&"/
  );
});

// ── extractAmberPubkey ─────────────────────────────────────────────────

const HEX_PK = 'ab'.repeat(32);
const NPUB = 'npub1sn0wdenkukak0d9dfczzeacvhkrgz92ak56egt7vdgzn8pv2wfqqhrjdv9';

test('extractAmberPubkey returns null when no result is present', () => {
  assert.equal(extractAmberPubkey('https://example.com/index.html'), null);
  assert.equal(extractAmberPubkey('https://example.com/index.html?pubkey='), null);
  assert.equal(extractAmberPubkey(''), null);
  assert.equal(extractAmberPubkey(undefined), null);
});

test('extractAmberPubkey captures everything after pubkey=', () => {
  assert.equal(
    extractAmberPubkey('https://example.com/index.html?pubkey=' + NPUB),
    NPUB
  );
});

test('extractAmberPubkey survives raw JSON with &, =, and # after pubkey=', () => {
  const raw = '{"result":"' + HEX_PK + '","package":"a&b=c#d"}';
  const href = 'https://example.com/index.html?pubkey=' + raw;
  assert.equal(extractAmberPubkey(href), raw);
});

test('extractAmberPubkey keeps inner "&pubkey=" sequences intact', () => {
  const raw = '{"x":"y"}&pubkey={"k":1}';
  const href = 'https://example.com/?pubkey=' + raw;
  assert.equal(extractAmberPubkey(href), raw);
});

test('extractAmberPubkey does not match a sign return (?event=...)', () => {
  const href = 'https://example.com/?event={"pubkey":"' + HEX_PK + '"}';
  assert.equal(extractAmberPubkey(href), null);
});

// ── decodeAmberPubkeyResult ───────────────────────────────────────────

test('decodeAmberPubkeyResult passes through a hex pubkey (lowercased)', () => {
  assert.deepEqual(decodeAmberPubkeyResult(HEX_PK), { type: 'hex', value: HEX_PK });
  assert.deepEqual(
    decodeAmberPubkeyResult(HEX_PK.toUpperCase()),
    { type: 'hex', value: HEX_PK }
  );
});

test('decodeAmberPubkeyResult passes through an npub for caller-side decoding', () => {
  assert.deepEqual(decodeAmberPubkeyResult(NPUB), { type: 'npub', value: NPUB });
});

test('decodeAmberPubkeyResult handles percent-encoded results', () => {
  const wrapped = encodeURIComponent(JSON.stringify({ result: NPUB }));
  assert.deepEqual(decodeAmberPubkeyResult(wrapped), { type: 'npub', value: NPUB });
});

test('decodeAmberPubkeyResult unwraps JSON result/pubkey/event shapes', () => {
  assert.deepEqual(
    decodeAmberPubkeyResult(JSON.stringify({ result: HEX_PK })),
    { type: 'hex', value: HEX_PK }
  );
  assert.deepEqual(
    decodeAmberPubkeyResult(JSON.stringify({ pubkey: NPUB })),
    { type: 'npub', value: NPUB }
  );
  assert.deepEqual(
    decodeAmberPubkeyResult(JSON.stringify({ event: { pubkey: HEX_PK } })),
    { type: 'hex', value: HEX_PK }
  );
});

test('decodeAmberPubkeyResult trims surrounding whitespace', () => {
  assert.deepEqual(decodeAmberPubkeyResult('  ' + NPUB + '\n'), { type: 'npub', value: NPUB });
});

test('decodeAmberPubkeyResult rejects garbage input', () => {
  assert.throws(() => decodeAmberPubkeyResult(''), /empty/);
  assert.throws(() => decodeAmberPubkeyResult('not a key'), /not a public key/);
  assert.throws(() => decodeAmberPubkeyResult('abcd1234'), /not a public key/);
  assert.throws(() => decodeAmberPubkeyResult('npub1UPPERCASE'), /not a public key/);
  assert.throws(() => decodeAmberPubkeyResult('{broken json'), /not valid JSON/);
  assert.throws(() => decodeAmberPubkeyResult('{"package":"x"}'), /no pubkey/);
  assert.throws(() => decodeAmberPubkeyResult('{"result":42}'), /no pubkey/);
});

// ── decodeAmberResult ─────────────────────────────────────────────────

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
