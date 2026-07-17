// amber.js — NIP-55 (Android signer / Amber) web-flow helpers for the
// Signum signing form.
//
// Pure functions only: no DOM or window access, so everything here can be
// unit-tested in Node (see test/amber.test.mjs) and reused by other pages.
//
// NIP-55 web flow (https://github.com/nostr-protocol/nips/blob/master/55.md):
// the client navigates to a `nostrsigner:` URL whose path is the payload
// (the unsigned event JSON) and whose query string carries the params. The
// signer app returns the result by appending it to `callbackUrl`, or — when
// no callbackUrl is given — by copying it to the clipboard.

/** Android detection from a user-agent string. */
export function isAndroid(ua) {
  return /android/i.test(String(ua || ''));
}

/** iOS detection from a user-agent string. */
export function isIOS(ua) {
  return /iphone|ipad|ipod/i.test(String(ua || ''));
}

// Maximum length for the requester name rendered in the signer's approval
// dialog — long petition titles get truncated with an ellipsis.
const APP_NAME_MAX_CHARS = 60;

/**
 * Compose the requester name shown in the signer's approval dialog
 * (Amber resolves it from the `appName` query param): "Signum — <petition
 * title>" when a petition title is available, plain "Signum" otherwise.
 * Truncated to a dialog-friendly length with an ellipsis.
 *
 * @param {string|null} [petitionTitle]
 * @returns {string}
 */
export function composeAmberAppName(petitionTitle) {
  const title = String(petitionTitle ?? '').trim();
  if (!title) return 'Signum';
  const name = `Signum \u2014 ${title}`;
  if (name.length <= APP_NAME_MAX_CHARS) return name;
  return name.slice(0, APP_NAME_MAX_CHARS - 1).trimEnd() + '\u2026';
}

/**
 * Percent-encode an appName value for a nostrsigner: URL.
 *
 * Amber URL-decodes the ENTIRE nostrsigner: string before splitting it on
 * `?` and `&` (IntentUtils.decodeData → decoded.split("?") /
 * flatMap(split("&"))), so even a percent-encoded `&` or `?` would
 * re-emerge after decoding and truncate the value. Those characters are
 * collapsed to spaces; everything else (`=`, quotes, unicode) survives the
 * decode-then-split round-trip — Amber rejoins everything after the first
 * `=` when parsing a parameter.
 */
function encodeAmberAppName(appName) {
  const cleaned = String(appName).replace(/[&?]/g, ' ').replace(/\s+/g, ' ').trim();
  return encodeURIComponent(cleaned);
}

/**
 * Build the `nostrsigner:` URL that asks a NIP-55 signer to sign an event.
 *
 * Per the NIP-55 web-flow example the callbackUrl is appended to the query
 * string as-is (unencoded), so it MUST NOT contain `&` — the signer would
 * truncate it at the first ampersand when parsing query parameters. Use a
 * callback URL with a single trailing `?event=` parameter.
 *
 * @param {object} unsignedEvent - bare event template (kind, created_at, tags, content)
 * @param {object} [opts]
 * @param {string|null} [opts.callbackUrl] - URL the signer appends the result to;
 *   omit/null for the clipboard variant.
 * @param {string} [opts.returnType] - 'event' (default) or 'signature'. The form
 *   needs 'event' because the signer's pubkey is unknown before signing.
 * @param {string} [opts.compressionType] - 'none' (default) or 'gzip'.
 * @param {string|null} [opts.appName] - requester name shown in the signer's
 *   approval dialog; percent-encoded and placed before callbackUrl (which
 *   must stay the last param). Omitted when absent.
 * @returns {string} nostrsigner: URL
 */
export function buildAmberSignerUrl(unsignedEvent, opts = {}) {
  const { callbackUrl = null, returnType = 'event', compressionType = 'none', appName = null } = opts;
  if (!unsignedEvent || typeof unsignedEvent !== 'object') {
    throw new Error('unsignedEvent must be an event object');
  }
  if (callbackUrl && callbackUrl.includes('&')) {
    throw new Error('callbackUrl must not contain "&" (NIP-55 appends it unencoded)');
  }
  const payload = encodeURIComponent(JSON.stringify(unsignedEvent));
  let url = `nostrsigner:${payload}?compressionType=${compressionType}` +
    `&returnType=${returnType}&type=sign_event`;
  if (appName) url += `&appName=${encodeAmberAppName(appName)}`;
  if (callbackUrl) url += `&callbackUrl=${callbackUrl}`;
  return url;
}

/**
 * Build the `nostrsigner:` URL that asks a NIP-55 signer for the user's
 * public key (the "connect" step, method `get_public_key`).
 *
 * The payload (URI path) is empty for get_public_key; only the query params
 * matter. The same callbackUrl restriction as signing applies: it is
 * appended to the query string unencoded, so it must not contain `&`. Use a
 * callback URL with a single trailing `?pubkey=` parameter so the result
 * can be extracted unambiguously (the sign flow uses `?event=`).
 *
 * @param {object} [opts]
 * @param {string|null} [opts.callbackUrl] - URL the signer appends the pubkey
 *   to; omit/null for the clipboard variant.
 * @param {string|null} [opts.appName] - requester name shown in the signer's
 *   approval dialog; percent-encoded and placed before callbackUrl (which
 *   must stay the last param). Omitted when absent.
 * @returns {string} nostrsigner: URL
 */
export function buildAmberConnectUrl(opts = {}) {
  const { callbackUrl = null, appName = null } = opts;
  if (callbackUrl && callbackUrl.includes('&')) {
    throw new Error('callbackUrl must not contain "&" (NIP-55 appends it unencoded)');
  }
  let url = 'nostrsigner:?type=get_public_key';
  if (appName) url += `&appName=${encodeAmberAppName(appName)}`;
  if (callbackUrl) url += `&callbackUrl=${callbackUrl}`;
  return url;
}

/**
 * Extract the raw signer result appended to the callback URL.
 *
 * The signer appends the result directly after `event=`, and the result (an
 * event JSON when returnType=event) may itself contain `&`, `=`, or `#`
 * characters that break URLSearchParams. Since `event=` is the last thing in
 * our callback URL, everything after its first occurrence is the result.
 *
 * @param {string} href - full window.location.href
 * @returns {string|null} raw result string, or null when absent/empty
 */
export function extractAmberResult(href) {
  const parts = String(href || '').split(/[?&]event=/);
  if (parts.length < 2) return null;
  const raw = parts.slice(1).join('&event=');
  return raw.length > 0 ? raw : null;
}

/**
 * Extract the raw get_public_key result appended to the connect callback
 * URL (`...?pubkey=<result>`). Same contract as extractAmberResult: the
 * `pubkey=` parameter is the last thing in our callback URL, so everything
 * after its first occurrence is the result, even when the signer appends
 * unencoded JSON containing `&`, `=`, or `#`.
 *
 * @param {string} href - full window.location.href
 * @returns {string|null} raw result string, or null when absent/empty
 */
export function extractAmberPubkey(href) {
  const parts = String(href || '').split(/[?&]pubkey=/);
  if (parts.length < 2) return null;
  const raw = parts.slice(1).join('&pubkey=');
  return raw.length > 0 ? raw : null;
}

/**
 * Extract the raw signer result appended to the ZAP-REQUEST callback URL
 * (`...?zapevent=<result>`). The zap flow uses its own callback parameter so
 * a returning signed kind:9734 zap request can never be mistaken for a
 * kind:1791 signature return (`?event=`) or a connect return (`?pubkey=`).
 * Same contract as extractAmberResult: `zapevent=` is the last thing in our
 * callback URL, so everything after its first occurrence is the result,
 * even when the signer appends unencoded JSON containing `&`, `=`, or `#`.
 *
 * @param {string} href - full window.location.href
 * @returns {string|null} raw result string, or null when absent/empty
 */
export function extractAmberZapResult(href) {
  const parts = String(href || '').split(/[?&]zapevent=/);
  if (parts.length < 2) return null;
  const raw = parts.slice(1).join('&zapevent=');
  return raw.length > 0 ? raw : null;
}

/**
 * Decode a NIP-55 get_public_key result into a pubkey descriptor.
 *
 * Signers return the pubkey as a plain string — hex or npub — possibly
 * percent-encoded, and some wrap results in JSON objects
 * (`{"result":"…"}` / `{"pubkey":"…"}` / `{"event":{"pubkey":"…"}}`).
 * This helper stays dependency-free, so npub bech32 decoding is left to
 * the caller (nostr-tools nip19 in the browser).
 *
 * @param {string} raw
 * @returns {{type: 'hex'|'npub', value: string}} normalized descriptor:
 *   hex values are lowercased; npub values are returned as-is for the
 *   caller to decode.
 */
export function decodeAmberPubkeyResult(raw) {
  let text = String(raw ?? '').trim();
  if (!text) throw new Error('empty signer result');
  if (/%[0-9a-fA-F]{2}/.test(text)) {
    try { text = decodeURIComponent(text); } catch { /* keep as-is */ }
  }
  if (text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('signer result is not valid JSON');
    }
    const candidate = parsed?.result ?? parsed?.pubkey ?? parsed?.event?.pubkey;
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new Error('signer result object carries no pubkey');
    }
    text = candidate.trim();
  }
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    return { type: 'hex', value: text.toLowerCase() };
  }
  if (/^npub1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,}$/.test(text)) {
    return { type: 'npub', value: text };
  }
  throw new Error('signer result is not a public key (expected 64-char hex or npub)');
}

/**
 * Decode a NIP-55 signer result into an event object.
 *
 * Handles:
 * - percent-encoded JSON (signers URL-encode the appended result)
 * - plain JSON (clipboard variant / paste fallback)
 * - gzip compression: "Signer1" + base64(gzip(json)), with `+` characters
 *   possibly mangled to spaces by URL transit
 * - `{ event: {...} }` wrapper shapes
 *
 * @param {string} raw
 * @returns {Promise<object>} parsed event object
 */
export async function decodeAmberResult(raw) {
  let text = String(raw ?? '').trim();
  if (!text) throw new Error('empty signer result');
  if (/%[0-9a-fA-F]{2}/.test(text)) {
    try { text = decodeURIComponent(text); } catch { /* keep as-is */ }
  }
  if (text.startsWith('Signer1')) {
    // compressionType=gzip: "Signer1" prefix + base64(gzip(event json)).
    // '+' in base64 may have been decoded to ' ' on the way through a URL.
    const b64 = text.slice('Signer1'.length).replace(/ /g, '+');
    let bytes;
    try {
      bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    } catch {
      throw new Error('invalid base64 in gzip signer result');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('signer result is not valid JSON');
  }
  if (parsed && parsed.event && parsed.event.sig) parsed = parsed.event;
  if (!parsed || typeof parsed !== 'object') throw new Error('signer result is not an event object');
  return parsed;
}
