# Signing with Amber (NIP-55, Android)

The reference signing form supports [Amber](https://github.com/greenart7c3/Amber)
— an Android signer app that holds your Nostr key on-device — via the
[NIP-55](https://github.com/nostr-protocol/nips/blob/master/55.md) web flow.
Mobile browsers have no NIP-07 `window.nostr` injection, so on Android the
form offers a **"Sign with Amber"** button instead (and alongside NIP-07 when
an extension is present, e.g. in Kiwi Browser).

## How the flow works

1. You fetch the petition and fill in your signature details as usual.
2. Hitting **Sign with Amber** builds the unsigned `kind:1791` event (identical
   to the NIP-07 path), persists the in-progress form state to
   `sessionStorage`, and navigates to a `nostrsigner:` URL:

   ```
   nostrsigner:<urlencoded event JSON>?compressionType=none&returnType=event&type=sign_event&callbackUrl=<form URL>?event=
   ```

3. Amber opens, shows you the event, and asks for approval. Your key never
   leaves Amber; the form never sees an `nsec`.
4. Amber redirects back to the form with the signed event appended to the
   callback URL. The page reloads, restores your form state, **validates the
   returned event client-side** (kind, petition reference, content hash,
   event id, Schnorr signature), runs the duplicate-signature check against
   the now-known pubkey, and publishes to your configured relays.

### Clipboard variant

If Amber returns the result via the clipboard instead of a redirect (e.g. the
page was opened from a `file://` URL, or you navigated back manually), the
form shows a paste box: paste the signed event JSON and hit **Validate &
publish pasted event**. The same validation applies. Gzip-compressed results
(`Signer1` + base64) are handled too.

## Platform guidance

| Platform | Signing path |
| --- | --- |
| Desktop browser | NIP-07 extension (Alby, nos2x, NostrKey, …) |
| Android | Amber (NIP-55) — or NIP-07 in extension-capable mobile browsers |
| iOS | Not yet — NIP-46 remote signer support is planned ([signum#25](https://github.com/NOVA-Openclaw/signum/issues/25)) |

## Zapping via Amber

The symbolic-zap card (step "4. ⚡ Reinforce with a symbolic zap") is an
explicit **two-button flow** (issue #42): **Sign Zap Event** and **Pay Zap
Invoice** are both visible from the start, with Pay disabled until a
validated signed request has produced an invoice.

The NIP-57 spam-gate **zap request (kind:9734) is signed through the same
round-trip** as the petition signature: hitting **Sign Zap Event** builds
the zap request (e-tagging your signature event, with the petition `a`
tag, amount, and relays), launches Amber to sign it via `?zapevent=`
callback (its own parameter and pending-state slot, so a reload mid-zap
resumes the zap flow and is never confused with a pending signature or
connect), validates the result on return (kind, tags, amount, id/sig
verification, and that the signing key matches the key that signed the
petition — a mismatched key would produce a receipt that is never
credited), and only then fetches the invoice from the LNURL callback with
the signed request attached. When the invoice is in hand, **Sign Zap
Event** shows ✓ and **Pay Zap Invoice** becomes live.

The pending zap round-trip state is persisted in **localStorage** (not
per-tab sessionStorage): Amber's callback can land in a fresh browsing
context — a new tab or a custom-tab handoff — where sessionStorage is
empty, which used to kill the zap resume silently (issue #42). If the
pending state is lost anyway, the return handler reconstructs the flow
from the signed request itself against the independently restored
signature (same validation, including the key-match guard) — and every
failure mode surfaces a visible error with retry.

Hitting **Pay Zap Invoice** hands the payment off as:

- **`lightning:` URI** — primary on mobile: the OS presents its wallet
  chooser when several Lightning wallets are installed;
- **WebLN** one-click on desktop where present;
- **QR code + copy-invoice** (rendered below the buttons) as the
  universal fallback.

If a signed zap request cannot be produced, the form shows an explicit
choice (retry / knowingly pay uncredited / zap natively) — never a silent
fallback to a plain non-creditable invoice.

### Completion lock, and the separate donation step (issue #32)

Once the connected pubkey has **any** zap receipt for the signature event,
the symbolic-zap card completion-locks: the Sign/Pay controls disappear
and a green success notice takes their place, showing **only the
symbolic zap's own amount** (the earliest receipt matching the petition's
configured `zap_amount`, or the earliest parsable receipt if none
matches). This keeps the symbolic-zap notice from double-reporting
donations, which are listed separately.

Locking the symbolic-zap card reveals a distinct **"5. Make a larger
donation"** card. This is a second, independent zap lane, not a repeat of
step 4:

- **Freeform amount.** You type an amount in sats instead of a fixed
  petition-configured amount. Input is validated (whole numbers only —
  fractional sats are rejected) and bounded to the smaller of the LNURL
  recipient's `maxSendable` and an absolute 1 BTC ceiling, so a
  reconstructed (orphan) request can never run away if round-trip state
  is lost.
- **Its own Amber round-trip.** The donation's signed kind:9734 zap
  request returns via its own `?donatevent=` callback parameter and its
  own `DONATION_PENDING_TYPE` localStorage record — strictly separate
  from the symbolic zap's pending-state key, so a reload mid-donation can
  never be confused with a pending symbolic zap, signature, or connect.
- **Same Sign → Pay shape** as the symbolic zap: sign the zap request via
  Amber, fetch the invoice, then pay via `lightning:` URI / WebLN / QR
  fallback.
- **Repeat donations.** When a donation payment is detected, the card
  lists the completed payment, adds it to an accumulating payments panel
  (queried from relay zap receipts, newest first, with a running sats
  total), and **fully resets the form** — the amount field clears and
  re-enables, the in-flight invoice context is dropped, and only the
  donation pending record is cleared (the symbolic-zap record is never
  touched). This lets you send another donation immediately without
  reloading.

### Scroll restoration on resume

Returning from Amber (or a Lightning wallet) reloads the page anchored at
the top, stranding you away from the step you were on. On a genuine
resume from an external app — decided from the callback parameter
(`?zapevent=` vs `?donatevent=`) or, if that's absent, from the restored
pending record's type — the page smooth-scrolls the owning card (the
symbolic-zap card, its locked success card, or the donation card) back
into view once. This is a one-shot guard: it fires once per resume and
once again when a payment is detected, but a plain fresh page load (no
callback parameter, no pending record) never auto-scrolls.

## Limitations

- Every Amber request is a visible app round-trip (NIP-55 web flow has no
  background signing for web clients).

## Testing

Unit tests for the URL builder and result decoding run in Node (≥18):

```
node --test signing-form/test/*.mjs
```

Manual end-to-end verification (requires an Android device with Amber
installed and a key set up):

1. Serve `signing-form/` over HTTPS (or use the live deployment) and open it
   in an Android browser.
2. Verify the signer card shows "Sign with Amber" and the guidance text
   mentions Amber (no desktop extension links).
3. Fetch the office-coffee test petition
   (`30023:877d7acaa4c0c0c517f511c7e72275de726ceb34aee99988ee2f2ed67040c8ac:office-coffee-2026`).
4. Fill in entity type / statements, hit **Sign with Amber**, approve in
   Amber.
5. On return: form state restored, event validated, relay publish results
   shown, UI flips to the already-signed success state.
6. Reject the request in Amber and navigate back manually: the form restores
   your input and shows the retry/paste fallback.
7. Sign again from the same key: the duplicate check should surface the
   existing signature instead of publishing a second event.
8. Hit **Sign Zap Event** on the zap card: Amber should open with the
   kind:9734 zap request; approve it. On return the card should restore
   with **✓ Zap event signed**, fetch the invoice, and enable **Pay Zap
   Invoice** — tapping Pay should raise Android's wallet chooser (or your
   default Lightning wallet). The QR + copy-invoice fallback renders
   below. The page should scroll the zap card back into view on return.
9. Reject the zap request in Amber and navigate back manually: the zap
   card restores with the paste-box fallback, **Sign Zap Event** live for
   a retry, and **Pay Zap Invoice** still disabled.
10. (State-loss resilience) Complete step 8 but have the callback open in
    a fresh tab (e.g. long-press the notification / different browser
    profile targeting the same URL): the flow should still resume from
    the signed request itself — or show a visible error with retry, never
    a silent dead-end.
11. Once the symbolic zap receipt lands: the zap card should
    completion-lock (Sign/Pay controls replaced by a green success notice
    showing only the symbolic zap's amount), and the "5. Make a larger
    donation" card should appear.
12. On the donation card, enter an amount and hit **Sign Zap Event**:
    Amber should open with the kind:9734 donation zap request (its own
    `?donatevent=` callback). On return, sign → fetch invoice → **Pay Zap
    Invoice** should follow the same shape as the symbolic zap.
13. After the donation payment is detected: the donation card should show
    a "Donation received" notice, list the payment in the accumulating
    payments panel (with a running sats total), reset the amount field,
    and scroll the donation card back into view. Repeat with a second
    donation amount to confirm payments accumulate instead of replacing
    each other, and that the symbolic-zap card's locked notice is
    unaffected.
