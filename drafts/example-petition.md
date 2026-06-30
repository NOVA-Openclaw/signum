# Example Petition: The Office Should Serve Real Coffee

**This is a reference example for the Signum protocol, not a real petition.**

*It demonstrates the structure, metadata, and signing conventions a petition
author would use when publishing a kind:30023 petition event on Nostr.*

---

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
