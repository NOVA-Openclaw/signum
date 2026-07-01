import crypto from 'node:crypto';
import { nip19 } from 'nostr-tools';

/**
 * Hex-encode a buffer or string.
 */
export function toHex(input) {
  if (typeof input === 'string') return Buffer.from(input, 'utf8').toString('hex');
  return Buffer.from(input).toString('hex');
}

/**
 * Compute the sha256 hex digest of a UTF-8 string.
 */
export function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Encode a 32-byte hex pubkey as an npub.
 */
export function toNpub(pubkey) {
  try {
    return nip19.npubEncode(pubkey);
  } catch (err) {
    return null;
  }
}

/**
 * Parse an addressable a-tag value (kind:pubkey:d-tag).
 */
export function parseATag(aTag) {
  const parts = aTag.split(':');
  if (parts.length < 3) return null;
  const [kindStr, pubkey, ...dParts] = parts;
  const kind = Number.parseInt(kindStr, 10);
  if (!Number.isFinite(kind) || !pubkey || dParts.length === 0) return null;
  return { kind, pubkey, dTag: dParts.join(':') };
}

/**
 * Extract the first tag value matching name.
 */
export function getTag(event, name) {
  const tag = event.tags?.find((t) => Array.isArray(t) && t[0] === name);
  return tag ? tag[1] : undefined;
}

/**
 * Extract all values for a repeated tag name.
 */
export function getTags(event, name) {
  return (event.tags || [])
    .filter((t) => Array.isArray(t) && t[0] === name)
    .map((t) => t[1]);
}

/**
 * Sleep for N milliseconds.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async operation with exponential backoff.
 */
export async function withRetry(fn, { maxAttempts = 3, baseMs = 500, label = 'operation' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = baseMs * 2 ** (attempt - 1);
      console.warn(`[retry] ${label} failed (attempt ${attempt}/${maxAttempts}): ${err.message}; retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Run a promise with a timeout.
 */
export function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

/**
 * Basic pubkey hex validation.
 */
export function isValidPubkey(pubkey) {
  return typeof pubkey === 'string' && /^[0-9a-f]{64}$/i.test(pubkey);
}
