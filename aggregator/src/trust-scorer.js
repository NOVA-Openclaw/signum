import { parseATag, isValidPubkey, sleep, withRetry } from './utils.js';

const NIP05_TIMEOUT_MS = 10000;
const HISTORY_LIMIT = 500;

export class TrustScorer {
  constructor(config, db, poller) {
    this.config = config;
    this.db = db;
    this.poller = poller;
    this.weights = config.trust.weights || {};
    this.threshold = config.trust.threshold ?? 25;
    this.seedPubkeys = (config.trust.seed_pubkeys || []).filter(isValidPubkey);
    this.nip85Provider = config.trust.nip85_provider;
  }

  async scoreSignatures(signatures) {
    const pubkeys = signatures.map((s) => s.pubkey);
    const sigEventIds = signatures.map((s) => s.id);

    await this.poller.fetchProfiles(pubkeys);
    await this.poller.fetchFollowGraphs([...pubkeys, ...this.seedPubkeys]);
    await this.poller.fetchZapReceipts(sigEventIds);
    await this.poller.fetchNip85Assertions(pubkeys);

    const followDistances = this._computeFollowDistances(pubkeys);
    const historyCache = new Map();
    const nip05Cache = new Map();

    const scored = [];
    for (const sig of signatures) {
      const pubkey = sig.pubkey;
      const profile = this.db.getProfile(pubkey);

      let nip05Score = nip05Cache.get(pubkey);
      if (nip05Score === undefined) {
        nip05Score = await this._scoreNip05(profile);
        nip05Cache.set(pubkey, nip05Score);
      }

      let historyScore = historyCache.get(pubkey);
      if (historyScore === undefined) {
        historyScore = await this._scoreHistory(pubkey);
        historyCache.set(pubkey, historyScore);
      }

      const followDistance = followDistances.get(pubkey) ?? -1;
      const followScore = this._distanceToScore(followDistance);
      const zapScore = this._scoreZap(sig.id);
      const nip85Score = this._scoreNip85(pubkey);

      const breakdown = {
        nip05: nip05Score,
        follow_distance: followScore,
        history: historyScore,
        zap: zapScore,
        nip85: nip85Score,
        follow_hops: followDistance >= 0 ? followDistance : null
      };

      const composite = this._computeComposite(breakdown);

      scored.push({
        ...sig,
        profile,
        trust_score: composite,
        trust_breakdown: breakdown,
        qualifying: composite >= this.threshold
      });
    }

    return scored;
  }

  async _scoreNip05(profile) {
    if (!profile?.nip05) return 0;
    const identifier = profile.nip05.trim().toLowerCase();
    if (!identifier.includes('@')) return 0;
    try {
      const [name, domain] = identifier.split('@');
      const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
      const res = await withRetry(
        () => fetch(url, { signal: AbortSignal.timeout(NIP05_TIMEOUT_MS) }),
        { maxAttempts: 2, label: `NIP-05 ${identifier}` }
      );
      if (!res.ok) {
        console.warn(`[trust] NIP-05 lookup failed for ${identifier}: ${res.status}`);
        return 0;
      }
      const data = await res.json();
      const names = data.names || {};
      const resolved = names[name];
      if (resolved && resolved.toLowerCase() === profile.pubkey.toLowerCase()) {
        return 100;
      }
      return 0;
    } catch (err) {
      console.warn(`[trust] NIP-05 error for ${profile.nip05}: ${err.message}`);
      return 0;
    }
  }

  _computeFollowDistances(targetPubkeys) {
    const distances = new Map();
    if (this.seedPubkeys.length === 0 || targetPubkeys.length === 0) {
      return distances;
    }

    const graph = this.db.getFollowGraph();
    const visited = new Set(this.seedPubkeys);
    let frontier = [...this.seedPubkeys];
    let depth = 0;

    while (frontier.length > 0 && depth < 3) {
      depth++;
      const nextFrontier = [];
      for (const pubkey of frontier) {
        const follows = graph.get(pubkey) || [];
        for (const followed of follows) {
          if (visited.has(followed)) continue;
          visited.add(followed);
          nextFrontier.push(followed);
          if (targetPubkeys.includes(followed) && !distances.has(followed)) {
            distances.set(followed, depth);
          }
        }
      }
      frontier = nextFrontier;
    }

    return distances;
  }

  _distanceToScore(distance) {
    if (distance === 1) return 90;
    if (distance === 2) return 60;
    if (distance === 3) return 30;
    return 0;
  }

  async _scoreHistory(pubkey) {
    try {
      const events = await this.poller.pool.querySync(
        this.config.petition.relays,
        { authors: [pubkey], limit: HISTORY_LIMIT },
        { maxWait: 10000 }
      );
      if (events.length === 0) return 0;
      const kinds = new Set(events.map((e) => e.kind));
      const earliest = Math.min(...events.map((e) => e.created_at));
      const now = Math.floor(Date.now() / 1000);
      const ageMonths = Math.max(0, (now - earliest) / (30 * 24 * 60 * 60));
      const score = Math.min(100, ageMonths * 5 + events.length * 0.5 + kinds.size * 10);
      return Math.round(score);
    } catch (err) {
      console.warn(`[trust] History query failed for ${pubkey}: ${err.message}`);
      return 0;
    }
  }

  _scoreZap(signatureEventId) {
    const receipts = this.db.getZapReceiptsForSignature(signatureEventId);
    return receipts.length > 0 ? 100 : 0;
  }

  _scoreNip85(pubkey) {
    if (!this.nip85Provider) return 0;
    const assertions = this.db.getTrustAssertionsForSubject(pubkey);
    const match = assertions.find((a) => a.provider_pubkey === this.nip85Provider);
    return match?.score ?? 0;
  }

  _computeComposite(breakdown) {
    const weights = {
      nip05: this.weights.nip05 ?? 20,
      follow_distance: this.weights.follow_distance ?? 30,
      history: this.weights.history ?? 20,
      zap: this.weights.zap ?? 15,
      nip85: this.weights.nip85 ?? 15
    };

    let totalWeight = 0;
    let weightedSum = 0;
    for (const key of Object.keys(weights)) {
      const score = breakdown[key];
      if (typeof score === 'number') {
        weightedSum += score * weights[key];
        totalWeight += weights[key];
      }
    }

    if (totalWeight === 0) return 0;
    return Math.round(weightedSum / totalWeight);
  }

  getMethodology() {
    return {
      weights: {
        nip05: this.weights.nip05 ?? 20,
        follow_distance: this.weights.follow_distance ?? 30,
        history: this.weights.history ?? 20,
        zap: this.weights.zap ?? 15,
        nip85: this.weights.nip85 ?? 15
      },
      threshold: this.threshold,
      seed_pubkeys: this.seedPubkeys,
      nip85_provider: this.nip85Provider || null,
      relays: this.config.petition.relays,
      description:
        'Composite trust score is a weighted average of available 0-100 sub-scores. ' +
        'NIP-05 verifies the signer\'s declared identifier resolves to their pubkey. ' +
        'Follow distance is the shortest hop from a curated seed pubkey to the signer via kind:3 follows (cap 3). ' +
        'History scores account age, event count, and kind diversity. ' +
        'Zap verification checks for kind:9735 receipts referencing the signature event. ' +
        'NIP-85 pulls trust assertions from the configured provider.'
    };
  }
}
