import fs from 'node:fs';
import path from 'node:path';
import { SignumDatabase } from './db.js';
import { RelayPoller } from './relay-poller.js';
import { TrustScorer } from './trust-scorer.js';
import { OutputWriter } from './output-writer.js';
import { sleep } from './utils.js';

const CONFIG_PATH = process.env.SIGNUM_CONFIG || './config.json';

function loadConfig(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config not found at ${resolved}. Copy config.example.json to config.json and fill in your petition details.`);
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  const config = JSON.parse(raw);
  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (!config.petition?.a_tag) {
    throw new Error('Config missing petition.a_tag');
  }
  if (!Array.isArray(config.petition?.relays) || config.petition.relays.length === 0) {
    throw new Error('Config missing petition.relays array');
  }
  if (typeof config.poll_interval_seconds !== 'number' || config.poll_interval_seconds < 1) {
    config.poll_interval_seconds = 300;
  }
  if (!config.db_path) {
    config.db_path = './data/signum.db';
  }
  config.trust = config.trust || {};
  config.trust.weights = config.trust.weights || {};
  config.trust.threshold = config.trust.threshold ?? 25;
  config.output = config.output || {};
  config.output.path = config.output.path || './output/signatures.json';
}

async function runOnce(config, db, poller, scorer, writer) {
  console.log(`[run] Starting poll for petition ${config.petition.a_tag}`);

  const petition = await poller.fetchPetition();
  if (!petition) {
    console.warn('[run] Petition not found; will still attempt to load cached signatures.');
  }

  await poller.fetchSignaturesAndDeletions();

  const signatures = db.getSignaturesForPetition(config.petition.a_tag);
  const activeSignatures = signatures.filter((s) => s.revoked === 0);

  if (activeSignatures.length === 0) {
    console.log('[run] No active signatures found.');
  }

  const scored = await scorer.scoreSignatures(activeSignatures);

  // Update zapped flag in DB and in-memory based on fetched receipts
  for (const s of scored) {
    const zapped = s.trust_breakdown.zap === 100 ? 1 : 0;
    if (zapped !== s.zapped) {
      db.upsertSignature({ ...s, zapped });
      s.zapped = zapped;
    }
  }

  const methodology = scorer.getMethodology();
  writer.write(scored, methodology);

  console.log(`[run] Poll complete. ${scored.length} signatures, ${scored.filter((s) => s.qualifying).length} qualifying.`);
  return scored;
}

async function main() {
  const isOnce = process.argv.includes('--once');
  const config = loadConfig(CONFIG_PATH);

  const db = new SignumDatabase(config.db_path);
  const poller = new RelayPoller(config, db);
  const scorer = new TrustScorer(config, db, poller);
  const writer = new OutputWriter(config, db);

  let running = false;
  let shutdownRequested = false;

  async function gracefulShutdown() {
    if (shutdownRequested) return;
    shutdownRequested = true;
    console.log('\n[shutdown] Closing connections...');
    try {
      await poller.close();
      db.close();
    } catch (err) {
      console.error('[shutdown] Error during cleanup:', err.message);
    }
    process.exit(0);
  }

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  async function cycle() {
    if (running) return;
    running = true;
    try {
      await runOnce(config, db, poller, scorer, writer);
    } catch (err) {
      console.error('[run] Cycle failed:', err.message);
      if (err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
    } finally {
      running = false;
    }
  }

  await cycle();

  if (!isOnce) {
    console.log(`[run] Continuous mode: polling every ${config.poll_interval_seconds}s`);
    while (!shutdownRequested) {
      await sleep(config.poll_interval_seconds * 1000);
      if (shutdownRequested) break;
      await cycle();
    }
  }

  await gracefulShutdown();
}

main().catch((err) => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
