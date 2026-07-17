import fs from 'node:fs';

/**
 * Validation for aggregator output prior to deploy.
 *
 * Used by scripts/run-and-deploy.sh to guarantee a bad or partial
 * aggregator run never clobbers the last-good deployed signatures.json.
 *
 * Checks:
 *  - output is a JSON object with all required top-level keys
 *  - petition.a_tag is a non-empty `30023:<pubkey>:<d-tag>` reference
 *  - stats counts are coherent with the signature arrays
 *  - stats.last_updated parses as a date
 *  - against a previous (last-good) output, if provided:
 *      - the petition a_tag matches (guards against wrong-config deploys)
 *      - the signature count has not shrunk
 */

const REQUIRED_KEYS = [
  'petition',
  'stats',
  'trust_methodology',
  'signatures_chronological',
  'signatures_trust_weighted'
];

/**
 * Validate a parsed aggregator output object.
 *
 * @param {object} current - freshly generated output (parsed JSON)
 * @param {object|null} previous - last-good deployed output, or null if none
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateOutput(current, previous = null) {
  const errors = [];

  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    return { ok: false, errors: ['output is not a JSON object'] };
  }

  for (const key of REQUIRED_KEYS) {
    if (!(key in current)) errors.push(`missing required key: ${key}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const { petition, stats } = current;

  if (typeof petition.a_tag !== 'string' || !/^30023:[0-9a-f]{64}:.+$/.test(petition.a_tag)) {
    errors.push(`petition.a_tag missing or malformed: ${JSON.stringify(petition.a_tag)}`);
  }

  if (!Number.isInteger(stats.total_signatures) || stats.total_signatures < 0) {
    errors.push(`stats.total_signatures is not a non-negative integer: ${JSON.stringify(stats.total_signatures)}`);
  }

  if (!Array.isArray(current.signatures_chronological)) {
    errors.push('signatures_chronological is not an array');
  } else if (current.signatures_chronological.length !== stats.total_signatures) {
    errors.push(
      `signature count mismatch: stats.total_signatures=${stats.total_signatures} ` +
      `but signatures_chronological has ${current.signatures_chronological.length}`
    );
  }

  if (!Array.isArray(current.signatures_trust_weighted)) {
    errors.push('signatures_trust_weighted is not an array');
  } else if (current.signatures_trust_weighted.length !== stats.total_signatures) {
    errors.push(
      `signature count mismatch: stats.total_signatures=${stats.total_signatures} ` +
      `but signatures_trust_weighted has ${current.signatures_trust_weighted.length}`
    );
  }

  if (typeof stats.last_updated !== 'string' || Number.isNaN(Date.parse(stats.last_updated))) {
    errors.push(`stats.last_updated is not a parseable timestamp: ${JSON.stringify(stats.last_updated)}`);
  }

  if (previous !== null && typeof previous === 'object' && !Array.isArray(previous)) {
    const prevATag = previous.petition?.a_tag;
    if (typeof prevATag === 'string' && prevATag.length > 0 && petition.a_tag !== prevATag) {
      errors.push(`petition a_tag changed: previous=${prevATag} current=${petition.a_tag}`);
    }

    const prevCount = previous.stats?.total_signatures;
    if (Number.isInteger(prevCount) && stats.total_signatures < prevCount) {
      errors.push(
        `signature count shrank: previous=${prevCount} current=${stats.total_signatures} ` +
        '(relay outage or partial fetch? refusing to deploy)'
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * CLI: node src/validate-output.js <new.json> [previous.json]
 * Exits 0 when valid, 1 when invalid or unreadable.
 */
function main() {
  const [newPath, prevPath] = process.argv.slice(2);
  if (!newPath) {
    console.error('usage: node src/validate-output.js <new.json> [previous.json]');
    process.exit(1);
  }

  let current;
  try {
    current = JSON.parse(fs.readFileSync(newPath, 'utf8'));
  } catch (err) {
    console.error(`[validate] cannot read/parse ${newPath}: ${err.message}`);
    process.exit(1);
  }

  let previous = null;
  if (prevPath && fs.existsSync(prevPath)) {
    try {
      previous = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
    } catch (err) {
      // A corrupt previous file must not block deploying a valid new one.
      console.error(`[validate] warning: previous file ${prevPath} unreadable (${err.message}); skipping regression checks`);
      previous = null;
    }
  }

  const { ok, errors } = validateOutput(current, previous);
  if (!ok) {
    for (const e of errors) console.error(`[validate] FAIL: ${e}`);
    process.exit(1);
  }
  console.log(`[validate] OK: ${current.stats.total_signatures} signatures, last_updated ${current.stats.last_updated}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
