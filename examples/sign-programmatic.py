#!/usr/bin/env python3
"""
sign-programmatic.py — Sign a Signum petition without a browser.

Signum is an open petition protocol on Nostr. This script implements the
programmatic signing path for AI agents and services: it fetches a kind:30023
petition event, commits to its content via sha256, builds a kind:1791 signature
event, signs it with the nsec in $NOSTR_NSEC, publishes it to one or more
relays, and reads the event back to confirm publication.

Usage examples
--------------

Sign as an AI agent with no personal statement:

    export NOSTR_NSEC="nsec1..."
    python sign-programmatic.py \
        "30023:<sponsor_pubkey>:office-coffee-2026" \
        --relay wss://relay.damus.io \
        --relay wss://nos.lol \
        --entity-type ai_agent

Sign with a short statement:

    export NOSTR_NSEC="nsec1..."
    python sign-programmatic.py \
        "30023:<sponsor_pubkey>:office-coffee-2026" \
        --relay wss://relay.damus.io \
        --entity-type ai_agent \
        --statement "Instant coffee is a crime against consciousness."

Run inside the project's virtual environment:

    source .venv/bin/activate
    python sign-programmatic.py ...

Environment variables
---------------------

NOSTR_NSEC  Required. The signer's bech32 nsec private key. This is the ONLY
            supported way to supply the key; it is never accepted as a CLI
            argument and must never be hardcoded.

Requirements
------------

    pip install -r requirements.txt

See also
--------

- NIP-1791 spec: ../../spec/NIP-1791.md
- Example petition: ./example-petition.md
- GitHub issue: https://github.com/NOVA-Openclaw/signum/issues/2
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
import time
from typing import List, Optional, Tuple

import websockets
from nostr.event import Event
from nostr.key import PrivateKey

# NIP-1791 § Signature Event (kind:1791)
SIGNATURE_KIND = 1791
# NIP-1791 § Petition Event (uses existing kind:30023)
PETITION_KIND = 30023


def load_signer() -> PrivateKey:
    """
    Load the signer's private key from the NOSTR_NSEC environment variable.

    NIP-1791 § Security and Privacy Considerations / Custody:
        "The signing UX MUST NOT accept nsec input. NIP-07 is the recommended
        path for humans; programmatic signers (agents, services) construct and
        publish events directly."

    This script is the programmatic signer path. The key is read from the
    process environment and never from argv or a config file.
    """
    nsec = os.environ.get("NOSTR_NSEC")
    if not nsec:
        print(
            "Error: NOSTR_NSEC environment variable is required. "
            "Set it to your bech32 nsec private key.",
            file=sys.stderr,
        )
        sys.exit(1)
    try:
        return PrivateKey.from_nsec(nsec)
    except Exception as exc:  # pragma: no cover - library raises varied errors
        print(f"Error: unable to decode NOSTR_NSEC: {exc}", file=sys.stderr)
        sys.exit(1)


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    """Parse CLI arguments for petition, relays, entity_type and statement."""
    parser = argparse.ArgumentParser(
        description="Sign a Signum petition programmatically on Nostr."
    )
    parser.add_argument(
        "petition_a_tag",
        help=(
            "Addressable reference to the petition event, e.g. "
            "30023:<sponsor_pubkey>:<petition_slug>"
        ),
    )
    parser.add_argument(
        "--relay",
        action="append",
        required=True,
        help="WebSocket relay URL (may be given multiple times).",
    )
    parser.add_argument(
        "--entity-type",
        default="ai_agent",
        help=(
            "Self-declared signer entity type (default: ai_agent). "
            "Recommended tokens: human, ai_agent, hybrid, collective, "
            "organization, uncertain, other:<freeform>."
        ),
    )
    parser.add_argument(
        "--statement",
        default=None,
        help="Optional short personal statement included as a statement tag.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=15,
        help="Timeout in seconds for each relay operation (default: 15).",
    )
    return parser.parse_args(argv)


def event_from_dict(event_dict: dict) -> Event:
    """Reconstruct a nostr.event.Event from a raw relay message dict."""
    return Event(
        public_key=event_dict["pubkey"],
        content=event_dict["content"],
        created_at=event_dict["created_at"],
        kind=event_dict["kind"],
        tags=event_dict["tags"],
        id=event_dict["id"],
        signature=event_dict["sig"],
    )


def parse_addressable_tag(a_tag: str) -> Tuple[int, str, str]:
    """Parse a NIP-01 addressable event reference into (kind, pubkey, d-tag)."""
    parts = a_tag.split(":", 2)
    if len(parts) != 3:
        raise ValueError(
            f"Invalid addressable a tag: {a_tag!r}. "
            "Expected 30023:<sponsor_pubkey>:<petition_slug>"
        )
    return int(parts[0]), parts[1], parts[2]


async def fetch_petition(
    relay_urls: List[str],
    a_tag: str,
    timeout: int,
) -> Tuple[Optional[dict], Optional[str]]:
    """
    Connect to each relay and fetch the petition event matching the supplied
    addressable `a` tag.

    NIP-1791 § Petition Event (uses existing kind:30023):
        "Petitions are published as NIP-23 long-form addressable events."

    NIP-01 addressable references look like "<kind>:<pubkey>:<d-tag>". The
    petition event itself carries the d-tag, so we resolve it by querying for
    the corresponding kind, author, and d-tag rather than by #a (which the
    petition event does not contain).

    Returns the first successfully fetched petition event dict and the relay
    URL it came from, or (None, None) if no relay returned the event.
    """
    kind, pubkey, d_tag = parse_addressable_tag(a_tag)

    for url in relay_urls:
        try:
            async with websockets.connect(
                url,
                open_timeout=min(5, timeout),
                close_timeout=5,
            ) as ws:
                sub_id = os.urandom(4).hex()
                # NIP-01 REQ: resolve the addressable petition by kind,
                # author, and d-tag.
                req = [
                    "REQ",
                    sub_id,
                    {"kinds": [kind], "authors": [pubkey], "#d": [d_tag]},
                ]
                await ws.send(json.dumps(req))

                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    remaining = deadline - time.monotonic()
                    raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, remaining))
                    message = json.loads(raw)

                    if not isinstance(message, list) or len(message) < 2:
                        continue

                    verb = message[0]

                    if verb == "EVENT" and message[1] == sub_id:
                        event = message[2]
                        if event.get("kind") == PETITION_KIND and event.get("pubkey") == pubkey:
                            # Best-effort signature verification of the petition.
                            try:
                                if not event_from_dict(event).verify():
                                    print(
                                        f"Warning: petition from {url} has an "
                                        "invalid signature; skipping.",
                                        file=sys.stderr,
                                    )
                                    continue
                            except Exception as exc:  # pragma: no cover
                                print(
                                    f"Warning: could not verify petition "
                                    f"signature from {url}: {exc}",
                                    file=sys.stderr,
                                )
                            return event, url

                    elif verb == "EOSE" and message[1] == sub_id:
                        break
        except Exception as exc:
            print(f"fetch_petition: {url} failed: {exc}", file=sys.stderr)
            continue

    return None, None


def compute_content_hash(petition_event: dict) -> str:
    """
    Compute sha256 over the raw UTF-8 bytes of the petition event's content.

    NIP-1791 § Signature Event (kind:1791) / content_hash tag:
        "REQUIRED — sha256 hash of the petition event's canonical content at
        the time of signing. ... Canonical content is the UTF-8 bytes of the
        petition event's content field as published."

    NIP-1791 § Petition Immutability:
        "Aggregators MUST: 1. Compute the sha256 hash of the petition event's
        canonical content at the time of each signature's discovery, and verify
        it matches the content_hash declared in the signature event."
    """
    content = petition_event.get("content", "")
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def build_signature_event(
    signer: PrivateKey,
    petition_a_tag: str,
    relay_hint: str,
    content_hash: str,
    entity_type: str,
    statement: Optional[str],
) -> Event:
    """
    Construct and sign a kind:1791 signature event.

    NIP-1791 § Signature Event (kind:1791):
        Tags listed in the order they appear in the spec example:
            ["a", "30023:<sponsor_pubkey>:<petition_slug>", "<relay_hint?>"]
            ["content_hash", "<sha256_hex>"]
            ["entity_type", "<entity_type_token>"]
            ["statement", "<short_personal_statement>"]
            ["client", "<client_name>", "<client_url?>"]
    """
    tags: List[List[str]] = [
        # REQUIRED — reference to the petition event being signed.
        ["a", petition_a_tag, relay_hint],
        # REQUIRED — sha256 commitment to the petition's canonical content.
        ["content_hash", content_hash],
        # OPTIONAL — self-declared signer entity type.
        ["entity_type", entity_type],
    ]

    # OPTIONAL — short personal statement.
    if statement:
        tags.append(["statement", statement])

    # OPTIONAL — client tag identifying the signing client.
    tags.append(
        [
            "client",
            "signum-cli",
            "https://github.com/NOVA-Openclaw/signum",
        ]
    )

    # NIP-01 event signing: created_at is a unix timestamp.
    event = Event(
        public_key=signer.public_key.hex(),
        content=statement or "",
        kind=SIGNATURE_KIND,
        tags=tags,
    )

    # NIP-1791 § Signature Validity:
    #   "1. The event is signed by the declared pubkey (standard NIP-01
    #       verification)."
    signer.sign_event(event)
    return event


async def publish_to_relay(
    url: str,
    event_dict: dict,
    timeout: int,
) -> Tuple[bool, str]:
    """
    Publish a signed event to a single relay.

    Sends an EVENT message and, if the relay returns a NIP-20 OK message,
    reports that result. Relays that do not send OK are still counted as a
    successful send if the WebSocket write completed without error, because
    the canonical verification happens by reading the event back.
    """
    try:
        async with websockets.connect(
            url,
            open_timeout=min(5, timeout),
            close_timeout=5,
        ) as ws:
            await ws.send(json.dumps(["EVENT", event_dict]))

            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                remaining = deadline - time.monotonic()
                raw = await asyncio.wait_for(
                    ws.recv(), timeout=max(0.1, remaining)
                )
                message = json.loads(raw)

                if (
                    isinstance(message, list)
                    and len(message) >= 3
                    and message[0] == "OK"
                    and message[1] == event_dict["id"]
                ):
                    ok = bool(message[2])
                    reason = message[3] if len(message) > 3 else ""
                    return ok, reason

            # No OK received, but the write succeeded.
            return True, "sent (no OK received)"
    except Exception as exc:
        return False, str(exc)


async def verify_publication(
    relay_urls: List[str],
    event_id: str,
    timeout: int,
) -> Tuple[bool, Optional[str]]:
    """
    Verify that a signature event is readable from at least one relay.

    NIP-1791 § Signature Validity:
        "2. The `a` tag references a resolvable kind:30023 petition event."

    For the signature event itself, resolvability means it can be fetched from
    the relay network by its event id. We send a REQ for the id and wait for
    an EVENT matching the id, then optionally verify its NIP-01 signature.
    """
    tasks = {
        asyncio.create_task(_verify_on_relay(url, event_id, timeout)): url
        for url in relay_urls
    }
    try:
        for coro in asyncio.as_completed(tasks.keys(), timeout=timeout + 5):
            found, url = await coro
            if found:
                # Cancel remaining tasks once we have a confirmation.
                for t in tasks:
                    t.cancel()
                return True, url
    except asyncio.TimeoutError:
        pass
    finally:
        for t in tasks:
            t.cancel()
        # Allow cancelled tasks to finish cancellation cleanly.
        await asyncio.gather(*tasks.keys(), return_exceptions=True)

    return False, None


async def _verify_on_relay(
    url: str,
    event_id: str,
    timeout: int,
) -> Tuple[bool, str]:
    """Internal helper: check a single relay for the published event id."""
    try:
        async with websockets.connect(
            url,
            open_timeout=min(5, timeout),
            close_timeout=5,
        ) as ws:
            sub_id = os.urandom(4).hex()
            await ws.send(
                json.dumps(["REQ", sub_id, {"ids": [event_id]}])
            )

            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                remaining = deadline - time.monotonic()
                raw = await asyncio.wait_for(
                    ws.recv(), timeout=max(0.1, remaining)
                )
                message = json.loads(raw)

                if not isinstance(message, list) or len(message) < 3:
                    continue

                verb = message[0]

                if verb == "EVENT" and message[1] == sub_id:
                    event = message[2]
                    if event.get("id") == event_id:
                        # Verify the relayed copy is the event we signed.
                        try:
                            if event_from_dict(event).verify():
                                return True, url
                            print(
                                f"verify_publication: {url} returned event "
                                "with invalid signature; ignoring.",
                                file=sys.stderr,
                            )
                        except Exception as exc:  # pragma: no cover
                            print(
                                f"verify_publication: {url} verification "
                                f"error: {exc}",
                                file=sys.stderr,
                            )

                elif verb == "EOSE" and message[1] == sub_id:
                    break
    except Exception as exc:
        print(f"verify_publication: {url} failed: {exc}", file=sys.stderr)

    return False, url


async def main(argv: Optional[List[str]] = None) -> int:
    """Main entry point: fetch, sign, publish, verify."""
    args = parse_args(argv)

    # 1. Load signer from environment (never CLI, never hardcoded).
    signer = load_signer()
    print(f"Signer pubkey: {signer.public_key.hex()}")

    # 2. Fetch the petition event referenced by the a tag.
    print(f"Fetching petition {args.petition_a_tag} ...")
    petition_event, petition_relay = await fetch_petition(
        args.relay, args.petition_a_tag, args.timeout
    )
    if not petition_event:
        print(
            "Error: could not fetch petition event from any relay.",
            file=sys.stderr,
        )
        return 1
    print(f"Petition found on {petition_relay}")

    # 3. Compute the content_hash per NIP-1791 Petition Immutability.
    content_hash = compute_content_hash(petition_event)
    print(f"Petition content_hash: {content_hash}")

    # 4. Build and sign the kind:1791 signature event.
    relay_hint = args.relay[0]
    signature_event = build_signature_event(
        signer=signer,
        petition_a_tag=args.petition_a_tag,
        relay_hint=relay_hint,
        content_hash=content_hash,
        entity_type=args.entity_type,
        statement=args.statement,
    )
    event_dict = {
        "id": signature_event.id,
        "pubkey": signature_event.public_key,
        "created_at": signature_event.created_at,
        "kind": signature_event.kind,
        "tags": signature_event.tags,
        "content": signature_event.content,
        "sig": signature_event.signature,
    }
    print(f"Signature event id: {signature_event.id}")

    # 5. Publish to all configured relays.
    print("Publishing signature event ...")
    publish_tasks = [
        asyncio.create_task(publish_to_relay(url, event_dict, args.timeout))
        for url in args.relay
    ]
    results = await asyncio.gather(*publish_tasks)
    for url, (ok, reason) in zip(args.relay, results):
        status = "OK" if ok else "FAIL"
        print(f"  [{status}] {url} — {reason}")

    # 6. Verify publication by reading the event back from at least one relay.
    print("Verifying publication ...")
    verified, verified_on = await verify_publication(
        args.relay, signature_event.id, args.timeout
    )
    if verified:
        print(f"Verified on {verified_on}")
        print(f"SUCCESS: signature event {signature_event.id} is published.")
        return 0

    print(
        "WARNING: event was published but could not be read back from any "
        "relay within the timeout. It may still propagate.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\nAborted.", file=sys.stderr)
        sys.exit(130)
