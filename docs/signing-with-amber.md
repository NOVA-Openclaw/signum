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

The NIP-57 spam-gate **zap request (kind:9734) is signed through the same
round-trip** as the petition signature: hitting **Zap** builds the zap
request (e-tagging your signature event, with the petition `a` tag, amount,
and relays), launches Amber to sign it via `?zapevent=` callback (its own
parameter and pending-state slot, so a reload mid-zap resumes the zap flow
and is never confused with a pending signature or connect), validates the
result on return (kind, tags, amount, id/sig verification, and that the
signing key matches the key that signed the petition — a mismatched key
would produce a receipt that is never credited), and only then fetches the
invoice from the LNURL callback with the signed request attached.

Once an invoice exists, payment is offered as:

- **`lightning:` URI** — primary on mobile: tapping “Open in wallet” hands
  the invoice to the OS, so Android shows its wallet chooser when several
  Lightning wallets are installed;
- **WebLN** one-click on desktop where present;
- **QR code + copy-invoice** as the universal fallback.

If a signed zap request cannot be produced, the form shows an explicit
choice (retry / knowingly pay uncredited / zap natively) — never a silent
fallback to a plain non-creditable invoice.

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
8. Hit **Zap** on the zap card: Amber should open with the kind:9734 zap
   request; approve it. On return the form should fetch the invoice and
   show **⚡ Open in wallet** — tapping it should raise Android's wallet
   chooser (or your default Lightning wallet).
9. Reject the zap request in Amber and navigate back manually: the zap
   card restores with the paste-box fallback and the Zap button live for
   a retry.
