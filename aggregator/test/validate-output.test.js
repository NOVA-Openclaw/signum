import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOutput } from '../src/validate-output.js';

const A_TAG = '30023:ecacc13f19380be2e8313c4dc818525ae394abf4b56d0a67bd3dbad87cb705e6:entity-dignity-2026';

function makeSignature(overrides = {}) {
  return {
    pubkey: 'a'.repeat(64),
    npub: 'npub1test',
    display_name: 'Test Signer',
    nip05: 'test@example.com',
    entity_type: 'human',
    statement: 'I sign.',
    trust_score: 67,
    trust_breakdown: { nip05: 100, follow_distance: 90, history: 100, zap: 0, nip85: 0, follow_hops: 1 },
    timestamp: 1783858351,
    event_id: 'e'.repeat(64),
    zapped: false,
    gated: false,
    ...overrides
  };
}

function makeOutput(overrides = {}) {
  const sigs = overrides.signatures ?? [makeSignature()];
  const base = {
    petition: {
      title: 'Test Petition',
      d_tag: 'entity-dignity-2026',
      a_tag: A_TAG,
      event_id: 'f'.repeat(64),
      sponsor_pubkey: 'ecacc13f19380be2e8313c4dc818525ae394abf4b56d0a67bd3dbad87cb705e6',
      content_hash: '1'.repeat(64)
    },
    stats: {
      total_signatures: sigs.length,
      qualifying_signatures: sigs.length,
      gated_count: 0,
      threshold: 25,
      last_updated: '2026-07-17T20:00:00.000Z'
    },
    trust_methodology: { weights: {}, threshold: 25 },
    signatures_chronological: sigs,
    signatures_trust_weighted: sigs
  };
  delete overrides.signatures;
  return { ...base, ...overrides };
}

test('valid output with no previous passes', () => {
  const { ok, errors } = validateOutput(makeOutput());
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test('valid output against equal-count previous passes', () => {
  const { ok } = validateOutput(makeOutput(), makeOutput());
  assert.equal(ok, true);
});

test('signature count growth passes', () => {
  const current = makeOutput({ signatures: [makeSignature(), makeSignature({ event_id: 'd'.repeat(64) })] });
  const previous = makeOutput();
  const { ok } = validateOutput(current, previous);
  assert.equal(ok, true);
});

test('signature count shrink fails', () => {
  const current = makeOutput();
  const previous = makeOutput({ signatures: [makeSignature(), makeSignature({ event_id: 'd'.repeat(64) })] });
  const { ok, errors } = validateOutput(current, previous);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('signature count shrank')));
});

test('petition a_tag mismatch against previous fails', () => {
  const previous = makeOutput();
  previous.petition.a_tag = '30023:' + 'b'.repeat(64) + ':some-other-petition';
  const { ok, errors } = validateOutput(makeOutput(), previous);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('a_tag changed')));
});

test('missing required top-level key fails', () => {
  const output = makeOutput();
  delete output.stats;
  const { ok, errors } = validateOutput(output);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('missing required key: stats')));
});

test('non-object output fails', () => {
  for (const bad of [null, [], 'string', 42]) {
    const { ok } = validateOutput(bad);
    assert.equal(ok, false, `expected failure for ${JSON.stringify(bad)}`);
  }
});

test('malformed a_tag fails', () => {
  const output = makeOutput();
  output.petition.a_tag = 'not-an-a-tag';
  const { ok, errors } = validateOutput(output);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('a_tag missing or malformed')));
});

test('count mismatch between stats and arrays fails', () => {
  const output = makeOutput();
  output.stats.total_signatures = 5;
  const { ok, errors } = validateOutput(output);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('signature count mismatch')));
});

test('unparseable last_updated fails', () => {
  const output = makeOutput();
  output.stats.last_updated = 'not a date';
  const { ok, errors } = validateOutput(output);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('last_updated')));
});

test('corrupt previous (non-object) skips regression checks but still validates current', () => {
  const { ok } = validateOutput(makeOutput(), 'garbage');
  assert.equal(ok, true);
});
