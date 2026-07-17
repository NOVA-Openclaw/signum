// Unit tests for the two-step zap-flow helpers in signing-form/zap-flow.js
// (issue #42): pending-state persistence/validation, returned zap-request
// checks, orphan-return reconstruction, and the Sign/Pay button state
// machine.
//
// Run with:  node --test signing-form/test/
//
// The regression focus is the reporter's exact state from #42: an
// ALREADY-SIGNED visitor (no petition fetched this session) whose Amber
// zap callback landed in a browsing context without the original pending
// state.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ZAP_PENDING_TTL_MS,
  buildZapPending,
  parseZapPending,
  checkZapReturnTags,
  reconstructZapPending,
  zapUiState
} from '../zap-flow.js';

const SIG_EVENT = {
  id: 'e1'.repeat(32),
  pubkey: 'a2'.repeat(32),
  kind: 1791,
  created_at: 1752700000,
  tags: [['a', '30023:' + 'b3'.repeat(32) + ':entity-dignity-2026']],
  content: '',
  sig: 'c4'.repeat(64)
};

const A_TAG = '30023:' + 'b3'.repeat(32) + ':entity-dignity-2026';

function makeUnsignedZapReq(sendMsats = 1956000) {
  return {
    kind: 9734,
    created_at: 1752700100,
    content: '',
    tags: [
      ['relays', 'wss://relay.damus.io', 'wss://nos.lol'],
      ['amount', String(sendMsats)],
      ['e', SIG_EVENT.id],
      ['a', A_TAG],
      ['p', 'b3'.repeat(32)]
    ]
  };
}

function makeSignedZapReq(overrides = {}) {
  return {
    ...makeUnsignedZapReq(),
    pubkey: SIG_EVENT.pubkey,
    id: 'd5'.repeat(32),
    sig: 'f6'.repeat(64),
    ...overrides
  };
}

function makePending(extra = {}, now = 1000000) {
  return buildZapPending({
    unsignedZapReq: makeUnsignedZapReq(),
    sendMsats: 1956000,
    amountSats: 1956,
    sigEvent: SIG_EVENT,
    aTag: A_TAG,
    ...extra
  }, now);
}

// ── buildZapPending / parseZapPending ────────────────────────────────────

test('parseZapPending round-trips a full pending record', () => {
  const pending = makePending({
    contentHash: 'ab'.repeat(32),
    petitionEvent: { kind: 30023, tags: [], content: 'x' },
    form: { aTagInput: A_TAG, relayHint: '', entityType: 'human',
      shortStatement: '', contentStatement: '', relaySet: 'wss://relay.damus.io' }
  });
  const parsed = parseZapPending(JSON.stringify(pending), 1000000 + 60_000);
  assert.ok(parsed, 'parses');
  assert.equal(parsed.type, 'zap');
  assert.equal(parsed.sendMsats, 1956000);
  assert.equal(parsed.amountSats, 1956);
  assert.equal(parsed.sigEvent.id, SIG_EVENT.id);
  assert.equal(parsed.aTag, A_TAG);
});

test('REGRESSION #42: pending without petitionEvent/contentHash/form is valid (already-signed-at-reload state)', () => {
  // An already-signed visitor never fetches the petition in-session: the
  // signed status is restored from relays via the cached pubkey. Their
  // pending zap record legitimately has no petitionEvent, contentHash,
  // or form snapshot — it must still resume.
  const pending = makePending();
  assert.equal(pending.petitionEvent, null);
  assert.equal(pending.contentHash, null);
  assert.equal(pending.form, null);
  const parsed = parseZapPending(JSON.stringify(pending), 1000000 + 60_000);
  assert.ok(parsed, 'pending without petition context must parse');
  assert.equal(parsed.sigEvent.pubkey, SIG_EVENT.pubkey);
});

test('parseZapPending rejects null/garbage/malformed JSON', () => {
  assert.equal(parseZapPending(null), null);
  assert.equal(parseZapPending(''), null);
  assert.equal(parseZapPending('not json'), null);
  assert.equal(parseZapPending('42'), null);
  assert.equal(parseZapPending('{"v":1}'), null);
});

test('parseZapPending rejects wrong version, wrong type, and missing required fields', () => {
  const base = makePending();
  const mutate = (fn) => {
    const p = JSON.parse(JSON.stringify(base));
    fn(p);
    return parseZapPending(JSON.stringify(p), 1000000 + 1);
  };
  assert.equal(mutate(p => { p.v = 2; }), null, 'wrong version');
  assert.equal(mutate(p => { p.type = 'sign'; }), null, 'wrong type (pending sign must never resume as zap)');
  assert.equal(mutate(p => { delete p.unsignedZapReq; }), null, 'missing unsignedZapReq');
  assert.equal(mutate(p => { p.unsignedZapReq.tags = 'nope'; }), null, 'unsignedZapReq without tags array');
  assert.equal(mutate(p => { delete p.sigEvent; }), null, 'missing sigEvent');
  assert.equal(mutate(p => { delete p.sigEvent.id; }), null, 'sigEvent without id');
  assert.equal(mutate(p => { delete p.aTag; }), null, 'missing aTag');
  assert.equal(mutate(p => { p.sendMsats = 0; }), null, 'zero amount');
  assert.equal(mutate(p => { delete p.ts; }), null, 'missing timestamp');
});

test('parseZapPending enforces the TTL', () => {
  const pending = makePending({}, 1000000);
  const raw = JSON.stringify(pending);
  assert.ok(parseZapPending(raw, 1000000 + ZAP_PENDING_TTL_MS - 1), 'inside TTL');
  assert.equal(parseZapPending(raw, 1000000 + ZAP_PENDING_TTL_MS + 1), null, 'expired');
});

// ── checkZapReturnTags ───────────────────────────────────────────────────

test('checkZapReturnTags accepts a matching signed zap request', () => {
  assert.equal(checkZapReturnTags(makeSignedZapReq(), makePending()), null);
});

test('checkZapReturnTags rejects non-objects and wrong kinds', () => {
  assert.match(checkZapReturnTags(null, makePending()), /No event object/);
  assert.match(checkZapReturnTags(makeSignedZapReq({ kind: 1791 }), makePending()), /expected 9734/);
});

test('checkZapReturnTags rejects missing sig/pubkey', () => {
  assert.match(checkZapReturnTags(makeSignedZapReq({ sig: undefined }), makePending()), /missing sig or pubkey/);
  assert.match(checkZapReturnTags(makeSignedZapReq({ pubkey: undefined }), makePending()), /missing sig or pubkey/);
});

test('checkZapReturnTags rejects an e-tag pointing at a different signature event', () => {
  const signed = makeSignedZapReq();
  signed.tags = signed.tags.map(t => t[0] === 'e' ? ['e', '99'.repeat(32)] : t);
  assert.match(checkZapReturnTags(signed, makePending()), /different signature event/);
});

test('checkZapReturnTags rejects a different petition a-tag', () => {
  const signed = makeSignedZapReq();
  signed.tags = signed.tags.map(t => t[0] === 'a' ? ['a', '30023:' + '77'.repeat(32) + ':other'] : t);
  assert.match(checkZapReturnTags(signed, makePending()), /different petition/);
});

test('checkZapReturnTags rejects a changed amount', () => {
  const signed = makeSignedZapReq();
  signed.tags = signed.tags.map(t => t[0] === 'amount' ? ['amount', '999000'] : t);
  assert.match(checkZapReturnTags(signed, makePending()), /different amount/);
});

test('checkZapReturnTags rejects a missing relays tag', () => {
  const signed = makeSignedZapReq();
  signed.tags = signed.tags.filter(t => t[0] !== 'relays');
  assert.match(checkZapReturnTags(signed, makePending()), /missing its relays tag/);
});

test('checkZapReturnTags enforces the hot-switch pubkey guard', () => {
  // Zap request signed by a different key than the signature event —
  // the receipt would silently never be credited (issues #37/#39).
  const signed = makeSignedZapReq({ pubkey: '11'.repeat(32) });
  assert.match(checkZapReturnTags(signed, makePending()), /different key than your signature/);
});

// ── reconstructZapPending (orphan return, the #42 state-loss case) ──────

test('REGRESSION #42: reconstructZapPending resumes an orphaned zap return', () => {
  // Amber returned a valid signed zap request, but the pending state was
  // lost (callback landed in a fresh browsing context). The signed status
  // was restored independently from relays — the flow must reconstruct
  // and resume, not die silently.
  const res = reconstructZapPending(makeSignedZapReq(), SIG_EVENT, A_TAG, 5000);
  assert.ok(res.pending, 'reconstruction succeeds: ' + (res.error || ''));
  assert.equal(res.pending.sendMsats, 1956000);
  assert.equal(res.pending.amountSats, 1956);
  assert.equal(res.pending.sigEvent.id, SIG_EVENT.id);
  assert.equal(res.pending.aTag, A_TAG);
  // The reconstructed pending must satisfy the same return checks.
  assert.equal(checkZapReturnTags(makeSignedZapReq(), res.pending), null);
});

test('reconstructZapPending refuses without a restored signature event', () => {
  const res = reconstructZapPending(makeSignedZapReq(), null, A_TAG);
  assert.ok(res.error);
  assert.match(res.error, /signature could not be restored/);
});

test('reconstructZapPending refuses without a petition a-tag', () => {
  const res = reconstructZapPending(makeSignedZapReq(), SIG_EVENT, '');
  assert.ok(res.error);
  assert.match(res.error, /No petition is loaded/);
});

test('reconstructZapPending rejects an e-tag not matching the restored signature', () => {
  const otherSig = { ...SIG_EVENT, id: '88'.repeat(32) };
  const res = reconstructZapPending(makeSignedZapReq(), otherSig, A_TAG);
  assert.ok(res.error);
  assert.match(res.error, /different signature event/);
});

test('reconstructZapPending rejects an a-tag not matching the page petition', () => {
  const res = reconstructZapPending(makeSignedZapReq(), SIG_EVENT, '30023:' + '77'.repeat(32) + ':other');
  assert.ok(res.error);
  assert.match(res.error, /different petition/);
});

test('reconstructZapPending enforces the hot-switch pubkey guard on orphan returns', () => {
  const signed = makeSignedZapReq({ pubkey: '11'.repeat(32) });
  const res = reconstructZapPending(signed, SIG_EVENT, A_TAG);
  assert.ok(res.error);
  assert.match(res.error, /different key than your signature/);
});

test('reconstructZapPending rejects unusable or out-of-range amounts', () => {
  const noAmount = makeSignedZapReq();
  noAmount.tags = noAmount.tags.filter(t => t[0] !== 'amount');
  assert.match(reconstructZapPending(noAmount, SIG_EVENT, A_TAG).error, /no usable amount/);

  const nonNumeric = makeSignedZapReq();
  nonNumeric.tags = nonNumeric.tags.map(t => t[0] === 'amount' ? ['amount', '19x56'] : t);
  assert.match(reconstructZapPending(nonNumeric, SIG_EVENT, A_TAG).error, /no usable amount/);

  const absurd = makeSignedZapReq();
  absurd.tags = absurd.tags.map(t => t[0] === 'amount' ? ['amount', '999999999999999'] : t);
  assert.match(reconstructZapPending(absurd, SIG_EVENT, A_TAG).error, /out of range/);
});

// ── zapUiState (two-button state machine) ────────────────────────────────

test('Pay is enabled ONLY in the ready phase', () => {
  const phases = ['idle', 'signing', 'awaiting-signer', 'fetching-invoice', 'ready', 'paid', 'error'];
  for (const phase of phases) {
    const ui = zapUiState(phase, 1956);
    assert.equal(ui.pay.disabled, phase !== 'ready',
      `pay.disabled in phase "${phase}"`);
  }
});

test('idle: Sign enabled with amount, Pay locked', () => {
  const ui = zapUiState('idle', 1956);
  assert.equal(ui.sign.disabled, false);
  assert.match(ui.sign.label, /Sign Zap Event/);
  assert.match(ui.sign.label, /1956 sats/);
  assert.equal(ui.pay.disabled, true);
  assert.match(ui.pay.label, /Pay Zap Invoice/);
  assert.ok(ui.hint.length > 0, 'has a hint');
});

test('signing: both locked, Sign shows spinner', () => {
  const ui = zapUiState('signing', 1956);
  assert.equal(ui.sign.disabled, true);
  assert.equal(ui.sign.spinner, true);
  assert.equal(ui.pay.disabled, true);
});

test('awaiting-signer: Sign re-enabled for retry while Amber round-trip is out', () => {
  const ui = zapUiState('awaiting-signer', 1956);
  assert.equal(ui.sign.disabled, false, 'retry must stay available');
  assert.equal(ui.pay.disabled, true);
  assert.match(ui.hint, /Amber/);
});

test('fetching-invoice: signed ✓ shown, Pay spinner on', () => {
  const ui = zapUiState('fetching-invoice', 1956);
  assert.match(ui.sign.label, /✓/);
  assert.equal(ui.sign.disabled, true);
  assert.equal(ui.pay.spinner, true);
  assert.equal(ui.pay.disabled, true);
});

test('ready: signed ✓ + Pay enabled with amount (the #42 UX spec state)', () => {
  const ui = zapUiState('ready', 1956);
  assert.match(ui.sign.label, /✓ Zap event signed/);
  assert.equal(ui.sign.disabled, true);
  assert.equal(ui.pay.disabled, false);
  assert.match(ui.pay.label, /Pay Zap Invoice/);
  assert.match(ui.pay.label, /1956 sats/);
});

test('paid: Pay shows received, Sign offers another zap', () => {
  const ui = zapUiState('paid', 1956);
  assert.match(ui.pay.label, /✓ Zap received/);
  assert.equal(ui.pay.disabled, true);
  assert.equal(ui.sign.disabled, false);
  assert.match(ui.sign.label, /Zap again/);
});

test('error: Sign re-enabled for retry, Pay locked', () => {
  const ui = zapUiState('error', 1956);
  assert.equal(ui.sign.disabled, false);
  assert.equal(ui.pay.disabled, true);
  assert.match(ui.hint, /retry/i);
});

test('unknown phases fall back to idle', () => {
  const ui = zapUiState('bogus', 42);
  assert.equal(ui.sign.disabled, false);
  assert.equal(ui.pay.disabled, true);
});

// ── full resume simulation (storage round-trip, reporter scenario) ──────

test('REGRESSION #42 end-to-end shape: save → reload → parse → validate, already-signed at reload', () => {
  // 1. Already-signed visitor taps "Sign Zap Event": pending saved with
  //    NO petition context (never fetched this session).
  const stored = JSON.stringify(makePending({}, 2_000_000));

  // 2. Amber signs; callback reloads the page (possibly a fresh context —
  //    with localStorage persistence the record is still readable).
  const pending = parseZapPending(stored, 2_000_000 + 5 * 60 * 1000);
  assert.ok(pending, 'pending survives the reload window');

  // 3. The returned signed request validates against the restored pending.
  const signed = makeSignedZapReq();
  assert.equal(checkZapReturnTags(signed, pending), null);

  // 4. Button machine lands in ready once the invoice is fetched.
  const ui = zapUiState('ready', pending.amountSats);
  assert.equal(ui.pay.disabled, false);
});
