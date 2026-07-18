// zap-flow.js — pure helpers for the Signum signing form's two-step zap
// flow (issue #42): pending-state round-trip persistence, returned
// zap-request validation, orphan-return reconstruction, and the
// Sign/Pay button state machine.
//
// Pure functions only: no DOM, window, or storage access, so everything
// here can be unit-tested in Node (see test/zap-flow.test.mjs) and reused
// by other pages. Cryptographic checks (event id hash, Schnorr signature)
// stay in the page, where nostr-tools is imported — these helpers cover
// everything else.

/** How long a persisted zap round-trip stays resumable. */
export const ZAP_PENDING_TTL_MS = 30 * 60 * 1000;

/** Pending-record type for the fixed symbolic zap (Step 4). */
export const ZAP_PENDING_TYPE = 'zap';

/** Pending-record type for the open-amount donation step. */
export const DONATION_PENDING_TYPE = 'donate';

// Sanity ceiling for a zap amount arriving inside a returned signed
// request when the page's own copy of the request was lost: 100M sats
// (1 BTC) in msats. Anything above is treated as corrupt, not payable.
export const MAX_ORPHAN_MSATS = 100_000_000_000;

/**
 * Build the pending zap round-trip record persisted before launching an
 * external signer (Amber). The record must carry everything needed to
 * resume the flow after a FULL page reload — including in a fresh
 * browsing context (issue #42: per-tab sessionStorage did not survive
 * Amber's callback landing in a new tab, so the record now lives in
 * localStorage; see the form's savePendingZap).
 *
 * `petitionEvent`, `contentHash`, and `form` are optional: an
 * already-signed visitor can reach the zap flow without ever fetching
 * the petition in this session (signed status restored from relays via
 * the cached pubkey), so a valid pending record exists without them.
 *
 * @param {string} [type] - pending record type ('zap' or 'donate')
 * @returns {object} pending record (v:1, type)
 */
export function buildZapPending(
  { unsignedZapReq, sendMsats, amountSats, sigEvent, aTag,
    contentHash = null, petitionEvent = null, form = null,
    type = ZAP_PENDING_TYPE },
  now = Date.now()
) {
  return {
    v: 1,
    type,
    ts: now,
    unsignedZapReq,
    sendMsats,
    amountSats,
    sigEvent,
    aTag,
    contentHash,
    petitionEvent,
    form
  };
}

/**
 * Parse + validate a persisted pending zap record. Returns the record or
 * null when absent, malformed, the wrong type/version, missing a required
 * field, or expired. petitionEvent/contentHash/form are NOT required —
 * see buildZapPending (the already-signed-at-reload state, which is
 * exactly the reporter's state in issue #42).
 *
 * @param {string|null} raw - the stored JSON string
 * @param {number} [now]
 * @param {string} [expectedType] - pending type to accept ('zap' or 'donate')
 * @returns {object|null}
 */
export function parseZapPending(raw, now = Date.now(), expectedType = ZAP_PENDING_TYPE) {
  if (!raw) return null;
  let p;
  try { p = JSON.parse(raw); } catch { return null; }
  if (!p || typeof p !== 'object' || p.v !== 1 || p.type !== expectedType) return null;
  if (!p.unsignedZapReq || typeof p.unsignedZapReq !== 'object') return null;
  if (!Array.isArray(p.unsignedZapReq.tags)) return null;
  if (!p.sigEvent || typeof p.sigEvent !== 'object' || !p.sigEvent.id) return null;
  if (!p.aTag || typeof p.aTag !== 'string') return null;
  if (!(Number(p.sendMsats) > 0)) return null;
  if (typeof p.ts !== 'number' || (now - p.ts) > ZAP_PENDING_TTL_MS) return null;
  return p;
}

/**
 * Parse a user-entered donation amount. Rejects non-numeric, malformed,
 * empty, whitespace, fractional, or out-of-range input with a visible
 * error message instead of silently clamping.
 *
 * @param {string} input
 * @returns {{sats: number, error: null}|{sats: null, error: string}}
 */
export function parseSatsInput(input) {
  if (input === null || input === undefined || String(input).trim() === '') {
    return { sats: null, error: 'Please enter an amount.' };
  }
  const raw = String(input).trim();
  // Strict integer sats only — no decimals, scientific notation, or signs.
  if (!/^\d+$/.test(raw)) {
    return { sats: null, error: 'Amount must be a whole number of sats.' };
  }
  // Avoid falling through JavaScript's unsafe integer range.
  if (raw.length > 15) {
    return { sats: null, error: 'Amount is too large.' };
  }
  const sats = Number(raw);
  if (!Number.isFinite(sats)) {
    return { sats: null, error: 'Amount is not valid.' };
  }
  return { sats, error: null };
}

/**
 * Determine the effective min/max sats for the donation form.
 * The UI ceiling is clamped to MAX_ORPHAN_MSATS so a signed request can
 * still be reconstructed if the round-trip state is lost (A4).
 *
 * @param {object} lnurl - LNURL-pay response
 * @returns {{minSats: number, maxSats: number}}
 */
export function donationAmountBounds(lnurl) {
  const minMsats = lnurl?.minSendable ?? 1000;
  const maxMsats = lnurl?.maxSendable ?? 100000000;
  const orphanCapMsats = MAX_ORPHAN_MSATS;
  return {
    minSats: Math.ceil(minMsats / 1000),
    maxSats: Math.floor(Math.min(maxMsats, orphanCapMsats) / 1000)
  };
}

/**
 * Validate a donation amount against LNURL bounds.
 * Returns {sendMsats} on success or {error} on failure — never silently
 * clamps the amount.
 *
 * @param {number} sats
 * @param {object} lnurl
 * @returns {{sendMsats: number}|{error: string}}
 */
export function validateDonationAmount(sats, lnurl) {
  const { minSats, maxSats } = donationAmountBounds(lnurl);
  if (sats < minSats) {
    return { error: `Minimum donation is ${minSats} sats.` };
  }
  if (sats > maxSats) {
    return { error: `Maximum donation is ${maxSats} sats.` };
  }
  return { sendMsats: sats * 1000 };
}

/**
 * Step 4 (symbolic zap) completion-lock decision.
 * Per A1: any prior receipt from the connected pubkey locks the step.
 *
 * @param {Array} receipts - parsed receipt objects from findZapReceipts()
 * @returns {boolean}
 */
export function isSymbolicZapDone(receipts) {
  return Array.isArray(receipts) && receipts.length > 0;
}

/**
 * Donation-step visibility decision.
 * Per A2: the donation card is shown only after Step 4 is locked.
 *
 * @param {boolean} isStep4Locked
 * @returns {boolean}
 */
export function shouldShowDonationCard(isStep4Locked) {
  return !!isStep4Locked;
}

/**
 * Non-cryptographic validation of a signer-returned kind:9734 zap request
 * against the pending round-trip record: kind, e-tag (signature event),
 * a-tag (petition), amount, relays presence, and the hot-switch pubkey
 * guard (zap-request pubkey must equal the signature event's pubkey, or
 * the receipt would silently never be credited — issue #37/#39).
 *
 * The caller still verifies the event id hash and Schnorr signature.
 *
 * @param {object} signed - returned (allegedly signed) zap request
 * @param {object} pending - record from buildZapPending/parseZapPending
 * @returns {string|null} human-readable error, or null when valid
 */
export function checkZapReturnTags(signed, pending) {
  if (!signed || typeof signed !== 'object') {
    return 'No event object in the signer response.';
  }
  if (signed.kind !== 9734) {
    return 'Returned event has kind ' + signed.kind + ', expected 9734 (zap request).';
  }
  if (!signed.sig || !signed.pubkey) {
    return 'Returned event is missing sig or pubkey.';
  }
  const tagVal = name => signed.tags?.find(t => t[0] === name)?.[1];
  if (tagVal('e') !== pending.sigEvent.id) {
    return 'Returned zap request references a different signature event.';
  }
  if (tagVal('a') !== pending.aTag) {
    return 'Returned zap request references a different petition.';
  }
  const expectedAmount = pending.unsignedZapReq.tags.find(t => t[0] === 'amount')?.[1];
  if (tagVal('amount') !== expectedAmount) {
    return 'Returned zap request carries a different amount.';
  }
  if (!signed.tags?.some(t => t[0] === 'relays' && t.length > 1)) {
    return 'Returned zap request is missing its relays tag.';
  }
  if (signed.pubkey !== pending.sigEvent.pubkey) {
    return 'The zap request was signed by a different key than your signature, so the ' +
      'zap receipt would never be credited. Switch your signer back to the key that ' +
      'signed this petition and try again.';
  }
  return null;
}

/**
 * Reconstruct a pending record from a returned signed zap request when
 * the persisted round-trip state was LOST (issue #42 root cause: Amber's
 * callback can land in a fresh browsing context whose per-tab storage is
 * empty). Everything needed to resume is recoverable from the signed
 * event itself plus the restored signed status:
 *
 *   - amount   → the request's own amount tag (what the wallet will show)
 *   - sigEvent → must match the request's e-tag (restored from relays)
 *   - aTag     → the page's petition, must match the request's a-tag
 *
 * The hot-switch pubkey guard and all tag checks still run — a request
 * that fails them is rejected, never silently paid.
 *
 * @param {object} signed - decoded signer result
 * @param {object} sigEvent - the restored kind:1791 signature event
 * @param {string} aTag - the page's petition a-tag
 * @param {string} [type] - pending record type ('zap' or 'donate')
 * @param {number} [now]
 * @returns {{pending: object}|{error: string}}
 */
export function reconstructZapPending(signed, sigEvent, aTag, type = ZAP_PENDING_TYPE, now = Date.now()) {
  if (!signed || typeof signed !== 'object') {
    return { error: 'No event object in the signer response.' };
  }
  if (!sigEvent || !sigEvent.id) {
    return { error: 'Your signature could not be restored, so the returned zap request cannot be matched to it.' };
  }
  if (!aTag) {
    return { error: 'No petition is loaded, so the returned zap request cannot be matched.' };
  }
  const amountRaw = signed.tags?.find(t => t[0] === 'amount')?.[1];
  if (!amountRaw || !/^\d+$/.test(amountRaw)) {
    return { error: 'Returned zap request carries no usable amount.' };
  }
  const sendMsats = Number(amountRaw);
  if (!(sendMsats > 0) || sendMsats > MAX_ORPHAN_MSATS) {
    return { error: 'Returned zap request amount is out of range.' };
  }
  const pending = buildZapPending({
    // The page's own copy of the unsigned request is gone; mirror the
    // returned event so the amount check is self-consistent. The REAL
    // checks (e-tag, a-tag, pubkey, id, sig) all run against
    // independently restored state.
    unsignedZapReq: {
      kind: 9734,
      created_at: signed.created_at,
      content: signed.content ?? '',
      tags: (signed.tags || []).map(t => Array.isArray(t) ? [...t] : t)
    },
    sendMsats,
    amountSats: Math.round(sendMsats / 1000),
    sigEvent,
    aTag,
    type
  }, now);
  const err = checkZapReturnTags(signed, pending);
  if (err) return { error: err };
  return { pending };
}

/**
 * Summarize the connected pubkey's completed zap payments for the
 * donation card's payment list (issue #32 live-test finding): every
 * kind:9735 receipt e-tagging the signature event from this pubkey is a
 * completed payment, so repeat donations accumulate here naturally
 * (newest first) instead of replacing each other.
 *
 * @param {Array} receipts - parsed receipt objects from findZapReceipts()
 * @returns {{count:number, totalSats:number,
 *            items:Array<{id:string,sats:number|null,created_at:number|null}>}}
 */
export function donationPaymentsSummary(receipts) {
  const items = (Array.isArray(receipts) ? receipts : [])
    .filter(r => r && typeof r === 'object' && r.id)
    .map(r => ({
      id: r.id,
      sats: Number(r.sats) > 0 ? Number(r.sats) : null,
      created_at: typeof r.created_at === 'number' ? r.created_at : null
    }))
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const totalSats = items.reduce((s, r) => s + (r.sats || 0), 0);
  return { count: items.length, totalSats, items };
}

/**
 * Completion decision once a donation payment is detected (a fresh
 * kind:9735 receipt arrives while the donation invoice is outstanding).
 * Live-test finding on issue #32: the page detected the receipt but the
 * "Pay Zap Invoice" button stayed active. The required behavior is a
 * FULL form reset so another donation can follow:
 *
 *   - phase returns to 'idle' (Sign enabled, Pay disabled — the paid
 *     invoice can no longer be paid again)
 *   - the amount field is cleared and re-enabled
 *   - the invoice context is dropped
 *   - the pending DONATION record (and only that record — never the
 *     symbolic-zap key) is cleared from storage
 *   - the completed payment joins the accumulated payment list
 *
 * @param {Array} freshReceipts - receipts not seen before this payment
 * @param {Array} allReceipts - every receipt from this pubkey
 * @param {number} [fallbackSats] - amount to report when the fresh
 *   receipts carry no parsable amount (e.g. the invoice's own amount)
 * @returns {{paidSats:number, phase:string, resetAmount:boolean,
 *            clearPayCtx:boolean, clearPending:boolean, payments:object}}
 */
export function donationPaidCompletion(freshReceipts, allReceipts, fallbackSats = 0) {
  const fresh = Array.isArray(freshReceipts) ? freshReceipts : [];
  const paidSats = fresh.reduce((s, r) => s + (Number(r?.sats) > 0 ? Number(r.sats) : 0), 0)
    || (Number(fallbackSats) > 0 ? Number(fallbackSats) : 0);
  return {
    paidSats,
    phase: 'idle',
    resetAmount: true,
    clearPayCtx: true,
    clearPending: true,
    payments: donationPaymentsSummary(allReceipts)
  };
}

/**
 * Whether the donation amount input should be locked for a given phase.
 * Once a round-trip is in flight the entered amount is baked into the
 * signed zap request (and then the invoice), so editing it would only
 * desynchronize the field from what the wallet will actually pay. The
 * field unlocks whenever a fresh donation can be started.
 *
 * @param {string} phase - donation state-machine phase
 * @returns {boolean}
 */
export function donationAmountLocked(phase) {
  return phase === 'signing' || phase === 'awaiting-signer' ||
    phase === 'fetching-invoice' || phase === 'ready';
}

/**
 * The two-button Step 4 state machine (issue #42 UX spec): both buttons
 * are always visible; "Sign Zap Event" drives the signature phase and
 * "Pay Zap Invoice" stays disabled until a validated signed request has
 * produced a bolt11 invoice.
 *
 * Phases:
 *   idle             — nothing in flight; Sign enabled, Pay disabled
 *   signing          — signer prompt open / LNURL resolving; both disabled
 *   awaiting-signer  — Amber round-trip launched; Sign re-enabled (retry)
 *   fetching-invoice — signed ✓, invoice being fetched; Pay shows spinner
 *   ready            — invoice in hand; Pay ENABLED (the only such phase)
 *   paid             — receipt confirmed; Sign becomes "Zap again"
 *   error            — visible failure rendered below; Sign enabled (retry)
 *
 * @param {string} phase
 * @param {number} [amountSats]
 * @returns {{sign:{label:string,disabled:boolean,spinner:boolean},
 *            pay:{label:string,disabled:boolean,spinner:boolean},
 *            hint:string}}
 */
export function zapUiState(phase, amountSats) {
  const sats = amountSats ? ` — ${amountSats} sats` : '';
  const signIdle = { label: `⚡ Sign Zap Event${sats}`, disabled: false, spinner: false };
  const payLocked = { label: 'Pay Zap Invoice', disabled: true, spinner: false };
  switch (phase) {
    case 'signing':
      return {
        sign: { label: 'Signing zap event…', disabled: true, spinner: true },
        pay: payLocked,
        hint: 'Waiting for your signer to sign the zap request…'
      };
    case 'awaiting-signer':
      return {
        sign: signIdle,
        pay: payLocked,
        hint: 'Waiting for Amber — returning here resumes automatically. ' +
          'You can hit “Sign Zap Event” again to retry.'
      };
    case 'fetching-invoice':
      return {
        sign: { label: '✓ Zap event signed', disabled: true, spinner: false },
        pay: { label: 'Fetching invoice…', disabled: true, spinner: true },
        hint: 'Zap request signed — fetching the Lightning invoice…'
      };
    case 'ready':
      return {
        sign: { label: '✓ Zap event signed', disabled: true, spinner: false },
        pay: { label: `⚡ Pay Zap Invoice${sats}`, disabled: false, spinner: false },
        hint: 'Invoice ready — hit “Pay Zap Invoice” to open your Lightning wallet.'
      };
    case 'paid':
      return {
        sign: { label: `⚡ Zap again${sats}`, disabled: false, spinner: false },
        pay: { label: '✓ Zap received', disabled: true, spinner: false },
        hint: 'Zap received — thank you! Repeat zaps are welcome.'
      };
    case 'error':
      return {
        sign: signIdle,
        pay: payLocked,
        hint: 'Something went wrong — details below. Hit “Sign Zap Event” to retry.'
      };
    case 'idle':
    default:
      return {
        sign: signIdle,
        pay: payLocked,
        hint: 'Two steps: sign the zap request with your Nostr signer, ' +
          'then pay the invoice with your Lightning wallet.'
      };
  }
}
