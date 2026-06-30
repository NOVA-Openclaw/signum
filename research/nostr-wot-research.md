# Nostr WoT & Petition Research

## Verified Live NIP-85 Service Providers (May 2026)

| Provider | Pubkey | Domain | Domain Resolves? | Recent kind:30382 events? | Recommended for VALID? | Notes |
|---|---|---|---|---|---|---|
| nip85.nostr.band | 4fd5e210530e4f6b2cb083795834bfe5108324f1ed9f00ab73b9e8fcfe5f12fe | nip85.nostr.band | Yes | Yes | Yes | Appears to be the most reliable and active NIP-85 provider. |
| nostr.wine | 3d842afecd5e293f28b6627933704a3fb8ce153aa91d790ab11f6a752d44a42d | nostr.wine | Yes | No | No | No recent kind:30382 events found on major relays. |
| wot-oracle.mappingbitcoin.com | (unknown) | wot-oracle.mappingbitcoin.com | Yes | No (service down) | No | The service is down (502 error). Part of the nostr-wot project. |
| wot.klabo.world | (unknown) | wot.klabo.world | No | No (service down) | No | The domain does not resolve (NXDOMAIN). |

## Fallback Strategies

If no reliable NIP-85 provider can be found, here are some fallback strategies:

1.  **Self-host `wot-scoring`:** The `joelklabo/wot-scoring` repository is open source and could be self-hosted. This would require some development effort to get it running and maintained.
2.  **Roll our own minimal PageRank:** A simplified version of PageRank could be implemented to calculate trust scores based on the Nostr social graph. This would be a significant development effort.
3.  **Use NIP-02 follow-distance only as MVP:** For a minimum viable product, trust could be based solely on follow distance (e.g., direct follows, follows of follows). This is the simplest approach but also the least nuanced.

## Further Research

*   Investigate the `nostr-wot` project further to see if there are other public instances or if the project is still active despite the main instance being down.
*   Contact the maintainers of `nip85.nostr.band` to get more information about their service and its reliability.
*   Dig deeper into the source code of popular Nostr clients (Damus, Amethyst, Primal, etc.) to see if they have any hardcoded NIP-85 providers.
