import fs from 'node:fs';
import path from 'node:path';
import { toNpub } from './utils.js';

export class OutputWriter {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    this.outputPath = path.resolve(config.output?.path || './output/signatures.json');
  }

  write(scoredSignatures, methodology) {
    fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });

    const petition = this.db.getPetition(this.config.petition.a_tag);
    const now = new Date().toISOString();

    const signatures = scoredSignatures.map((s) => this._toOutputSignature(s));

    const chronological = [...signatures].sort((a, b) => {
      if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
      return b.event_id.localeCompare(a.event_id);
    });

    const trustWeighted = [...signatures].sort((a, b) => {
      if (b.trust_score !== a.trust_score) return b.trust_score - a.trust_score;
      if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
      return b.event_id.localeCompare(a.event_id);
    });

    const qualifyingCount = signatures.filter((s) => s.trust_score >= methodology.threshold).length;
    const gatedCount = signatures.length - qualifyingCount;

    const output = {
      petition_title: petition?.title || '',
      petition_d_tag: petition?.d_tag || '',
      petition_a_tag: this.config.petition.a_tag,
      petition_event_id: petition?.event_id || null,
      total_signatures: signatures.length,
      qualifying_signatures: qualifyingCount,
      gated_count: gatedCount,
      threshold: methodology.threshold,
      trust_methodology: methodology,
      last_updated: now,
      signatures_chronological: chronological,
      signatures_trust_weighted: trustWeighted
    };

    const tmpPath = `${this.outputPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(output, null, 2));
    fs.renameSync(tmpPath, this.outputPath);

    console.log(`[output] Wrote ${signatures.length} signatures to ${this.outputPath}`);
    return output;
  }

  _toOutputSignature(scored) {
    const profile = scored.profile || {};
    const displayName = profile.display_name || profile.name || '';
    return {
      pubkey: scored.pubkey,
      npub: toNpub(scored.pubkey),
      display_name: displayName,
      nip05: profile.nip05 || null,
      entity_type: scored.entity_type || 'uncertain',
      statement: scored.statement || '',
      trust_score: scored.trust_score,
      trust_breakdown: scored.trust_breakdown,
      timestamp: scored.created_at,
      event_id: scored.id,
      zapped: scored.zapped === 1 || scored.zapped === true
    };
  }
}
