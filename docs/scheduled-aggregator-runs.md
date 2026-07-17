# Scheduled aggregator runs

The signature wall (`wall.html`) reads a static `signatures.json` produced by
an aggregator run. Without automation the wall goes stale: new trust signals
(zap receipts, follow-graph changes, NIP-85 assertions) land on relays but
signer scores never update. See issue [#45](https://github.com/NOVA-Openclaw/signum/issues/45).

## The wrapper: `aggregator/scripts/run-and-deploy.sh`

A deterministic script (not an agent prompt — persistence and deploys belong
in scripts) that:

1. **Runs** the aggregator once (`node src/index.js --once`) with the given
   config, under a timeout (default 600 s, `SIGNUM_RUN_TIMEOUT`).
2. **Validates** the generated output with `src/validate-output.js`:
   - required top-level keys present (`petition`, `stats`,
     `trust_methodology`, both signature arrays)
   - `petition.a_tag` well-formed and, against the last deployed copy,
     unchanged (guards against wrong-config deploys)
   - array lengths coherent with `stats.total_signatures`
   - `stats.last_updated` parseable
   - **signature count has not shrunk** vs. the last deployed copy (a relay
     outage or partial fetch must not erase signatures from the wall)
3. **Deploys** only when validation passes: copies the output to the deploy
   target (atomically, via temp file + rename), then runs an optional deploy
   command (e.g. a targeted rsync to the web host).
4. **Keeps last-good on failure**: any run/validation/deploy failure leaves
   the previously deployed file untouched and exits nonzero (2 = run failed,
   3 = validation failed, 4 = deploy failed).
5. **Logs** every step with UTC timestamps to stdout — point cron at a
   logfile. An flock lockfile prevents overlapping runs.

```bash
aggregator/scripts/run-and-deploy.sh \
  -c aggregator/config.entity-dignity.json \
  -t /path/to/site/petition/signatures.json \
  -d "rsync -az /path/to/site/petition/signatures.json host:sites/example.com/petition/signatures.json"
```

Validation logic is unit-tested: `cd aggregator && npm test`
(`test/validate-output.test.js`).

## Production deployment (entity-dignity petition)

The entity-dignity petition wall at `https://wearevalid.ai/petition/wall.html`
is refreshed **hourly** by a crontab entry on NOVA's home host
(`home.renaissancemachine.ai`) — the host with the repo clone, Node.js, and
SSH deploy access to the Services web host:

```cron
7 * * * * /home/nova/.openclaw/workspace/signum/aggregator/scripts/run-and-deploy.sh -c /home/nova/.openclaw/workspace/signum/aggregator/config.entity-dignity.json -t /home/nova/.openclaw/workspace/valid-movement/petition/signatures.json -d "rsync -az /home/nova/.openclaw/workspace/valid-movement/petition/signatures.json nova@services.nova.dustintrammell.com:sites/wearevalid.ai/petition/signatures.json" >> /home/nova/.openclaw/logs/signum-aggregator.log 2>&1
```

Notes on the choices:

- **Hourly cadence** — trust signals (zaps, follows) are not latency-critical;
  an hour keeps the wall honest without hammering public relays. The
  acceptance bar from #45 is "a zap receipt published at time T shows on the
  live wall within one cadence interval."
- **Targeted rsync, not `deploy-sites.sh valid`** — the full-site deploy
  script rsyncs the whole `valid-movement/` working tree with `--delete`.
  Running that hourly from cron would silently publish (or delete) any
  unrelated in-progress local edits. The cron job deploys exactly one file.
- **The config is local, not committed** — aggregator configs are gitignored
  by design (`aggregator/.gitignore`); `config.entity-dignity.json` lives in
  the working clone. Its content mirrors `config.example.json` with the
  entity-dignity `a_tag`, the production seed pubkeys, and the archival relay
  (`wss://relay.nostr.renaissancemachine.ai`).
- **Logs** — `/home/nova/.openclaw/logs/signum-aggregator.log`. Repeated
  nonzero exits in the log are the alert signal; each failed run logs a
  `FAIL:` line with the reason.
- **Local copy doubles as last-good** — the `-t` target
  (`valid-movement/petition/signatures.json`) is both what gets rsynced and
  the "previous" file for the shrink/a_tag regression checks. It is a deploy
  artifact; don't hand-edit it.
