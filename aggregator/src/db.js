import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export class SignumDatabase {
  constructor(dbPath) {
    const resolved = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma('journal_mode = WAL');
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS petition (
        a_tag TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        pubkey TEXT NOT NULL,
        d_tag TEXT NOT NULL,
        title TEXT,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        published_at INTEGER,
        raw_event TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS signatures (
        id TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL,
        petition_a_tag TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        entity_type TEXT,
        statement TEXT,
        content TEXT,
        created_at INTEGER NOT NULL,
        raw_event TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0,
        revoked INTEGER NOT NULL DEFAULT 0,
        zapped INTEGER NOT NULL DEFAULT 0,
        UNIQUE(pubkey, petition_a_tag)
      );

      CREATE INDEX IF NOT EXISTS idx_signatures_petition ON signatures(petition_a_tag);
      CREATE INDEX IF NOT EXISTS idx_signatures_pubkey ON signatures(pubkey);
      CREATE INDEX IF NOT EXISTS idx_signatures_created ON signatures(created_at);

      CREATE TABLE IF NOT EXISTS deletions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deletion_event_id TEXT NOT NULL,
        target_event_id TEXT NOT NULL,
        author_pubkey TEXT NOT NULL,
        petition_a_tag TEXT,
        created_at INTEGER NOT NULL,
        raw_event TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_deletions_target ON deletions(target_event_id);
      CREATE INDEX IF NOT EXISTS idx_deletions_author ON deletions(author_pubkey);

      CREATE TABLE IF NOT EXISTS profiles (
        pubkey TEXT PRIMARY KEY,
        display_name TEXT,
        name TEXT,
        nip05 TEXT,
        picture TEXT,
        lud06 TEXT,
        lud16 TEXT,
        about TEXT,
        raw_event TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS follow_graph (
        pubkey TEXT PRIMARY KEY,
        follows TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS zap_receipts (
        event_id TEXT PRIMARY KEY,
        signature_event_id TEXT NOT NULL,
        recipient_pubkey TEXT,
        amount_msats INTEGER,
        raw_event TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_zap_receipts_signature ON zap_receipts(signature_event_id);

      CREATE TABLE IF NOT EXISTS trust_assertions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_pubkey TEXT NOT NULL,
        provider_pubkey TEXT NOT NULL,
        score INTEGER,
        raw_event TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(subject_pubkey, provider_pubkey)
      );

      CREATE INDEX IF NOT EXISTS idx_trust_subject ON trust_assertions(subject_pubkey);
    `);

    this._prepareStatements();
  }

  _prepareStatements() {
    this.stmts = {
      upsertPetition: this.db.prepare(`
        INSERT INTO petition (a_tag, event_id, pubkey, d_tag, title, content, content_hash, published_at, raw_event)
        VALUES (:a_tag, :event_id, :pubkey, :d_tag, :title, :content, :content_hash, :published_at, :raw_event)
        ON CONFLICT(a_tag) DO UPDATE SET
          event_id = excluded.event_id,
          pubkey = excluded.pubkey,
          d_tag = excluded.d_tag,
          title = excluded.title,
          content = excluded.content,
          content_hash = excluded.content_hash,
          published_at = excluded.published_at,
          raw_event = excluded.raw_event,
          updated_at = unixepoch()
      `),
      getPetition: this.db.prepare('SELECT * FROM petition WHERE a_tag = ?'),
      upsertSignature: this.db.prepare(`
        INSERT INTO signatures (id, pubkey, petition_a_tag, content_hash, entity_type, statement, content, created_at, raw_event, verified, revoked, zapped)
        VALUES (:id, :pubkey, :petition_a_tag, :content_hash, :entity_type, :statement, :content, :created_at, :raw_event, :verified, :revoked, :zapped)
        ON CONFLICT(pubkey, petition_a_tag) DO UPDATE SET
          id = excluded.id,
          content_hash = excluded.content_hash,
          entity_type = excluded.entity_type,
          statement = excluded.statement,
          content = excluded.content,
          created_at = excluded.created_at,
          raw_event = excluded.raw_event,
          verified = excluded.verified,
          revoked = excluded.revoked,
          zapped = excluded.zapped
        WHERE excluded.created_at > signatures.created_at
      `),
      getSignaturesForPetition: this.db.prepare('SELECT * FROM signatures WHERE petition_a_tag = ? ORDER BY created_at DESC'),
      markRevoked: this.db.prepare('UPDATE signatures SET revoked = 1 WHERE id = ?'),
      insertDeletion: this.db.prepare(`
        INSERT INTO deletions (deletion_event_id, target_event_id, author_pubkey, petition_a_tag, created_at, raw_event)
        VALUES (:deletion_event_id, :target_event_id, :author_pubkey, :petition_a_tag, :created_at, :raw_event)
      `),
      findDeletion: this.db.prepare('SELECT 1 FROM deletions WHERE target_event_id = ? AND author_pubkey = ? LIMIT 1'),
      upsertProfile: this.db.prepare(`
        INSERT INTO profiles (pubkey, display_name, name, nip05, picture, lud06, lud16, about, raw_event)
        VALUES (:pubkey, :display_name, :name, :nip05, :picture, :lud06, :lud16, :about, :raw_event)
        ON CONFLICT(pubkey) DO UPDATE SET
          display_name = excluded.display_name,
          name = excluded.name,
          nip05 = excluded.nip05,
          picture = excluded.picture,
          lud06 = excluded.lud06,
          lud16 = excluded.lud16,
          about = excluded.about,
          raw_event = excluded.raw_event,
          updated_at = unixepoch()
      `),
      getProfile: this.db.prepare('SELECT * FROM profiles WHERE pubkey = ?'),
      upsertFollowGraph: this.db.prepare(`
        INSERT INTO follow_graph (pubkey, follows) VALUES (:pubkey, :follows)
        ON CONFLICT(pubkey) DO UPDATE SET follows = excluded.follows, updated_at = unixepoch()
      `),
      getFollowGraph: this.db.prepare('SELECT pubkey, follows FROM follow_graph'),
      upsertZapReceipt: this.db.prepare(`
        INSERT INTO zap_receipts (event_id, signature_event_id, recipient_pubkey, amount_msats, raw_event, created_at)
        VALUES (:event_id, :signature_event_id, :recipient_pubkey, :amount_msats, :raw_event, :created_at)
        ON CONFLICT(event_id) DO UPDATE SET
          signature_event_id = excluded.signature_event_id,
          recipient_pubkey = excluded.recipient_pubkey,
          amount_msats = excluded.amount_msats,
          raw_event = excluded.raw_event,
          created_at = excluded.created_at
      `),
      getZapReceiptsForSignature: this.db.prepare('SELECT * FROM zap_receipts WHERE signature_event_id = ?'),
      upsertTrustAssertion: this.db.prepare(`
        INSERT INTO trust_assertions (subject_pubkey, provider_pubkey, score, raw_event, created_at)
        VALUES (:subject_pubkey, :provider_pubkey, :score, :raw_event, :created_at)
        ON CONFLICT(subject_pubkey, provider_pubkey) DO UPDATE SET
          score = excluded.score,
          raw_event = excluded.raw_event,
          created_at = excluded.created_at
      `),
      getTrustAssertionsForSubject: this.db.prepare('SELECT * FROM trust_assertions WHERE subject_pubkey = ?')
    };
  }

  upsertPetition(petition) {
    this.stmts.upsertPetition.run(petition);
  }

  getPetition(aTag) {
    return this.stmts.getPetition.get(aTag) || null;
  }

  upsertSignature(sig) {
    this.stmts.upsertSignature.run(sig);
  }

  getSignaturesForPetition(aTag) {
    return this.stmts.getSignaturesForPetition.all(aTag);
  }

  markRevoked(eventId) {
    this.stmts.markRevoked.run(eventId);
  }

  recordDeletion(deletion) {
    this.stmts.insertDeletion.run(deletion);
  }

  hasDeletion(targetEventId, authorPubkey) {
    return !!this.stmts.findDeletion.get(targetEventId, authorPubkey);
  }

  upsertProfile(profile) {
    this.stmts.upsertProfile.run(profile);
  }

  getProfile(pubkey) {
    return this.stmts.getProfile.get(pubkey) || null;
  }

  upsertFollowGraph(pubkey, follows) {
    this.stmts.upsertFollowGraph.run({ pubkey, follows: JSON.stringify(follows) });
  }

  getFollowGraph() {
    const rows = this.stmts.getFollowGraph.all();
    const graph = new Map();
    for (const row of rows) {
      try {
        graph.set(row.pubkey, JSON.parse(row.follows));
      } catch {
        graph.set(row.pubkey, []);
      }
    }
    return graph;
  }

  upsertZapReceipt(receipt) {
    this.stmts.upsertZapReceipt.run(receipt);
  }

  getZapReceiptsForSignature(eventId) {
    return this.stmts.getZapReceiptsForSignature.all(eventId);
  }

  upsertTrustAssertion(assertion) {
    this.stmts.upsertTrustAssertion.run(assertion);
  }

  getTrustAssertionsForSubject(pubkey) {
    return this.stmts.getTrustAssertionsForSubject.all(pubkey);
  }

  close() {
    this.db.close();
  }
}
