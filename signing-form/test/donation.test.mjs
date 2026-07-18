// Unit tests for issue #32: Step 4 zap completion-lock + separate
// "Make a larger donation" step.
//
// Run with: node --test signing-form/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ZAP_PENDING_TYPE,
  DONATION_PENDING_TYPE,
  MAX_ORPHAN_MSATS,
  buildZapPending,
  parseZapPending,
  parseSatsInput,
  donationAmountBounds,
  validateDonationAmount,
  isSymbolicZapDone,
  shouldShowDonationCard,
  reconstructZapPending,
  checkZapReturnTags,
  donationPaymentsSummary,
  donationPaidCompletion,
  donationAmountLocked
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

function makePending(type = ZAP_PENDING_TYPE, amountSats = 1956, now = 1000000) {
  return buildZapPending({
    unsignedZapReq: makeUnsignedZapReq(amountSats * 1000),
    sendMsats: amountSats * 1000,
    amountSats,
    sigEvent: SIG_EVENT,
    aTag: A_TAG,
    type
  }, now);
}

// ── parseSatsInput ───────────────────────────────────────────────────────

test('parseSatsInput rejects empty, whitespace, null, undefined', () => {
  assert.equal(parseSatsInput('').error, 'Please enter an amount.');
  assert.equal(parseSatsInput('   ').error, 'Please enter an amount.');
  assert.equal(parseSatsInput(null).error, 'Please enter an amount.');
  assert.equal(parseSatsInput(undefined).error, 'Please enter an amount.');
});

test('parseSatsInput rejects non-numeric and malformed input', () => {
  assert.equal(parseSatsInput('abc').error, 'Amount must be a whole number of sats.');
  assert.equal(parseSatsInput('12.5.3').error, 'Amount must be a whole number of sats.');
  assert.equal(parseSatsInput('1e10').error, 'Amount must be a whole number of sats.');
  assert.equal(parseSatsInput('-5').error, 'Amount must be a whole number of sats.');
  assert.equal(parseSatsInput('5.5').error, 'Amount must be a whole number of sats.');
});

test('parseSatsInput accepts valid whole-sats input', () => {
  assert.deepEqual(parseSatsInput('42'), { sats: 42, error: null });
  assert.deepEqual(parseSatsInput('  1000  '), { sats: 1000, error: null });
  assert.deepEqual(parseSatsInput('0'), { sats: 0, error: null });
});

test('parseSatsInput rejects absurdly large inputs', () => {
  assert.ok(parseSatsInput('9'.repeat(16)).error);
});

// ── donationAmountBounds / validateDonationAmount ────────────────────────

test('donationAmountBounds clamps ceiling to MAX_ORPHAN_MSATS', () => {
  const lnurl = { minSendable: 1000, maxSendable: MAX_ORPHAN_MSATS * 2 };
  const bounds = donationAmountBounds(lnurl);
  assert.equal(bounds.minSats, 1);
  assert.equal(bounds.maxSats, Math.floor(MAX_ORPHAN_MSATS / 1000));
});

test('validateDonationAmount accepts exact min and max boundaries', () => {
  const lnurl = { minSendable: 5000, maxSendable: 100000000 };
  assert.deepEqual(validateDonationAmount(5, lnurl), { sendMsats: 5000 });
  assert.deepEqual(validateDonationAmount(100000, lnurl), { sendMsats: 100000000 });
});

test('validateDonationAmount rejects below min with visible error, no silent clamp', () => {
  const lnurl = { minSendable: 5000, maxSendable: 100000000 };
  const res = validateDonationAmount(4, lnurl);
  assert.ok(res.error);
  assert.match(res.error, /Minimum donation is 5 sats/);
  assert.equal(res.sendMsats, undefined);
});

test('validateDonationAmount rejects above max with visible error, no silent clamp', () => {
  const lnurl = { minSendable: 1000, maxSendable: 10000000 };
  const res = validateDonationAmount(10001, lnurl);
  assert.ok(res.error);
  assert.match(res.error, /Maximum donation is 10000 sats/);
  assert.equal(res.sendMsats, undefined);
});

test('validateDonationAmount ceiling includes MAX_ORPHAN_MSATS sanity cap', () => {
  const lnurl = { minSendable: 1000, maxSendable: MAX_ORPHAN_MSATS * 2 };
  const capSats = Math.floor(MAX_ORPHAN_MSATS / 1000);
  const ok = validateDonationAmount(capSats, lnurl);
  assert.equal(ok.sendMsats, capSats * 1000);
  const tooBig = validateDonationAmount(capSats + 1, lnurl);
  assert.ok(tooBig.error);
});

// ── Step 4 lock / donation visibility decisions ──────────────────────────

test('isSymbolicZapDone locks on any receipt (A1)', () => {
  assert.equal(isSymbolicZapDone([]), false);
  assert.equal(isSymbolicZapDone(null), false);
  assert.equal(isSymbolicZapDone(undefined), false);
  assert.equal(isSymbolicZapDone([{ id: 'x', sats: 10 }]), true);
  assert.equal(isSymbolicZapDone([{ id: 'x', sats: 0 }]), true);
});

test('shouldShowDonationCard visible only when Step 4 is locked (A2)', () => {
  assert.equal(shouldShowDonationCard(false), false);
  assert.equal(shouldShowDonationCard(true), true);
  assert.equal(shouldShowDonationCard(undefined), false);
});

// ── Pending-record type separation ───────────────────────────────────────

test('buildZapPending defaults to type zap', () => {
  const p = buildZapPending({
    unsignedZapReq: makeUnsignedZapReq(),
    sendMsats: 1000,
    amountSats: 1,
    sigEvent: SIG_EVENT,
    aTag: A_TAG
  });
  assert.equal(p.type, 'zap');
});

test('buildZapPending supports donation type', () => {
  const p = makePending(DONATION_PENDING_TYPE, 5000);
  assert.equal(p.type, 'donate');
  assert.equal(p.amountSats, 5000);
});

test('parseZapPending accepts its expected type and rejects the other', () => {
  const zap = JSON.stringify(makePending(ZAP_PENDING_TYPE));
  const donate = JSON.stringify(makePending(DONATION_PENDING_TYPE, 5000));

  assert.ok(parseZapPending(zap, 1000000 + 60_000, ZAP_PENDING_TYPE));
  assert.equal(parseZapPending(zap, 1000000 + 60_000, DONATION_PENDING_TYPE), null);

  assert.ok(parseZapPending(donate, 1000000 + 60_000, DONATION_PENDING_TYPE));
  assert.equal(parseZapPending(donate, 1000000 + 60_000, ZAP_PENDING_TYPE), null);
});

test('parseZapPending default expected type remains zap (backward compatible)', () => {
  const zap = JSON.stringify(makePending(ZAP_PENDING_TYPE));
  const donate = JSON.stringify(makePending(DONATION_PENDING_TYPE, 5000));
  assert.ok(parseZapPending(zap, 1000000 + 60_000));
  assert.equal(parseZapPending(donate, 1000000 + 60_000), null);
});

// ── Donation orphan-return reconstruction ────────────────────────────────

test('reconstructZapPending preserves donation amount and type from returned event', () => {
  const signed = makeSignedZapReq({
    tags: makeUnsignedZapReq(5_000_000).tags
  });
  const res = reconstructZapPending(signed, SIG_EVENT, A_TAG, DONATION_PENDING_TYPE, 5000);
  assert.ok(res.pending, res.error || '');
  assert.equal(res.pending.sendMsats, 5_000_000);
  assert.equal(res.pending.amountSats, 5000);
  assert.equal(res.pending.type, 'donate');
});

test('reconstructZapPending defaults to zap type when type omitted', () => {
  const signed = makeSignedZapReq({
    tags: makeUnsignedZapReq(1_000_000).tags
  });
  const res = reconstructZapPending(signed, SIG_EVENT, A_TAG);
  assert.ok(res.pending, res.error || '');
  assert.equal(res.pending.type, 'zap');
});

test('reconstructZapPending rejects amount exceeding orphan sanity ceiling', () => {
  const overLimit = MAX_ORPHAN_MSATS + 1000;
  const signed = makeSignedZapReq({
    tags: makeUnsignedZapReq(overLimit).tags
  });
  const res = reconstructZapPending(signed, SIG_EVENT, A_TAG, DONATION_PENDING_TYPE, Date.now());
  assert.ok(res.error);
  assert.match(res.error, /out of range/);
});

test('checkZapReturnTags works with a donation-amount pending fixture', () => {
  const signed = makeSignedZapReq({
    tags: makeUnsignedZapReq(7_000_000).tags
  });
  const pending = buildZapPending({
    unsignedZapReq: makeUnsignedZapReq(7_000_000),
    sendMsats: 7_000_000,
    amountSats: 7000,
    sigEvent: SIG_EVENT,
    aTag: A_TAG,
    type: DONATION_PENDING_TYPE
  });
  assert.equal(checkZapReturnTags(signed, pending), null);
});

// ── Completed-payment list + paid-detection form reset (live-test fix) ──

const SYMBOLIC_RECEIPT = { id: 'r1', sats: 21, created_at: 1752700200 };
const DONATION_RECEIPT = { id: 'r2', sats: 5000, created_at: 1752700900 };
const DONATION_RECEIPT_2 = { id: 'r3', sats: 1500, created_at: 1752701500 };

test('donationPaymentsSummary handles empty and malformed input', () => {
  assert.deepEqual(donationPaymentsSummary([]), { count: 0, totalSats: 0, items: [] });
  assert.deepEqual(donationPaymentsSummary(null), { count: 0, totalSats: 0, items: [] });
  assert.deepEqual(donationPaymentsSummary(undefined), { count: 0, totalSats: 0, items: [] });
  // Entries without an id (unparsable receipts) are dropped, not listed.
  const s = donationPaymentsSummary([{ sats: 99 }, null, DONATION_RECEIPT]);
  assert.equal(s.count, 1);
  assert.equal(s.totalSats, 5000);
});

test('donationPaymentsSummary lists payments newest first with a total', () => {
  const s = donationPaymentsSummary([SYMBOLIC_RECEIPT, DONATION_RECEIPT_2, DONATION_RECEIPT]);
  assert.equal(s.count, 3);
  assert.equal(s.totalSats, 21 + 5000 + 1500);
  assert.deepEqual(s.items.map(i => i.id), ['r3', 'r2', 'r1']);
});

test('donationPaymentsSummary keeps amountless receipts visible (sats null)', () => {
  const s = donationPaymentsSummary([{ id: 'rx', sats: null, created_at: 1752700000 }]);
  assert.equal(s.count, 1);
  assert.equal(s.totalSats, 0);
  assert.equal(s.items[0].sats, null);
});

test('paid detection resets the donation form to its initial state', () => {
  const done = donationPaidCompletion(
    [DONATION_RECEIPT],
    [SYMBOLIC_RECEIPT, DONATION_RECEIPT]
  );
  assert.equal(done.phase, 'idle');          // Sign enabled, Pay disabled
  assert.equal(done.resetAmount, true);      // amount field cleared/re-enabled
  assert.equal(done.clearPayCtx, true);      // paid invoice no longer payable
  assert.equal(done.clearPending, true);     // pending donation record cleared
  assert.equal(done.paidSats, 5000);
  assert.equal(done.payments.count, 2);      // completed payment is listed
});

test('paid detection falls back to the invoice amount when the receipt has none', () => {
  const done = donationPaidCompletion(
    [{ id: 'rx', sats: null, created_at: 1752700900 }],
    [SYMBOLIC_RECEIPT, { id: 'rx', sats: null, created_at: 1752700900 }],
    777
  );
  assert.equal(done.paidSats, 777);
  assert.equal(done.phase, 'idle');
});

test('repeat-donation cycle: payments accumulate, each payment re-resets the form', () => {
  // First donation completes…
  const first = donationPaidCompletion(
    [DONATION_RECEIPT], [SYMBOLIC_RECEIPT, DONATION_RECEIPT]);
  assert.equal(first.phase, 'idle');
  assert.equal(first.payments.count, 2);
  // …the reset form allows another donation, whose receipt ACCUMULATES
  // alongside (not replacing) the earlier payments.
  const second = donationPaidCompletion(
    [DONATION_RECEIPT_2],
    [SYMBOLIC_RECEIPT, DONATION_RECEIPT, DONATION_RECEIPT_2]);
  assert.equal(second.phase, 'idle');
  assert.equal(second.clearPending, true);
  assert.equal(second.paidSats, 1500);
  assert.equal(second.payments.count, 3);
  assert.deepEqual(second.payments.items.map(i => i.id), ['r3', 'r2', 'r1']);
  assert.equal(second.payments.totalSats, 21 + 5000 + 1500);
});

test('donationAmountLocked locks the field only while a round-trip is in flight', () => {
  assert.equal(donationAmountLocked('signing'), true);
  assert.equal(donationAmountLocked('awaiting-signer'), true);
  assert.equal(donationAmountLocked('fetching-invoice'), true);
  assert.equal(donationAmountLocked('ready'), true);
  assert.equal(donationAmountLocked('idle'), false);
  assert.equal(donationAmountLocked('error'), false);
  assert.equal(donationAmountLocked('paid'), false);
  assert.equal(donationAmountLocked(undefined), false);
});
