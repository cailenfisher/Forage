# ADR 0016 — QR resolution is out-of-band, best-effort alias enrichment, not identity linking

- **Date:** 2026-08-23
- **Status:** Superseded by 0017

## Context

Shelf-tag capture already decodes the tag's own QR code (`src/ocr/scanBarcode.ts`) and persists
it. Real Walmart tags encode a shortlink (`w-mt.co/q/<token>`) that presumably redirects to a
`walmart.com` item page — a page that, unlike the tag itself, carries a brand name and full
product description the tag never prints (see the "Brand is confirmed absent from shelf tags"
entry in `deferred.md`). Following that link is this project's **first outbound network
dependency on a third party**, which `docs/decisions/deferred.md`'s shelf-tag-capture entry
flagged as needing its own ADR before building, per `CLAUDE.md`'s "spec-first" working
agreement.

Two things constrain the design more than they might first appear to:

- **`product_class` and `brand` both have zero rows in this database.** Full identity
  resolution — creating a `product` row via the existing-but-unused
  `app.create_provisional_product` RPC and linking it to `retailer_product.product_id` — needs a
  `product_class_id`, and nothing in this project classifies commodities yet (ADR 0005 defines
  the concept; nothing populates it). Inventing a classification scheme to unblock this feature
  would be exactly the kind of improvised, unreviewed design `CLAUDE.md` says to stop and ask
  about, and it's already tracked as its own, larger, separately-deferred gap ("Product identity
  resolution... is unbuilt" in `deferred.md`).
- **There is no RPC to attach a `product_id` to an existing `retailer_product` after the fact.**
  `create_provisional_retailer_product` only sets `product_id` at creation. Adding one is a
  reasonable future migration, but it's a separate decision from "should this app fetch a
  third-party URL," and bundling them would make this ADR about two different risks at once.

So this ADR scopes "QR resolution" down to what's actually buildable today without inventing
either of those: **turn a resolved page into better matching signal for the `retailer_product`
that already exists**, using machinery that already exists (`create_provisional_product_alias`,
`capture_artifact`). Full identity linking stays exactly as deferred as it already was.

## Decision

**What it fetches, and how little.** A `HEAD` request (never `GET` — no need to download a
page body) to the decoded QR string, with `redirect: 'follow'`, reading only the final
`Response.url` after redirects. Walmart item pages follow a stable `/ip/<slug>/<numeric-id>`
shape (confirmed against several real `walmart.com` URLs during design, not assumed); the slug
is de-slugified (hyphens → spaces) into a candidate description. **No HTML parsing, no
JavaScript rendering, no scraping of page content** — deliberately, both because Walmart's
actual page markup was not something this session could verify against a real token, and
because reading a redirect target is a categorically lighter-weight, lower-risk operation than
scraping a page body. **The final URL's host must be `walmart.com` (or a subdomain)**, checked
explicitly — matching the `/ip/.../<id>` path shape alone isn't trusted, since a retired or
repointed shortlink could redirect anywhere and this result eventually becomes a
household-visible `product_alias`.

**Strictly out-of-band.** Triggered by the capture screen only *after*
`saveShelfTagObservation` has returned successfully — meaning `capture`, `capture_image`,
`capture_artifact` (OCR and, if present, barcode), `retailer_product`, and `price_observation`
are all already durably written. Not awaited: the screen transitions to "done" immediately
regardless of what resolution does. If `saveShelfTagObservation` itself fails, resolution never
runs — there is no `retailer_product` yet to enrich.

**Fails silently, always.** `resolveShelfTagQr` (`src/lib/shelfTags.ts`) never throws and never
surfaces anything to the UI — no spinner, no toast, no retry. A local (non-network-round-trip)
connectivity check via `expo-network`'s `getNetworkStateAsync()` skips the attempt entirely when
offline; a 2-second `AbortController` timeout backstops the "connected but not actually
reachable" case the connectivity check can't catch. One attempt, on that capture's own code
path — no background timer, no sweep over past artifacts.

**Result is provisional evidence, recorded twice, never authoritative:**

1. A **new `capture_artifact` row** (`parser_version = QR_RESOLUTION_VERSION`,
   `raw_output = {finalUrl, walmartItemId, canonicalNameGuess}`), retained permanently under ADR
   0002 — the same "one row per parser run" pattern already used for the OCR and barcode
   artifacts on this capture, so a resolution attempt (successful, no-match, or unattempted) is
   always visible on replay even when it doesn't get this far again below.
2. When a candidate description was found: **one call to the existing
   `create_provisional_product_alias` RPC**, `p_retailer_product_id` = the retailer_product this
   save just matched-or-created, `p_printed_text` = the de-slugified name, `p_confidence = null`
   (the stub `ConfidenceProvider` returns unknown for everything — same as every other alias
   this codebase writes). Feeding the *alias* path rather than inventing a *product-identity*
   path is the deliberate scope cut this ADR makes: an alias is reviewable, additive, and never
   overwrites anything; nothing about it claims the page's brand/name is confirmed truth.

**Never touches `store_item_code` or `tag_identifier`.** The resolved Walmart item ID is
*server-confirmed evidence from a fetch*, not *something printed on the tag* — conflating those
two categories is exactly the mistake the `store_item_code`/UPC-fragment incident earlier this
same day made. It has nowhere to go yet other than the artifact row above, and that's fine:
non-negotiable #2 says an absent field is recoverable, and this one is recorded, just not
wired to a column.

## Consequences

- **Untested against Walmart's actual anti-bot posture.** A bare `fetch` with no browser-like
  headers may be blocked, rate-limited, or served a CAPTCHA at the HTTP level before any
  redirect completes. The connectivity check and timeout guard against *network* failure, not
  against a request that "succeeds" with a blocked or unexpected response — `parseWalmartItemUrl`
  returning `null` (no `/ip/.../<id>` match) is the catch-all for that, and it's a normal,
  logged-but-silent outcome, not a bug. This is explicitly the thing the user's manual
  on-device testing needs to establish; nothing here should be read as validated.
- **HEAD may not be honored identically to GET by every hop in the chain.** If on-device testing
  shows `w-mt.co` or `walmart.com` doesn't redirect correctly on `HEAD`, the fix is a one-line
  method change to `GET` (still reading only `.url`, never the body) — noted here so that fix
  doesn't require re-litigating this ADR.
- **A future ADR is still needed** before `retailer_product.product_id` can ever be set
  post-creation, and before `product_class`/`brand` get populated at all. This feature does not
  unblock either; it only makes the alias corpus for a `retailer_product` richer than OCR alone
  produces.
- **Every shelf-tag save with a decoded QR now makes an outbound request to a third-party
  domain** (the shortlink host, then `walmart.com`) from the user's device, on a Walmart-owned
  URL the household itself scanned. No credentials, household data, or identifying information
  beyond normal HTTP request metadata (IP, user agent) are sent — the request carries nothing
  but the URL the tag itself encoded.
