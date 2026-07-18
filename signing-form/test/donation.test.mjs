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
  checkZapReturnTags
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

test('reconstructZapPending preserves donation amount from returned event', () => {
  const signed = makeSignedZapReq({
    tags: makeUnsignedZapReq(5_000_000).tags
  });
  const res = reconstructZapPending(signed, SIG_EVENT, A_TAG, 5000);
  assert.ok(res.pending, res.error || '');
  assert.equal(res.pending.sendMsats, 5_000_000);
  assert.equal(res.pending.amountSats, 5000);
  assert.equal(res.pending.type, 'zap'); // reconstruction is type-agnostic
});

test('reconstructZapPending rejects amount exceeding orphan sanity ceiling', () => {
  const overLimit = MAX_ORPHAN_MSATS + 1000;
  const signed = makeSignedZapReq({
    tags: makeUnsignedZapReq(overLimit).tags
  });
  const res = reconstructZapPending(signed, SIG_EVENT, A_TAG);
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
