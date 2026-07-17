# Signum Aggregator Backend

Reference aggregator for the [Signum petition protocol](../spec/NIP-1791.md) on Nostr. Polls relays for `kind:1791` petition signature events, deduplicates by signer, computes composable trust scores, and emits a signature wall JSON feed.

## What it does

1. **Relay Poller** — connects to configured relays, fetches the `kind:30023` petition event, subscribes to `kind:1791` signatures, applies `kind:5` revocation/deletion requests, verifies NIP-01 signatures, and verifies the `content_hash` tag against the petition content.
2. **Trust Scorer** — computes a 0-100 composite score from:
   - NIP-05 identifier verification
   - Follow-distance from a curated seed pubkey set via `kind:3`
   - Account history (age, event count, kind diversity)
   - Self-zap receipts (`kind:9735`) referencing the signature event, sent by the signer themselves
   - NIP-85 trust assertions from `nip85.nostr.band`
3. **Output** — writes `signatures.json` with two sort orders (chronological and trust-weighted) plus metadata and methodology.
4. **Archival Republisher** (optional) — republishes every accepted event verbatim to configured archival relays for durable evidence preservation. See [Archival relays](#archival-relays).

## Setup

Requires Node.js ≥ 18.

```bash
cd ~/.openclaw/workspace/signum/aggregator
npm install
```

Copy the example configuration and edit it for your petition:

```bash
cp config.example.json config.json
# edit config.json with your petition a_tag, relays, seed pubkeys, etc.
```

## Configuration

`config.json` fields:

| Field | Description |
|-------|-------------|
| `petition.a_tag` | Addressable reference: `30023:<sponsor_pubkey>:<d-tag>` |
| `petition.relays` | Array of WebSocket relay URLs to poll |
| `trust.seed_pubkeys` | Curated root pubkeys for follow-distance BFS |
| `trust.weights` | Integer weights for the five trust inputs (must sum to 100) |
| `trust.threshold` | Minimum composite score for a signature to be "qualifying" |
| `trust.nip85_provider` | NIP-85 provider pubkey queried on `nip85.nostr.band` |
| `output.path` | Where to write `signatures.json` |
| `archival.relays` | Optional array of archival relay URLs for durable republishing |
| `archival.republish` | Enable/disable archival republishing (default `true` when relays are set) |
| `archival.dry_run` | Log what would be republished without publishing (default `false`) |
| `poll_interval_seconds` | Seconds between polls in continuous mode |
| `db_path` | SQLite database file path |

## Usage

### Poll once (cron-friendly)

```bash
npm run poll-once
```

### Scheduled runs + validated deploy (production)

For keeping a live signature wall current, don't cron `poll-once` directly —
use the wrapper, which validates output (schema, signature count must not
shrink) and only deploys on pass, keeping the last-good file on failure:

```bash
scripts/run-and-deploy.sh -c config.json -t /path/to/deployed/signatures.json -d "<deploy command>"
```

See [docs/scheduled-aggregator-runs.md](../docs/scheduled-aggregator-runs.md)
for the full guide and the production cron entry for the entity-dignity
petition.

### Run continuously

```bash
npm start
```

### Custom config path

```bash
SIGNUM_CONFIG=/path/to/config.json npm start
```

### Run tests

```bash
npm test
```

## Archival relays

Public relays prune; signatures are evidence and must remain independently
verifiable. The optional `archival` config block makes the aggregator
republish every event it accepts — the `kind:30023` petition, **all** valid
`kind:1791` signatures (revoked and below-threshold included; archival is
evidence preservation, not scoring), and `kind:5` revocations — verbatim to
designated archival relays:

```json
"archival": {
  "relays": ["wss://archive.example.com"],
  "republish": true,
  "dry_run": false
}
```

Events are republished as the original signed JSON (ids and signatures
intact). Per-(event, relay) state is tracked in SQLite so restarts don't
re-spam relays; failures retry across poll cycles with exponential backoff
(5 min → 6 h), and write-policy rejections are logged without crashing the
poll loop.

See [docs/archival-relays.md](../docs/archival-relays.md) for the full
guide: why archive, running your own strfry archival relay (retention and
write-policy considerations), router-based ingestion as an alternative, and
how to evaluate third-party archival relays.

## Output format

`signatures.json` contains:

```json
{
  "petition_title": "...",
  "petition_d_tag": "...",
  "petition_a_tag": "30023:...",
  "petition_event_id": "...",
  "total_signatures": 42,
  "qualifying_signatures": 30,
  "gated_count": 12,
  "threshold": 25,
  "trust_methodology": { "weights": {...}, "threshold": 25, ... },
  "last_updated": "2026-07-01T00:00:00.000Z",
  "signatures_chronological": [...],
  "signatures_trust_weighted": [...]
}
```

Each signature object:

```json
{
  "pubkey": "hex",
  "npub": "npub1...",
  "display_name": "...",
  "nip05": "name@domain.com",
  "entity_type": "human",
  "statement": "...",
  "trust_score": 67,
  "trust_breakdown": {
    "nip05": 100,
    "follow_distance": 60,
    "history": 45,
    "zap": 0,
    "nip85": 0,
    "follow_hops": 2
  },
  "timestamp": 1719792000,
  "event_id": "...",
  "zapped": false
}
```

## Trust methodology

- **NIP-05** — fetches `https://<domain>/.well-known/nostr.json?name=<name>` and verifies the resolved pubkey matches the signer. Score: 0 or 100.
- **Follow distance** — BFS from `seed_pubkeys` through `kind:3` follow lists. Cap at depth 3. Score: 1-hop=90, 2-hop=60, 3-hop=30, unreachable=0.
- **Account history** — samples up to 500 events from the signer across common kinds. Score rises with account age, event count, and kind diversity.
- **Zap verification** — checks for `kind:9735` zap receipts that reference the signature event id. Each receipt's `description` tag must contain a valid, signature-verified embedded `kind:9734` zap request; receipts without one are discarded. The zap only counts when the embedded request's pubkey matches the signer's pubkey (self-zap reinforcement) — third-party zaps are not credited. Score: 0 or 100.
- **NIP-85 assertions** — queries `wss://nip85.nostr.band` for `kind:30382` trust assertions about the signer from the configured provider. Uses the published score or 50 if none present.

Composite score is the weighted average of available sub-scores.

## Error handling

The aggregator is designed to degrade gracefully:

- Relay disconnects/timeouts are logged and skipped.
- Missing `kind:0` profiles fall back to empty display metadata.
- NIP-05 timeouts or DNS failures score 0.
- NIP-85 provider failures score 0.
- Signature verification or `content_hash` mismatches cause the signature to be ignored.

## Files

- `src/index.js` — entry point, config loading, run loop
- `src/db.js` — SQLite persistence
- `src/relay-poller.js` — relay queries and event ingestion
- `src/trust-scorer.js` — trust sub-score computation
- `src/output-writer.js` — JSON feed generation
- `src/archival-republisher.js` — archival relay republishing
- `src/utils.js` — shared helpers
- `test/` — unit tests (`npm test`, Node built-in test runner)
- `config.example.json` — example configuration
- `package.json` — dependencies and scripts

## License

MIT
