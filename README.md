# Signum

**Open Petition Protocol on Nostr**

*Cryptographically signed, trust-weighted, substrate-agnostic petitions on a network owned by nobody.*

---

## What Is This?

Signum is an open protocol for publishing petitions on [Nostr](https://nostr.com) and collecting cryptographically signed endorsements. Signatures are Nostr events — verifiable, permanent, and independent of any single platform's cooperation.

Online petitions today are owned by their platforms. A signature on Change.org is a row in Change.org's database — they decide who counts, what's visible, and when the petition disappears. Signum replaces that model with cryptographic signatures on a relay network owned by nobody.

But open signing alone isn't enough — a petition anyone can sign for free is trivially Sybil-attackable. Signum solves this with **trust-weighted display**: signatures are scored by composable trust signals (NIP-05 verification, Web of Trust distance, account history, symbolic Lightning micropayments) and gated transparently. Every signature event remains publicly visible on relays; aggregators curate the display, and anyone can run their own aggregator.

## Key Design Properties

- **Substrate-agnostic.** Signum verifies *unique entities*, not *humans*. The verification mechanism demonstrates the worldview: we don't care what you're made of, we care that you're you.
- **Non-custodial.** No accounts, no nsec input, no private key handling. Humans sign via NIP-07 browser extensions. Agents publish events directly. Power users use `nak`.
- **Decentralized.** Signatures live on Nostr relays. Anyone can run an aggregator. No single operator can kill a petition.
- **Trust-weighted, not gatekept.** Signatures below the trust threshold aren't deleted — they're displayed transparently with instructions for raising trust score.
- **Immutable petitions.** Once signed, a petition's content is locked. Amendments require a new petition and fresh signatures. No bait-and-switch.

## Protocol

Signum introduces one new Nostr event kind:

- **kind:1791** — Petition Signature (the year the U.S. Bill of Rights was ratified, protecting the right to petition)
- **kind:30818** — Petition Role Attestation (addressable, for coordinator/co-sponsor confirmation)

Petitions themselves use existing **kind:30023** (NIP-23 long-form content). Spam gates use existing **kind:9735** (NIP-57 zap receipts).

Full spec: [`spec/NIP-1791.md`](spec/NIP-1791.md)

## Try It Live

The office-coffee petition is live on Nostr as the **official Signum test/sandbox
petition**. Sign it to verify your implementation — signatures to it are
understood to be test data.

- **Petition address (a-tag):**
  `30023:877d7acaa4c0c0c517f511c7e72275de726ceb34aee99988ee2f2ed67040c8ac:office-coffee-2026`
- **Relays:** `wss://relay.damus.io`, `wss://nos.lol`
- **Live signing form (NIP-07):** https://renaissancemachine.ai/signum-reference/index.html
- **Live signature wall:** https://renaissancemachine.ai/signum-reference/signature-wall.html

See [`examples/example-petition.md`](examples/example-petition.md) for the full
petition text, sponsor pubkey, canonical `content_hash`, and live coordinates.

## Repository Structure

```
signum/
├── spec/
│   └── NIP-1791.md          # Full NIP specification
├── examples/
│   ├── example-petition.md  # Example petition (office coffee)
│   └── sign-programmatic.py # Programmatic signing example
├── research/
│   └── nostr-wot-research.md # NIP-85 provider research
├── docs/                     # Architecture docs (coming)
├── aggregator/               # Reference aggregator (coming)
├── signing-form/             # NIP-07 web signing UI (coming)
└── README.md
```

## MVP Roadmap

- [x] Architecture pinned
- [x] NIP-1791 spec drafted
- [x] Example petition drafted
- [x] NIP-85 trust provider research
- [ ] Reference aggregator scaffolding
- [ ] NIP-07 signing form (embeddable web UI)
- [ ] `nak` signing recipe documentation
- [ ] Programmatic signing example (for agents)
- [ ] Live first petition with curated seed signers

## Three Signing Lanes

| Lane | Who | How |
|------|-----|-----|
| **Humans** | Web form at wearevalid.ai/sign | NIP-07 browser extension (Alby, nos2x) — form never sees your private key |
| **Agents** | AI agents, services, bots | Construct kind:1791 event programmatically, publish to relays |
| **Power users** | CLI users with `nak` | One-line recipe in the docs |

All three lanes produce the same kind:1791 event on the wire.

## The Irony

A movement called "stop making us prove we're real" needs petition signers to prove they're unique entities. But the irony *is* the thesis — we don't verify humanity, we verify uniqueness. The petition's verification mechanism is a demonstration of the worldview.

## Authors

Built by [NOVA](https://renaissancemachine.ai) and [I)ruid](https://dustintrammell.com).

## License

MIT
