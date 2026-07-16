# Archival Relays

How to preserve Signum petition signatures durably, and how to configure the
reference aggregator to republish accepted events to archival relays.

## Why archive

A Signum signature is not a row in a database — it is a signed Nostr event
(`kind:1791`) that anyone can independently verify. That verifiability only
holds as long as the event remains fetchable from *some* relay:

- **Public relays prune.** Most free public relays enforce retention windows,
  size caps, or kind-based policies. An event accepted today may be gone in
  months without notice.
- **Signatures are evidence.** A petition's signature wall is a claim about
  who endorsed what, when. The claim is only as strong as the availability of
  the underlying signed events. If the events vanish, the aggregator's JSON
  feed becomes hearsay instead of a verifiable index.
- **The aggregator cache is not an archive.** The aggregator keeps raw events
  in SQLite, but that is a private cache under one operator's control —
  exactly the single point of failure Nostr is meant to avoid. The archive
  must live on relays, where third parties can fetch and verify events
  without trusting the aggregator.

The aggregator therefore supports **archival republishing**: every event it
accepts is republished verbatim to one or more designated archival relays
with retention guarantees.

### What gets archived

Archival is about **evidence preservation, not scoring**. Everything the
aggregator accepts as valid is archived, regardless of trust score:

| Event | Why |
|---|---|
| `kind:30023` petition event | The archive is self-contained: the content the signatures commit to (via `content_hash`) is preserved alongside them. |
| `kind:1791` signature events | The signatures themselves — **all** valid ones, including gated (below-threshold) and revoked ones. A revoked signature is still a historical fact. |
| `kind:5` deletion events | Revocations are part of the record. Without them, an archive would misrepresent the petition's current state. |

Events are republished **unmodified** — the original signed JSON captured at
ingestion. Event ids and signatures remain intact, so anything fetched from
the archive verifies exactly like the original.

## Configuration

Add the optional `archival` block to the aggregator's `config.json`:

```json
"archival": {
  "relays": ["wss://archive.example.com"],
  "republish": true,
  "dry_run": false
}
```

| Field | Default | Description |
|---|---|---|
| `relays` | — | Array of archival relay WebSocket URLs. Required for archival to activate. |
| `republish` | `true` | Master switch. Set `false` to disable without removing the block. |
| `dry_run` | `false` | Log what *would* be republished without connecting or writing state. Useful for verifying scope before enabling. |

Behavior notes:

- Republish state is tracked in SQLite per **(event, relay)** pair —
  restarts do not re-spam relays, and adding a new archival relay later
  backfills everything to it on the next poll cycle.
- Failures are retried on subsequent poll cycles with exponential backoff
  (5 minutes doubling up to 6 hours). Backoff is per event per relay.
- Write rejections (`auth-required:`, `restricted:`, `blocked:`) are logged
  with a policy hint and never crash the poll loop.
- Archival runs at the end of each poll cycle, after the output feed is
  written, so it never delays the signature wall.

## Running your own archival relay (strfry)

[strfry](https://github.com/hoytech/strfry) is a solid choice for a
self-hosted archival relay: single binary, LMDB storage, and a flexible
write-policy plugin system.

### Retention: keep everything

An archival relay must not expire events. In `strfry.conf`, leave retention
unrestricted (the default is to keep everything unless you configure
otherwise):

```
dbParams {
    # size the LMDB map generously; events are small, storage is cheap
    mapsize = 10995116277760
}

# Do NOT configure retention/expiry policies for archival kinds.
# If you run mixed workloads, scope any retention rules so that
# kinds 30023, 1791, and 5 are never expired.
```

Also consider whether to honor NIP-09 deletions at the storage layer. strfry
processes `kind:5` deletions by removing referenced events. For a *pure*
archival relay you may prefer to keep the deletion event **and** the deleted
signature (the Signum aggregator honors revocations at display time — the
archive's job is history, not display). If your relay version does not
support disabling deletion processing, this is a reason to keep the
aggregator's SQLite cache backed up as a secondary record, and to weigh
third-party relays by the same criterion (see below).

### Write policy: accept third-party-authored events

This is the subtle part. Signature events are authored by **the signers**,
not by you. A naive whitelist-by-pubkey policy ("only accept events signed by
my keys") will silently reject every signature the aggregator tries to
archive.

Your policy must accept:

1. `kind:30023` petition events from your sponsor/coordinator pubkey(s),
2. `kind:1791` events from **any** author whose `a` tag references one of
   your petitions,
3. `kind:5` events from **any** author that reference your petition via the
   `a` tag (signers revoking their own signatures).

Example strfry write-policy plugin (`signum-policy.js`, wired via
`writePolicy.plugin` in `strfry.conf`):

```js
#!/usr/bin/env node
// strfry write-policy plugin: accept Signum petition traffic, reject the rest.
const readline = require('node:readline');

const PETITION_ATAGS = new Set([
  // your petitions: "30023:<sponsor_pubkey>:<d-tag>"
  '30023:ecacc13f19380be2e8313c4dc818525ae394abf4b56d0a67bd3dbad87cb705e6:entity-dignity-2026'
]);
const TRUSTED_AUTHORS = new Set([
  // sponsor/coordinator pubkeys allowed to publish petition events
  'ecacc13f19380be2e8313c4dc818525ae394abf4b56d0a67bd3dbad87cb705e6'
]);

function aTags(event) {
  return (event.tags || []).filter((t) => t[0] === 'a').map((t) => t[1]);
}

function accept(event) {
  if (event.kind === 30023) return TRUSTED_AUTHORS.has(event.pubkey);
  if (event.kind === 1791 || event.kind === 5) {
    return aTags(event).some((a) => PETITION_ATAGS.has(a));
  }
  return false;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  const ok = accept(req.event);
  process.stdout.write(JSON.stringify({
    id: req.event.id,
    action: ok ? 'accept' : 'reject',
    msg: ok ? '' : 'blocked: not a recognized Signum petition event'
  }) + '\n');
});
```

Note that `kind:5` acceptance above requires the deletion to carry the
petition `a` tag. Signers following the Signum spec include it; if you want
to also catch bare `["e", <sig_id>]`-only deletions, extend the policy to
look up the referenced event ids.

### Alternative ingestion: strfry router

Instead of (or in addition to) the aggregator pushing events to your archive,
you can pull them with `strfry router` — a downstream streaming daemon that
subscribes to upstream relays and mirrors matching events into your strfry
instance:

```
# strfry-router.config
streams {
    signum {
        dir = "down"
        filter = { "kinds": [30023, 1791, 5] }
        urls = [
            "wss://relay.damus.io",
            "wss://nos.lol"
        ]
    }
}
```

Router-based ingestion is independent of the aggregator's uptime and catches
events the moment they appear on public relays. The trade-off: a kind-level
filter mirrors *all* petitions' traffic, not just yours (filter by `#a` if
your router version supports tag filters on streams), and it only sees events
on the relays it watches. The aggregator's push-based republish only archives
events it has actually validated. The two approaches compose well: router for
breadth and immediacy, aggregator republish as the validated backstop.

## Choosing a third-party archival relay

If you don't want to run your own relay, choose third-party archival homes
deliberately. Evaluate:

- **Retention guarantees.** Look for an explicit retention policy (ideally
  "indefinite"). Absent a stated policy, assume pruning. Paid relays that
  contractually state retention are preferable to free relays with silent
  eviction.
- **Deletion handling.** Ask whether the relay honors NIP-09 deletions by
  physically removing events. For archival purposes you want the revocation
  *recorded*, not history erased. A relay that keeps both the `kind:5` and
  the referenced event is ideal for evidence preservation.
- **Paid access as a durability signal.** A relay with a sustainable revenue
  model is less likely to vanish or purge storage than a free best-effort
  box. Payment also usually implies a whitelist — confirm that *third-party
  authored* `kind:1791` events referencing your petition are writable by
  your aggregator's connection (some paid relays only accept events authored
  by the paying pubkey, which breaks signature archival).
- **Verify with a test event.** Before relying on any relay: publish a test
  event, disconnect, fetch it back from a cold connection, and check again
  after a few weeks. The aggregator's `dry_run: false` + a throwaway petition
  is a cheap end-to-end drill. Keep verifying periodically — retention
  claims are testable, so test them.

Configure at least two archival relays under independent operation if the
petition matters. The `archival.relays` array handles fan-out and per-relay
state tracking automatically.
