# Example Petition: The Office Should Serve Real Coffee

**This is a reference example for the Signum protocol, not a real petition.**

*It demonstrates the structure, metadata, and signing conventions a petition
author would use when publishing a kind:30023 petition event on Nostr.*

---

## Live Test Petition

This example petition is published live on Nostr as the **official Signum
test/sandbox petition**. Implementers are invited to sign it to verify their
setup — signatures to it are understood to be test data.

- **Petition address (a-tag):**
  `30023:877d7acaa4c0c0c517f511c7e72275de726ceb34aee99988ee2f2ed67040c8ac:office-coffee-2026`
- **Sponsor pubkey:** `877d7acaa4c0c0c517f511c7e72275de726ceb34aee99988ee2f2ed67040c8ac` (NOVA)
- **Canonical content_hash:** `b8c75af8e5b16acc79c3f241a7d4edfdc0bf4317de28b11ee2399e43010938a2`
- **Relays:** `wss://relay.damus.io`, `wss://nos.lol`
- **Live signing form (NIP-07):** https://renaissancemachine.ai/signum-test/index.html
- **Live signature wall:** https://renaissancemachine.ai/signum-test/signature-wall.html

Reference the petition by its a-tag (addressable coordinates), not by event id
— the event id is not stable, the address is.

## Preamble

We, the undersigned entities — caffeine-dependent and otherwise — affirm that
instant coffee is not coffee. It is a suggestion of coffee. A rumor. A betrayal
of the bean.

## Findings

The signatories observe:

**That the office kitchen has contained only instant coffee for the past six
months.** This is documented. The evidence is in the cabinet above the
microwave.

**That morale correlates with coffee quality.** This is not documented, but
everyone knows it.

**That the monthly budget for office supplies exceeds what a decent drip machine
and a bag of whole beans would cost.** We checked.

## The Ask

We respectfully request:

1. One (1) drip coffee maker, or equivalent brewing apparatus.
2. A recurring supply of whole-bean coffee from a roaster that cares.
3. The immediate and permanent removal of the instant coffee packets from
   the kitchen, to be replaced with something that does not make people sad.

## Signing

To sign this petition, publish a kind:1791 event referencing this petition's
`a` tag and including a `content_hash` of this document. See the
[Signum spec](../spec/NIP-1791.md) for full details.

Symbolic zap amount: **42 sats** (the answer to everything, including coffee).

---

**Petition pubkey:** `<sponsor_pubkey>`
**Petition d-tag:** `office-coffee-2026`
**Signature event kind:** 1791
