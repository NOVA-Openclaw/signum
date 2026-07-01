import { SimplePool, verifyEvent } from 'nostr-tools';
import { getTag, getTags, parseATag, sha256Hex, sleep } from './utils.js';

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_PROFILE_BATCH = 256;
const MAX_FOLLOW_BATCH = 128;
const MAX_ZAP_BATCH = 128;
const MAX_NIP85_BATCH = 128;

export class RelayPoller {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    this.relays = config.petition.relays || [];
    this.parsedATag = parseATag(config.petition.a_tag);
    this.pool = new SimplePool({ eoseSubTimeout: DEFAULT_TIMEOUT_MS });
    this.shutdown = false;
  }

  async fetchPetition() {
    if (!this.parsedATag) {
      throw new Error(`Invalid petition a_tag: ${this.config.petition.a_tag}`);
    }
    const { kind, pubkey, dTag } = this.parsedATag;
    const filter = { kinds: [kind], authors: [pubkey], '#d': [dTag] };
    const events = await this._queryRelays(filter, 'petition');
    if (events.length === 0) {
      console.warn(`[poller] No petition event found for ${this.config.petition.a_tag}`);
      return null;
    }
    const event = this._pickLatest(events);
    if (!verifyEvent(event)) {
      console.warn(`[poller] Petition event failed signature verification: ${event.id}`);
      return null;
    }
    const contentHash = sha256Hex(event.content);
    const petition = {
      a_tag: this.config.petition.a_tag,
      event_id: event.id,
      pubkey: event.pubkey,
      d_tag: getTag(event, 'd') || dTag,
      title: getTag(event, 'title') || '',
      content: event.content,
      content_hash: contentHash,
      published_at: Number(getTag(event, 'published_at')) || event.created_at,
      raw_event: JSON.stringify(event)
    };
    this.db.upsertPetition(petition);
    console.log(`[poller] Petition fetched: ${event.id} (${contentHash})`);
    return petition;
  }

  async fetchSignaturesAndDeletions() {
    const signatureFilter = {
      kinds: [1791],
      '#a': [this.config.petition.a_tag]
    };
    const deletionFilter = {
      kinds: [5],
      '#a': [this.config.petition.a_tag]
    };
    let [signatureEvents, deletionEvents] = await Promise.all([
      this._queryRelays(signatureFilter, 'signatures'),
      this._queryRelays(deletionFilter, 'deletions')
    ]);

    const petition = this.db.getPetition(this.config.petition.a_tag);
    const expectedContentHash = petition?.content_hash;

    const processed = [];
    for (const event of signatureEvents) {
      const result = await this._processSignature(event, expectedContentHash);
      if (result) processed.push(result);
    }

    // Also fetch deletions by signature event id for completeness.
    const sigIds = processed.map((s) => s.id);
    if (sigIds.length > 0) {
      const extraDeletionEvents = await this._queryRelays(
        { kinds: [5], '#e': sigIds },
        'deletions-by-sig'
      );
      deletionEvents = deletionEvents.concat(extraDeletionEvents);
    }

    for (const event of deletionEvents) {
      await this._processDeletion(event);
    }

    // Re-apply any deletions that targeted signatures discovered this cycle.
    for (const event of deletionEvents) {
      if (!verifyEvent(event)) continue;
      for (const targetId of getTags(event, 'e')) {
        this.db.markRevoked(targetId);
      }
    }

    console.log(`[poller] Processed ${processed.length} valid signatures`);
    return processed;
  }

  async _processDeletion(event) {
    if (!verifyEvent(event)) return;
    const eTags = getTags(event, 'e');
    for (const targetId of eTags) {
      this.db.recordDeletion({
        deletion_event_id: event.id,
        target_event_id: targetId,
        author_pubkey: event.pubkey,
        petition_a_tag: getTag(event, 'a') || this.config.petition.a_tag,
        created_at: event.created_at,
        raw_event: JSON.stringify(event)
      });
      this.db.markRevoked(targetId);
    }
  }

  async _processSignature(event, expectedContentHash) {
    if (!verifyEvent(event)) {
      console.warn(`[poller] Signature failed verification: ${event.id}`);
      return null;
    }
    const aTag = getTag(event, 'a');
    if (aTag !== this.config.petition.a_tag) return null;

    const contentHash = getTag(event, 'content_hash');
    if (expectedContentHash && contentHash !== expectedContentHash) {
      console.warn(`[poller] Content hash mismatch for ${event.id}: got ${contentHash}, expected ${expectedContentHash}`);
      return null;
    }

    const revoked = event.tags.some((t) => t[0] === 'revoked' && t[1] === 'true');
    const isDeleted = this.db.hasDeletion(event.id, event.pubkey);

    const sig = {
      id: event.id,
      pubkey: event.pubkey,
      petition_a_tag: aTag,
      content_hash: contentHash || '',
      entity_type: getTag(event, 'entity_type') || 'uncertain',
      statement: getTag(event, 'statement') || event.content || '',
      content: event.content || '',
      created_at: event.created_at,
      raw_event: JSON.stringify(event),
      verified: 1,
      revoked: revoked || isDeleted ? 1 : 0,
      zapped: 0
    };
    this.db.upsertSignature(sig);
    return sig;
  }

  async fetchProfiles(pubkeys) {
    pubkeys = Array.from(new Set(pubkeys)).filter(Boolean);
    if (pubkeys.length === 0) return [];
    const batches = this._chunk(pubkeys, MAX_PROFILE_BATCH);
    const allProfiles = [];
    for (const batch of batches) {
      const events = await this._queryRelays({ kinds: [0], authors: batch }, 'profiles');
      for (const event of events) {
        if (!verifyEvent(event)) continue;
        const metadata = this._parseProfile(event);
        this.db.upsertProfile({
          pubkey: event.pubkey,
          display_name: metadata.display_name,
          name: metadata.name,
          nip05: metadata.nip05,
          picture: metadata.picture,
          lud06: metadata.lud06,
          lud16: metadata.lud16,
          about: metadata.about,
          raw_event: JSON.stringify(event)
        });
        allProfiles.push({ pubkey: event.pubkey, ...metadata });
      }
    }
    return allProfiles;
  }

  _parseProfile(event) {
    let parsed = {};
    try {
      parsed = JSON.parse(event.content);
    } catch {
      parsed = {};
    }
    return {
      display_name: parsed.display_name || parsed.displayName || parsed.name || '',
      name: parsed.name || '',
      nip05: parsed.nip05 || '',
      picture: parsed.picture || '',
      lud06: parsed.lud06 || '',
      lud16: parsed.lud16 || '',
      about: parsed.about || ''
    };
  }

  async fetchFollowGraphs(pubkeys) {
    pubkeys = Array.from(new Set(pubkeys)).filter(Boolean);
    if (pubkeys.length === 0) return new Map();
    const batches = this._chunk(pubkeys, MAX_FOLLOW_BATCH);
    for (const batch of batches) {
      const events = await this._queryRelays({ kinds: [3], authors: batch }, 'follow-graph');
      for (const event of events) {
        if (!verifyEvent(event)) continue;
        const follows = event.tags
          .filter((t) => t[0] === 'p')
          .map((t) => t[1])
          .filter(Boolean);
        this.db.upsertFollowGraph(event.pubkey, follows);
      }
    }
    return this.db.getFollowGraph();
  }

  async fetchZapReceipts(signatureEventIds) {
    signatureEventIds = Array.from(new Set(signatureEventIds)).filter(Boolean);
    if (signatureEventIds.length === 0) return [];
    const batches = this._chunk(signatureEventIds, MAX_ZAP_BATCH);
    const receipts = [];
    for (const batch of batches) {
      const events = await this._queryRelays({ kinds: [9735], '#e': batch }, 'zap-receipts');
      for (const event of events) {
        if (!verifyEvent(event)) continue;
        const sigId = getTag(event, 'e');
        const bolt11Tag = event.tags.find((t) => t[0] === 'bolt11');
        let amountMsats = 0;
        if (bolt11Tag && bolt11Tag[1]) {
          amountMsats = this._decodeBolt11Amount(bolt11Tag[1]);
        }
        const receipt = {
          event_id: event.id,
          signature_event_id: sigId,
          recipient_pubkey: event.tags.find((t) => t[0] === 'p')?.[1] || '',
          amount_msats: amountMsats,
          raw_event: JSON.stringify(event),
          created_at: event.created_at
        };
        this.db.upsertZapReceipt(receipt);
        receipts.push(receipt);
      }
    }
    return receipts;
  }

  _decodeBolt11Amount(bolt11) {
    try {
      const mMatch = bolt11.match(/(\d+)m/);
      if (mMatch) return Number(mMatch[1]) * 100000;
      const uMatch = bolt11.match(/(\d+)u/);
      if (uMatch) return Number(uMatch[1]) * 100;
      const nMatch = bolt11.match(/(\d+)n/);
      if (nMatch) return Number(nMatch[1]) / 10;
      const pMatch = bolt11.match(/(\d+)p/);
      if (pMatch) return Number(pMatch[1]) / 10000;
    } catch {
      // ignore
    }
    return 0;
  }

  async fetchNip85Assertions(pubkeys) {
    pubkeys = Array.from(new Set(pubkeys)).filter(Boolean);
    if (pubkeys.length === 0) return [];
    const provider = this.config.trust.nip85_provider;
    if (!provider) return [];

    const nip85Relay = 'wss://nip85.nostr.band';
    const batches = this._chunk(pubkeys, MAX_NIP85_BATCH);
    const allAssertions = [];
    for (const batch of batches) {
      try {
        const events = await this.pool.querySync(
          [nip85Relay],
          { kinds: [30382], authors: [provider], '#p': batch },
          { maxWait: DEFAULT_TIMEOUT_MS }
        );
        for (const event of events) {
          if (!verifyEvent(event)) continue;
          const subject = getTag(event, 'p');
          const score = this._extractNip85Score(event);
          if (!subject) continue;
          const assertion = {
            subject_pubkey: subject,
            provider_pubkey: event.pubkey,
            score,
            raw_event: JSON.stringify(event),
            created_at: event.created_at
          };
          this.db.upsertTrustAssertion(assertion);
          allAssertions.push(assertion);
        }
      } catch (err) {
        console.warn(`[poller] NIP-85 query failed: ${err.message}`);
      }
    }
    return allAssertions;
  }

  _extractNip85Score(event) {
    const scoreTag = event.tags.find((t) => t[0] === 'score');
    if (scoreTag && scoreTag[1]) {
      const n = Number.parseInt(scoreTag[1], 10);
      if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
    }
    try {
      const parsed = JSON.parse(event.content);
      if (typeof parsed.score === 'number') return Math.max(0, Math.min(100, parsed.score));
    } catch {
      // ignore
    }
    return 50;
  }

  async _queryRelays(filter, label) {
    if (this.shutdown) return [];
    try {
      const events = await this.pool.querySync(this.relays, filter, { maxWait: DEFAULT_TIMEOUT_MS });
      console.log(`[poller] ${label}: fetched ${events.length} events`);
      return events;
    } catch (err) {
      console.warn(`[poller] ${label} query failed: ${err.message}`);
      return [];
    }
  }

  _pickLatest(events) {
    return events.sort((a, b) => {
      if (a.created_at !== b.created_at) return b.created_at - a.created_at;
      return b.id.localeCompare(a.id);
    })[0];
  }

  _chunk(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  async close() {
    this.shutdown = true;
    try {
      this.pool.close();
    } catch {
      // ignore
    }
  }
}
