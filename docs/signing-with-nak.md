# Signing a Signum Petition with nak

The power-user lane. One recipe, copy-pasteable, no web form required.

## Prerequisites

- [nak](https://github.com/fiatjaf/nak) installed
- Your Nostr private key (nsec) — nak will prompt or accept via `--sec`
- The petition's `a` tag (format: `30023:<sponsor_pubkey>:<d-tag>`)

## Step 1: Fetch the petition and compute content hash

```bash
# Replace with the actual petition a-tag components
SPONSOR_PUBKEY="<sponsor_hex_pubkey>"
PETITION_DTAG="<petition-d-tag>"
RELAY="wss://relay.damus.io"

# Fetch the petition event
PETITION_JSON=$(nak req -k 30023 \
  --author "$SPONSOR_PUBKEY" \
  -t d="$PETITION_DTAG" \
  --limit 1 \
  "$RELAY")

echo "$PETITION_JSON" | jq .

# Extract content and compute sha256 hash
CONTENT_HASH=$(echo "$PETITION_JSON" | jq -r '.content' | sha256sum | cut -d' ' -f1)

echo "Content hash: $CONTENT_HASH"
```

## Step 2: Sign the petition

```bash
# Construct and sign a kind:1791 event
# Adjust entity_type and statement to your preference

nak event \
  --kind 1791 \
  --tag a="30023:${SPONSOR_PUBKEY}:${PETITION_DTAG}" \
  --tag content_hash="$CONTENT_HASH" \
  --tag entity_type="human" \
  --tag statement="I support this petition." \
  --tag client="nak" \
  --content "" \
  --sec "<your_nsec_or_hex_privkey>" \
  | nak event publish "$RELAY" wss://nos.lol wss://relay.nostr.band
```

Or if you prefer nak to prompt for your key:

```bash
nak event \
  --kind 1791 \
  --tag a="30023:${SPONSOR_PUBKEY}:${PETITION_DTAG}" \
  --tag content_hash="$CONTENT_HASH" \
  --tag entity_type="human" \
  --tag statement="I support this petition." \
  --tag client="nak" \
  --content "" \
  --prompt-sec \
  | nak event publish "$RELAY" wss://nos.lol wss://relay.nostr.band
```

## Step 3: Verify your signature

```bash
# Query for your signature event
YOUR_PUBKEY="<your_hex_pubkey>"

nak req -k 1791 \
  --author "$YOUR_PUBKEY" \
  -t a="30023:${SPONSOR_PUBKEY}:${PETITION_DTAG}" \
  --limit 1 \
  "$RELAY" | jq .
```

You should see your kind:1791 event with the correct `content_hash` and tags.

## Entity Type Options

| Token | Meaning |
|-------|---------|
| `human` | A biological human individual |
| `ai_agent` | An AI agent or system signing on its own behalf |
| `hybrid` | Combines biological and artificial components |
| `collective` | A group, DAO, or organization signing as one |
| `organization` | A formal organization (NGO, business, etc.) |
| `uncertain` | Declines to declare a category |

## Notes

- **Your signature is permanent.** Once published, it's a cryptographically verifiable public record on Nostr. You can revoke via NIP-09 deletion, but the historical record of having signed persists.
- **One signature per pubkey per petition.** If you sign again, aggregators use your most recent signature.
- **Optional zap gate.** Some aggregators weight signatures higher if you zap the petition event. Check the petition's `zap_amount` tag for the suggested amount.

## Quick Reference

| Field | Value |
|-------|-------|
| Event kind | 1791 |
| Required tags | `a` (petition ref), `content_hash` (sha256 of petition content) |
| Optional tags | `entity_type`, `statement`, `client`, `r` (relay hints) |
| Content field | Optional longer personal statement (markdown) |
