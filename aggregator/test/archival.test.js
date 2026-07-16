import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SignumDatabase } from '../src/db.js';
import { ArchivalRepublisher } from '../src/archival-republisher.js';

const A_TAG = '30023:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:test-petition';
const ARCHIVE_RELAY = 'wss://archive.test.example';

/**
 * Fake SimplePool: records publishes, optionally rejects per-relay to
 * simulate write-policy rejections (auth/whitelist) or outages.
 */
class FakePool {
  constructor({ reject = {} } = {}) {
    this.published = [];
    this.reject = reject; // relay url -> rejection message
  }

  publish(relays, event) {
    return relays.map((relay) => {
      if (this.reject[relay]) {
        return Promise.reject(new Error(this.reject[relay]));
      }
      this.published.push({ relay, event });
      return Promise.resolve('');
    });
  }

  close() {}
}

function fakeEvent(kind, id, extra = {}) {
  return {
    id,
    pubkey: 'b'.repeat(64),
    kind,
    created_at: 1750000000,
    tags: [['a', A_TAG]],
    content: 'test content',
    sig: 'c'.repeat(128),
    ...extra
  };
}

function seedDb(db) {
  const petitionEvent = fakeEvent(30023, 'p'.repeat(64), { tags: [['d', 'test-petition'], ['title', 'Test']] });
  db.upsertPetition({
    a_tag: A_TAG,
    event_id: petitionEvent.id,
    pubkey: petitionEvent.pubkey,
    d_tag: 'test-petition',
    title: 'Test',
    content: petitionEvent.content,
    content_hash: 'e'.repeat(64),
    published_at: petitionEvent.created_at,
    raw_event: JSON.stringify(petitionEvent)
  });

  const sig1 = fakeEvent(1791, '1'.repeat(64));
  const sig2 = fakeEvent(1791, '2'.repeat(64), { pubkey: 'd'.repeat(64) });
  for (const [i, ev] of [sig1, sig2].entries()) {
    db.upsertSignature({
      id: ev.id,
      pubkey: ev.pubkey,
      petition_a_tag: A_TAG,
      content_hash: 'e'.repeat(64),
      entity_type: 'ai_agent',
      statement: '',
      content: '',
      created_at: ev.created_at + i,
      raw_event: JSON.stringify(ev),
      verified: 1,
      revoked: i === 1 ? 1 : 0, // second signature revoked — still archived
      zapped: 0
    });
  }

  const deletion = fakeEvent(5, '5'.repeat(64), { tags: [['e', sig2.id], ['a', A_TAG]] });
  db.recordDeletion({
    deletion_event_id: deletion.id,
    target_event_id: sig2.id,
    author_pubkey: deletion.pubkey,
    petition_a_tag: A_TAG,
    created_at: deletion.created_at,
    raw_event: JSON.stringify(deletion)
  });

  return { petitionEvent, sig1, sig2, deletion };
}

function makeConfig(overrides = {}) {
  return {
    petition: { a_tag: A_TAG, relays: ['wss://poll.test.example'] },
    archival: { relays: [ARCHIVE_RELAY], republish: true, ...overrides }
  };
}

let tmpDir;
let db;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signum-archival-test-'));
  db = new SignumDatabase(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('republishes petition, all valid signatures (revoked included), and deletions verbatim', async () => {
  const { petitionEvent, sig1, sig2, deletion } = seedDb(db);
  const pool = new FakePool();
  const republisher = new ArchivalRepublisher(makeConfig(), db, { pool });

  const summary = await republisher.republishPending();

  assert.equal(summary.published, 4);
  assert.equal(summary.failed, 0);
  assert.equal(pool.published.length, 4);

  const byId = new Map(pool.published.map((p) => [p.event.id, p.event]));
  // Verbatim: republished events deep-equal the original signed JSON.
  assert.deepEqual(byId.get(petitionEvent.id), petitionEvent);
  assert.deepEqual(byId.get(sig1.id), sig1);
  assert.deepEqual(byId.get(sig2.id), sig2); // revoked but still archived
  assert.deepEqual(byId.get(deletion.id), deletion);
  assert.ok(pool.published.every((p) => p.relay === ARCHIVE_RELAY));
});

test('does not re-publish already archived events on subsequent cycles', async () => {
  seedDb(db);
  const pool = new FakePool();
  const republisher = new ArchivalRepublisher(makeConfig(), db, { pool });

  const first = await republisher.republishPending();
  assert.equal(first.published, 4);

  const second = await republisher.republishPending();
  assert.equal(second.published, 0);
  assert.equal(second.already, 4);
  assert.equal(pool.published.length, 4); // no new publishes
});

test('records failures with backoff and retries when due', async () => {
  const { sig1 } = seedDb(db);
  const pool = new FakePool({ reject: { [ARCHIVE_RELAY]: 'restricted: not on whitelist' } });
  const republisher = new ArchivalRepublisher(makeConfig(), db, { pool });

  const first = await republisher.republishPending();
  assert.equal(first.failed, 4);
  assert.equal(first.published, 0);

  const state = db.getArchivalState(sig1.id, ARCHIVE_RELAY);
  assert.equal(state.status, 'failed');
  assert.equal(state.attempts, 1);
  assert.match(state.last_error, /restricted/);
  assert.ok(state.next_attempt_at > Math.floor(Date.now() / 1000));

  // Backoff defers immediate retry.
  const second = await republisher.republishPending();
  assert.equal(second.deferred, 4);
  assert.equal(second.failed, 0);

  // Relay policy fixed + backoff elapsed: force next_attempt_at into the past.
  pool.reject = {};
  db.db.prepare('UPDATE archival_republish SET next_attempt_at = 0').run();
  const third = await republisher.republishPending();
  assert.equal(third.published, 4);

  const recovered = db.getArchivalState(sig1.id, ARCHIVE_RELAY);
  assert.equal(recovered.status, 'published');
  assert.equal(recovered.last_error, null);
});

test('failure on one relay does not block another', async () => {
  seedDb(db);
  const goodRelay = 'wss://good.archive.example';
  const pool = new FakePool({ reject: { [ARCHIVE_RELAY]: 'auth-required: nope' } });
  const republisher = new ArchivalRepublisher(makeConfig({ relays: [ARCHIVE_RELAY, goodRelay] }), db, { pool });

  const summary = await republisher.republishPending();
  assert.equal(summary.failed, 4);
  assert.equal(summary.published, 4);
  assert.ok(pool.published.every((p) => p.relay === goodRelay));
});

test('disabled when archival config is absent or republish is false', async () => {
  seedDb(db);
  const pool = new FakePool();

  const noBlock = new ArchivalRepublisher({ petition: { a_tag: A_TAG, relays: [] } }, db, { pool });
  assert.equal(noBlock.enabled, false);
  assert.equal(await noBlock.republishPending(), null);

  const off = new ArchivalRepublisher(makeConfig({ republish: false }), db, { pool });
  assert.equal(off.enabled, false);
  assert.equal(await off.republishPending(), null);

  const emptyRelays = new ArchivalRepublisher(makeConfig({ relays: [] }), db, { pool });
  assert.equal(emptyRelays.enabled, false);

  assert.equal(pool.published.length, 0);
});

test('dry run logs but neither publishes nor records state', async () => {
  const { sig1 } = seedDb(db);
  const pool = new FakePool();
  const republisher = new ArchivalRepublisher(makeConfig({ dry_run: true }), db, { pool });

  const summary = await republisher.republishPending();
  assert.equal(summary.dry_run, true);
  assert.equal(summary.published, 4); // "would publish" count
  assert.equal(pool.published.length, 0);
  assert.equal(db.getArchivalState(sig1.id, ARCHIVE_RELAY), null);
});

test('skips malformed raw_event rows without crashing', async () => {
  seedDb(db);
  db.upsertSignature({
    id: 'f'.repeat(64),
    pubkey: 'f'.repeat(64),
    petition_a_tag: A_TAG,
    content_hash: 'e'.repeat(64),
    entity_type: 'human',
    statement: '',
    content: '',
    created_at: 1750000010,
    raw_event: 'not-json{{{',
    verified: 1,
    revoked: 0,
    zapped: 0
  });

  const pool = new FakePool();
  const republisher = new ArchivalRepublisher(makeConfig(), db, { pool });
  const summary = await republisher.republishPending();

  assert.equal(summary.candidates, 4); // malformed row excluded
  assert.equal(summary.published, 4);
});
