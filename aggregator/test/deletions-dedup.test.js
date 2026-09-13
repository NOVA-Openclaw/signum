import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SignumDatabase } from '../src/db.js';

const A_TAG = '30023:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:test-petition';
const DEL_ID = '9'.repeat(64);
const TARGET = 'a'.repeat(64);

function deletionRow(overrides = {}) {
  return {
    deletion_event_id: DEL_ID,
    target_event_id: TARGET,
    author_pubkey: 'b'.repeat(64),
    petition_a_tag: A_TAG,
    created_at: 1750000000,
    raw_event: JSON.stringify({ id: DEL_ID, kind: 5, tags: [['e', TARGET], ['a', A_TAG]] }),
    ...overrides
  };
}

/** Legacy schema: the pre-dedup deletions table, with no unique constraint. */
function createLegacyDb(dbPath, rows) {
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deletion_event_id TEXT NOT NULL,
      target_event_id TEXT NOT NULL,
      author_pubkey TEXT NOT NULL,
      petition_a_tag TEXT,
      created_at INTEGER NOT NULL,
      raw_event TEXT NOT NULL
    );
  `);
  const stmt = raw.prepare(`
    INSERT INTO deletions (deletion_event_id, target_event_id, author_pubkey, petition_a_tag, created_at, raw_event)
    VALUES (:deletion_event_id, :target_event_id, :author_pubkey, :petition_a_tag, :created_at, :raw_event)
  `);
  for (const row of rows) stmt.run(row);
  raw.close();
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signum-deletions-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('repeated polls of the same kind:5 event store exactly one row', (t) => {
  const db = new SignumDatabase(path.join(tmpDir, 'test.db'));
  t.after(() => db.close());

  // A kind:5 tagged with both `a` and `e` matches two relay queries per
  // cycle, so a handful of cycles previously produced a handful of rows.
  for (let cycle = 0; cycle < 6; cycle++) db.recordDeletion(deletionRow());

  const count = db.db.prepare('SELECT COUNT(*) AS c FROM deletions').get().c;
  assert.equal(count, 1);
  assert.equal(db.hasDeletion(TARGET, 'b'.repeat(64)), true);
});

test('a multi-target kind:5 keeps one row per target and stays idempotent', (t) => {
  const db = new SignumDatabase(path.join(tmpDir, 'test.db'));
  t.after(() => db.close());

  const targets = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)];
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const target_event_id of targets) {
      db.recordDeletion(deletionRow({ target_event_id }));
    }
  }

  const stored = db.db
    .prepare('SELECT target_event_id FROM deletions ORDER BY target_event_id')
    .all()
    .map((r) => r.target_event_id);
  assert.deepEqual(stored, targets);
  for (const target of targets) {
    assert.equal(db.hasDeletion(target, 'b'.repeat(64)), true);
  }
});

test('migration collapses pre-existing duplicates, keeping the earliest row', (t) => {
  const dbPath = path.join(tmpDir, 'legacy.db');
  const dupes = [];
  for (let i = 0; i < 6; i++) dupes.push(deletionRow());
  for (let i = 0; i < 4; i++) dupes.push(deletionRow({ deletion_event_id: 'c'.repeat(64), target_event_id: '1'.repeat(64) }));
  createLegacyDb(dbPath, dupes);

  const db = new SignumDatabase(dbPath);
  t.after(() => db.close());

  const rows = db.db.prepare('SELECT id, deletion_event_id, target_event_id FROM deletions ORDER BY id').all();
  assert.equal(rows.length, 2, 'duplicates collapsed to one row per (event, target)');
  assert.equal(rows[0].id, 1, 'earliest row retained');
  assert.equal(rows[0].deletion_event_id, DEL_ID);

  // Constraint is live after migration, so later polls no longer duplicate.
  db.recordDeletion(deletionRow());
  assert.equal(db.db.prepare('SELECT COUNT(*) AS c FROM deletions').get().c, 2);
});

test('migration is idempotent across reopens of the same database', (t) => {
  const dbPath = path.join(tmpDir, 'legacy.db');
  createLegacyDb(dbPath, [deletionRow(), deletionRow(), deletionRow()]);

  const first = new SignumDatabase(dbPath);
  first.close();

  const second = new SignumDatabase(dbPath);
  t.after(() => second.close());
  assert.equal(second.db.prepare('SELECT COUNT(*) AS c FROM deletions').get().c, 1);
});

test('archival work items are unaffected by repeated polling', (t) => {
  const db = new SignumDatabase(path.join(tmpDir, 'test.db'));
  t.after(() => db.close());

  for (let cycle = 0; cycle < 5; cycle++) db.recordDeletion(deletionRow());
  assert.equal(db.getDeletionsForPetition(A_TAG).length, 1);
});
