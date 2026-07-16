import { SimplePool } from 'nostr-tools';
import { withTimeout } from './utils.js';

const PUBLISH_TIMEOUT_MS = 15000;
const BASE_BACKOFF_SECONDS = 300; // one default poll cycle
const MAX_BACKOFF_SECONDS = 6 * 60 * 60; // 6 hours

/**
 * Republishes accepted petition events verbatim to configured archival relays.
 *
 * Archival is about evidence preservation, not scoring: every event the
 * aggregator accepted as valid (NIP-01 signature verified, a-tag matches the
 * petition) is archived — including revoked signatures and the kind:5
 * deletion events that revoked them, so the archive is self-contained and
 * its revocation state independently reconstructable.
 *
 * Events are republished as the original signed JSON stored at ingestion
 * time (raw_event). Event ids and signatures are never modified.
 *
 * Republish state is tracked in SQLite per (event, relay) so restarts do not
 * re-spam relays. Failures are retried on later poll cycles with exponential
 * backoff. Relays that reject writes (auth/whitelist/restricted) are logged
 * clearly and never crash the poll loop.
 */
export class ArchivalRepublisher {
  constructor(config, db, { pool } = {}) {
    const archival = config.archival || {};
    this.relays = Array.isArray(archival.relays)
      ? archival.relays.filter((r) => typeof r === 'string' && /^wss?:\/\//i.test(r))
      : [];
    this.enabled = this.relays.length > 0 && archival.republish !== false;
    this.dryRun = archival.dry_run === true;
    this.config = config;
    this.db = db;
    this.pool = pool || (this.enabled ? new SimplePool() : null);
    this.ownsPool = !pool;
  }

  /**
   * Collect every archivable event for the configured petition:
   * the petition event itself, all accepted signature events (revoked
   * included), and all recorded deletion (revocation) events.
   */
  collectArchivableEvents() {
    const aTag = this.config.petition.a_tag;
    const items = [];

    const petition = this.db.getPetition(aTag);
    if (petition?.raw_event) {
      const event = this._parseRaw(petition.raw_event, 'petition');
      if (event) items.push({ label: 'petition', event });
    }

    for (const sig of this.db.getSignaturesForPetition(aTag)) {
      const event = this._parseRaw(sig.raw_event, `signature ${sig.id}`);
      if (event) items.push({ label: 'signature', event });
    }

    for (const del of this.db.getDeletionsForPetition(aTag)) {
      const event = this._parseRaw(del.raw_event, `deletion ${del.deletion_event_id}`);
      if (event) items.push({ label: 'deletion', event });
    }

    return items;
  }

  /**
   * Republish everything not yet archived (or due for retry) to each
   * archival relay. Returns a summary object; never throws for per-event
   * or per-relay failures.
   */
  async republishPending() {
    if (!this.enabled) return null;

    const now = Math.floor(Date.now() / 1000);
    const items = this.collectArchivableEvents();
    const summary = { relays: this.relays.length, candidates: items.length, published: 0, already: 0, deferred: 0, failed: 0, dry_run: this.dryRun };

    for (const relay of this.relays) {
      for (const { label, event } of items) {
        const state = this.db.getArchivalState(event.id, relay);
        if (state?.status === 'published') {
          summary.already++;
          continue;
        }
        if (state && state.next_attempt_at > now) {
          summary.deferred++;
          continue;
        }
        if (this.dryRun) {
          console.log(`[archival] DRY RUN — would publish ${label} ${event.id} to ${relay}`);
          summary.published++;
          continue;
        }
        try {
          await this._publish(event, relay);
          this.db.markArchivalPublished(event.id, relay);
          summary.published++;
          console.log(`[archival] Published ${label} ${event.id} to ${relay}`);
        } catch (err) {
          const attempts = (state?.attempts ?? 0) + 1;
          const backoff = Math.min(BASE_BACKOFF_SECONDS * 2 ** Math.min(attempts - 1, 10), MAX_BACKOFF_SECONDS);
          this.db.markArchivalFailed(event.id, relay, err.message, now + backoff);
          summary.failed++;
          const hint = this._rejectionHint(err.message);
          console.warn(`[archival] Failed to publish ${label} ${event.id} to ${relay}: ${err.message}${hint} (attempt ${attempts}, retry in ${backoff}s)`);
        }
      }
    }

    if (summary.published || summary.failed) {
      console.log(`[archival] Cycle summary: ${summary.published} published, ${summary.already} already archived, ${summary.deferred} deferred, ${summary.failed} failed across ${summary.relays} relay(s)${summary.dry_run ? ' [dry run]' : ''}`);
    }
    return summary;
  }

  async _publish(event, relay) {
    const promises = this.pool.publish([relay], event);
    await withTimeout(Promise.all(promises), PUBLISH_TIMEOUT_MS, `archival publish to ${relay}`);
  }

  _parseRaw(raw, label) {
    try {
      const event = JSON.parse(raw);
      if (!event?.id || !event?.sig) {
        console.warn(`[archival] Skipping ${label}: stored raw_event missing id/sig`);
        return null;
      }
      return event;
    } catch {
      console.warn(`[archival] Skipping ${label}: stored raw_event is not valid JSON`);
      return null;
    }
  }

  _rejectionHint(message) {
    const m = (message || '').toLowerCase();
    if (m.includes('auth-required') || m.includes('restricted') || m.includes('blocked') || m.includes('not allowed') || m.includes('pow:')) {
      return ' — relay write policy rejected the event; if this is a whitelist-only relay, its policy must accept third-party-authored events for your petition (see docs/archival-relays.md)';
    }
    return '';
  }

  async close() {
    if (this.pool && this.ownsPool) {
      try {
        this.pool.close(this.relays);
      } catch {
        // ignore
      }
    }
  }
}
