# ADR 0017 — Online QR shortlink resolution abandoned; local capture and storage stand

- **Date:** 2026-08-23
- **Status:** Accepted
- **Supersedes:** 0016

## Context

ADR 0016 built out-of-band resolution of the shelf tag's decoded QR shortlink against
`walmart.com`, scoped deliberately narrow (alias enrichment only, never identity linking, never
a lookup key). Same-day, on-device testing found it doesn't work in practice, for two
independent reasons — neither of which is a bug in that implementation:

**Bot detection blocks it, reliably.** Three independent automated requests to the resolved
`walmart.com` URL — the app's original `HEAD` request, the app's `GET` fallback (ADR 0016's own
named contingency for exactly this case), and a manual fetch from a completely unrelated
client — were all blocked or served a CAPTCHA/bot-verification interstitial
(`www.walmart.com/blocked?url=...` for the in-app attempts; a "confirm you're human" challenge
page for the out-of-band one). This isn't a missing header or wrong HTTP method; it's Walmart's
anti-bot system doing its job against exactly this shape of traffic.

**Even unblocked, the destination isn't scrapable the way ADR 0016 assumed.** Manual inspection
of a resolved URL (`https://www.walmart.com/ip/seort/15570901?s=1935&veh=st_qr_db&...`) in a
real browser shows a dynamic, client-rendered product page built around a *product family*, with
flavor, size, and pack count presented as interactive variant chips rather than encoded in
static content — for the ramen tag specifically, "beef" and "single" are the pre-selected chips
among several other flavor and size options on the same page. Getting the one exact SKU the tag
printed would mean either running a real JS engine or reverse-engineering whatever private API
populates those chips. Separately, the URL's own slug (`seort`) is not the human-readable
product name ADR 0016's `parseWalmartItemUrl` assumed — that assumption came from organic
search-result URLs (e.g. `.../Nissin-Top-Ramen-Beef-Flavor-Ramen-Soup-3-Oz-Pack-of-5/176059655`),
which are shaped differently from QR-sourced ones. Even a clean, unblocked fetch would not have
produced a usable name via that method for this URL family.

Closing either gap — mimicking more of a real browser to dodge bot detection, or scraping
rendered/dynamic page state — trades away the "smallest possible request, best-effort,
out-of-band" principle ADR 0016 was built around, and drifts toward actively working around
anti-scraping measures. Not a good trade for a personal price-tracking tool, and explicitly
out of scope regardless.

## Decision

- **Online resolution — the fetch/scrape half of ADR 0016 — is abandoned, not deferred for a
  future retry under the same design.** Removed: `src/lib/qrResolution.ts`, `src/lib/walmartUrl.ts`
  (+ its test), `resolveShelfTagQr` and its wiring in `shelfTags.ts`, the QR-resolution debug
  card in the shelf-tag capture screen, the `expo-network` dependency (only used by the removed
  code). No replacement fetch mechanism is being built.
- **Local QR capture and storage stand, unchanged.** Decoding the tag's QR via `scanBarcodes`
  (`src/ocr/scanBarcode.ts`) and persisting the full raw decoded string in its own
  `capture_artifact` row (ADR 0002) was never part of ADR 0016's decision — it's retained as-is.
  The complete decoded URL (e.g. `w-mt.co/q/300ctBZ0VD4J3-ZDQBP`) is durable, permanent evidence
  on every capture that has a scannable QR, independent of whether anything ever resolves it.
  `retailer_product.tag_identifier.qr_token` (the Section 4 proposal in `deferred.md`) also
  keeps being written from the locally-decoded token — that write never depended on resolution
  succeeding.
- **A future direction, not built:** launching a system browser with the decoded URL so a
  *human* reviewing the item can look at the real Walmart page themselves. This sidesteps both
  problems above outright — a real browser with a real user isn't what the bot detection is
  built to block, and a human, not a parser, is looking at the variant chips. Noted here so the
  retained raw QR data is understood to still have a purpose, not preserved out of inertia.

## Consequences

- No further engineering effort should go into resolving the shortlink server-side or
  client-side without a materially different approach (a real browser context, most plausibly —
  see the future direction above). Re-attempting the same fetch-and-parse shape without a new
  reason to believe the blocking has changed would be repeating this ADR's finding, not learning
  from it.
- The alias-enrichment value ADR 0016 hoped to add (a description better than what OCR reads off
  the tag) is not recovered by this ADR. It remains exactly as absent as it was before ADR 0016
  was written — see "Brand is confirmed absent from shelf tags" in `deferred.md`.
