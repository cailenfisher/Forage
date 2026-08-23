# Shelf tag capture

> **Living document.** First pass, 2026-08-23; revised the same day several times — after the
> first on-device test (Pixel 7) surfaced a schema-exposure bug that made every save fail; after
> five real Walmart tags photographed in-store surfaced a live data-corruption bug in
> `store_item_code` handling and several extraction gaps; and after an online QR-resolution
> feature (ADR 0016) was built, tested against a real device, and abandoned the same day (ADR
> 0017) once it hit both bot detection and an unscrapable page structure. See the "Shelf tag
> capture" entry in `deferred.md` for the full account of what changed and why. Describes the
> present. If it disagrees with the code, say so rather than quietly following either.

## What this is

The "scout mode" capture path from `00-project-overview.md`: photograph a shelf tag, get a
`price_observation`, buy nothing. `capture_type = 'shelf_tag'`, `observation_source = 'shelf_tag'`.

Unlike receipt scanning, this is the **first feature that actually writes `price_observation`
rows** — the receipt flow never resolves `retailer_product`, so that table has been unused
until now (see the "Capture and ingestion" entry in `deferred.md`). Because
`price_observation.retailer_product_id` is `NOT NULL`, shelf tag capture cannot defer identity
resolution the way receipts do; it has to resolve or create a `retailer_product` on every save.

## Why this isn't a staged geometric parser like receipts

`02-parser-pipeline.md` describes a multi-stage, layout-aware parser because a receipt has many
line items whose descriptions and prices must stay correctly paired — flattening to a string
loses that pairing, and there's a real fixture corpus to validate stages against.

A shelf tag photographs **one item**. There's no cross-item pairing problem to preserve, no
existing fixture corpus for the wildly varying layouts different retailers use, and no spec to
review a heavier approach against. Building a bespoke multi-stage shelf-tag layout parser now
would be exactly the kind of unreviewed heuristic `CLAUDE.md` says to stop and write down first.

Instead, `src/parse/shelfTag.ts` is a **single pure function**, `extractShelfTagFields`, that
does best-effort regex extraction over the OCR text plus one geometry-based check (see below),
and every field it returns is a **prefill in an editable field**, never a value written without
the user seeing it. This keeps the non-negotiable "never silently guess to fill a gap" intact
even though the extraction itself is deliberately unsophisticated.

**ADR 0018 (2026-08-23, accepted and built)** adds one more step without turning this into a
staged geometric parser: `extractShelfTagFields` scores the OCR text and reconstructed rows
against five seeded `shelf_tag_template_version` rows (Walmart ESL, Walmart paper, and three
Aldi layouts — standard, price-drop, numeric-only) using cheap content signals only (literal
token grammar, a standalone-digit-row shape, badge text) — no tag-boundary detection, no
rectification. `src/parse/shelfTagTemplates.ts` implements the scoring and per-template field
overrides as hand-written TS, not a generic jsonb-driven rule engine — the `match_rules`/
`field_manifest`/`extraction_rules` columns on `shelf_tag_template_version` are a documentary
mirror of that code for audit/replay purposes, not something read back and executed. **Never
gates**: below a 0.5 match threshold, `templateMatch` is `null` and every field falls through to
the flat, retailer-agnostic extraction exactly as it worked before this existed. Matching is
retailer-agnostic by necessity, not just by design preference — the current capture flow doesn't
know which retailer/store the user will pick until after review starts (see "Resolution flow"
below), so `extractShelfTagFields` still can't take a retailer argument and stay pure/I-O-free.

- **Price** — the tallest of two kinds of candidate: a single currency-shaped OCR element
  (`$3.99`), or a `$<digits>` element immediately followed by a bare 1–2 digit element in the same
  reconstructed row (`$11` + `87` → 1187 cents). The second shape exists because digital/e-ink
  shelf tags commonly print the cents as a visually separate (often superscript) element with no
  decimal point anywhere in the text — the on-device test tag that motivated this file is one.
  Geometry (row reconstruction, element height) is used for both: the tag's total price is
  reliably the largest glyph on it, bigger than a unit-price annotation or a was-price
  strikethrough. If OCR never recognized the price text at all (also observed on-device — see
  `deferred.md`), this correctly returns null rather than guessing; the price field stays a plain
  editable input. **Known gap (multi-retailer evidence batch, 2026-08-23, not yet fixed):** both
  candidate shapes require a literal `$`, so a cents-only price with no dollar sign at all
  (`46¢`, `33¢` — common on real Walmart tags for low-priced items) matches neither and returns
  null; on at least one observed layout it's worse than null, and the field instead picks up a
  differently-meaning value from the tag (a well-formed unit price). See the "Live bug" entry in
  `deferred.md`'s "Shelf tag capture" section for the full account — fixing it needs on-device
  confirmation of how ML Kit segments a cents glyph before the pattern work happens.
- **Unit price** — a `$X.XX/UNIT`, `X.X/UNIT`, or `X.X¢/UNIT` pattern, shown to the user
  **verbatim** (`displayAmount`, e.g. `"25.5"` or `"$0.25"`) rather than parsed into cents — a
  cents-denominated or single-decimal amount can't be forced through
  dollars-and-exactly-two-decimals without either rejecting valid data or fabricating precision
  that wasn't printed. Checked two ways: a row-adjacent split dollars+cents pair followed by a
  `/unit` or `per unit` suffix within the same row (e.g. `["$3", "67", "PER", "EA"]`), same
  digital-tag rendering style as the split main price, checked first because it's more specific;
  falling back to the flattened-text pattern (e.g. `"4.5¢ PER FL OZ"`) when no split pair is
  present. The unit half of either match tries each known 1- or 2-word unit from `UNIT_ALIASES`
  (longest first) before falling back to a single bare word, so a two-word unit like `FL OZ` is
  captured whole rather than truncated to `FL`. Carries `isDegenerate: true` when `unitCode` is
  `"each"` — the tag is printing the total price a second time with no new information (common
  on per-each produce and bulk items); the review screen skips the redundant hint in that case.
  Informational only; never written to a field automatically.
- **Size** — a bare `<qty> <unit>` token, found only after stripping out the unit-price fragment
  so `$0.25/OZ` can't also register as a `0.25 OZ` size.
- **Tag footer** — Walmart tags print a `FAC <n> CAP <n> [<fragment>]` footer (shelf facing,
  capacity, and — on e-ink tags only — a trailing 4-digit fragment). `extractTagFooter` anchors
  on the literal `FAC`/`CAP` tokens and takes the fragment by *position* (whatever follows
  `CAP <n>`), not by scanning for the longest digit run on the tag — the previous approach,
  which is what let a multi-digit capacity (e.g. `CAP 1440`) get mistaken for the fragment.
  Confirmed against three real tag/package pairs that the fragment is the tail of the package's
  UPC-A (check digit dropped, last four digits kept). Returns `null` when the tag has no such
  footer at all. Walmart-specific and unchanged by ADR 0018 — `tagFooter.format` still feeds
  `tag_identifier.tag_format` exactly as before.
- **Identifier candidate (ADR 0018)** — the generalized, retailer-agnostic replacement for the
  old Walmart-only inline "use the footer fragment" special case. When a template matches, it
  may set `identifierCandidate: { key, value }`: Walmart ESL asserts `key: 'upc_fragment'` from
  the same footer fragment above; the three Aldi templates assert `key: 'unknown'` from a
  standalone 6-digit row in the tag's footer area — real signal (six digits against Aldi's
  ~1,400–2,000-SKU assortment makes collision negligible, unlike Walmart's four digits against a
  100,000+ item catalog) but **not yet confirmed what it actually represents**, so it gets a
  placeholder key rather than a confident-sounding one like `store_item_code` (non-negotiable
  #2 — see ADR 0018 and `deferred.md`). Walmart paper deliberately asserts nothing: the corn
  tag's own `4100-0001`-shaped code is a different, unconfirmed field (open question in
  `deferred.md`). Feeds `retailer_product.tag_identifier` on the create path (see "Resolution
  flow" below) — match-verification/candidate-narrowing signal only, never a lookup key, never
  `store_item_code`.
- **Store item code is not extracted from the tag at all**, for any template. There is currently
  no known way to read a real store SKU off a shelf tag from either build-target retailer —
  Walmart's footer is facing/capacity/UPC-fragment, never a chain item number, and Aldi's
  6-digit code's real meaning is still unconfirmed (above). An earlier version of this parser
  filled `storeItemCode` with a longest-digit-run guess that, on a real tag, turned out to be
  Walmart's UPC fragment — which was then used as the exact-match key against
  `retailer_product.store_item_code`, silently mis-attaching `price_observation` rows to the
  wrong product on any collision (append-only, ADR 0003, so uncorrectable). Fixed by removing
  the extraction entirely: `storeItemCode` is a plain manual-entry field on the review screen,
  never prefilled. See `deferred.md` for the full incident writeup.
- **Description guess** — the OCR row with the most letters that isn't a price/unit-price/footer
  row. A prefill, nothing more. **Brand (ADR 0018)** — when the `aldi-esl-standard` template
  matches and exactly two non-noise rows remain (the shape confirmed across three Aldi samples:
  an all-caps brand line directly above a mixed-case product-name line), the first is split out
  as `brand` and the second becomes `descriptionGuess`, rather than the flat "most letters wins"
  rule picking the name and silently dropping the brand line — see `deferred.md`'s correction to
  "brand is confirmed absent from shelf tags" (that claim holds for Walmart's ESL template only).
  The review screen combines `brand` + `descriptionGuess` back into one editable text prefill
  (there's no separate brand field or product-identity resolution yet — see "Product identity
  resolution... is unbuilt" in `deferred.md`), so nothing printed is silently dropped, but nothing
  new is queryable as its own column either.

Unit tokens (`OZ`, `LB`, `FL OZ`, `EACH`, ...) map to `unit_of_measure.code` through a fixed
alias table in `shelfTag.ts`. An unrecognized token maps to `null` rather than a guess.

Tests in `shelfTag.test.ts` are entirely synthetic fixtures as of 2026-08-23. There are zero real
on-device OCR fixtures — the one that existed (`tai-pei-shelf-tag.json`) has been removed: its
subject was an internet screenshot, not a tag physically photographed in-store, so it didn't meet
this project's "test against real device output" bar despite carrying genuine ML Kit geometry.
Ground truth for twelve real tags across three retailers — five Walmart, five Aldi, two Dollar
Tree (Dollar Tree is a generalization stress test only, not a build target) — is recorded in
`deferred.md`'s "Shelf tag capture" entry, covering split vs. non-split price rendering, the
`PER EA` degenerate case, a two-token unit, e-ink vs. paper tag format, a paper-tag effective
date, cents-only pricing, inverted colour, brand/name splits, and normalized sizes in a
different unit family from the package — awaiting device re-capture to become real fixtures.
This is also the evidence base for ADR 0018 (accepted, built same day) — the template-matching
layer described above is exercised only against synthetic fixtures in `shelfTag.test.ts` so far,
same as the rest of this file; it has not been run against a real device capture for either
build-target retailer yet.

## The price model: total price + optional size, not per-unit vs. per-package branches

A shelf tag's price can mean two different things: "$3.99 for this 16 oz box" (packaged goods)
or "$1.99/lb" (produce, bulk, deli). Rather than branch the UI on which shape applies, the
review screen always asks for one **total price** and an **optional size** (quantity + unit):

- Packaged good: price = 3.99, size = 16 oz. `record_price_observation` normalizes using
  `unit_of_measure.base_factor` the same way it would for any other sized item.
- Per-pound item: price = (the per-lb price), size = 1 lb. Degenerates correctly to the same
  normalization math without a separate code path.
- No size entered at all: `size_quantity` and `unit_of_measure_id` stay `null`, and so does
  `normalized_unit_price` — missing data recorded as missing, never fabricated to fill the gap.

The review screen requires quantity and unit **together or not at all** — a bare number with no
unit isn't a size, so Save is blocked until both are filled in or both are left empty.

## Resolution flow

1. User selects a store (same store list/UX as receipt capture) — resolves `retailer_id`.
2. If the user typed in a store item code (never auto-filled — see "Store item code is not
   extracted from the tag at all" above), look up an existing `retailer_product` for
   that `(retailer_id, store_item_code)` pair. `store_item_code` is only unique per retailer
   (ADR 0004), so the lookup is always retailer-scoped, never global. The review screen shows a
   "matches an existing catalog item" note as soon as both are known, so the user isn't
   surprised by matched-vs-created after saving.
3. **Match found** → attach the new observation to it. **No match** → call
   `app.create_provisional_retailer_product` (existing security-definer RPC; shared-tier tables
   are writable only through these — see `03-data-model.md`) with `product_id = null` (identity
   resolution — brand, product class, canonical size — is unbuilt for shelf tags just as it is
   for receipts; this file does not change that) and `p_tag_identifier` set to whichever of
   `tag_format`, an `identifierCandidate` key (`upc_fragment` or `unknown` — ADR 0018), or
   `qr_token` extraction found (`buildTagIdentifier` in `shelfTags.ts`; `null` when none did) —
   written to `retailer_product.tag_identifier jsonb` (migration
   `add_retailer_product_tag_identifier`, 2026-08-23). This is match-verification and
   candidate-narrowing signal, **never sufficient for a match on its own** — nothing reads it
   back for that purpose yet, and it is never used as a lookup key the way `store_item_code` is
   in step 2. On the create path only, also call `app.create_provisional_product_alias` with the
   printed description text, `confidence = null` (the stub `ConfidenceProvider` returns unknown
   for everything — see `04-review-queue.md`). Both of these create-path-only calls are skipped
   on the match path: matching on `store_item_code` already means this isn't new phrasing or
   signal worth recording.
4. Call `app.record_price_observation` (existing RPC) with `observation_source = 'shelf_tag'`,
   `capture_id`, the price/size/unit fields above, and `p_shelf_tag_template_version_id` (ADR
   0018) — resolved from the pure parser's `templateMatch` (a `{slug, version}` pair) to a real
   `shelf_tag_template_version.id` by `resolveShelfTagTemplateVersionId` in `shelfTags.ts`, via
   two plain lookups rather than an embedded-resource filter query. Best-effort like everything
   else in this step: a resolution miss leaves the column `null`, same as a tag that didn't match
   any template at all — it never blocks the save. The RPC computes `normalized_unit_price`
   server-side and stamps `contributed_by_user_account_id` from `auth.uid()`.

All four RPCs already existed in the database (`create_provisional_product` too, unused by this
flow), built but unreachable until this feature: they're implemented in the `app` Postgres
schema, but this project's PostgREST instance only exposes `public` and `graphql_public`, so a
client calling `app.create_provisional_retailer_product` by name got a 404 every time, regardless
of caller. Migration `expose_provisional_write_rpcs` (2026-08-23) added thin `public.*` wrapper
functions with identical signatures that forward to the `app.*` implementations — the client code
calls the plain unqualified name (`supabase.rpc('create_provisional_retailer_product', ...)`) and
PostgREST now finds it. The `app.*` functions still do their own `auth.uid()` check and keep their
own `SECURITY DEFINER` privileges; the wrapper is invoker-rights and adds no new capability, only
reachability. `app.reconcile_review_task` has the same unreachability and no wrapper yet — nobody
calls it today, but it will need one before the review-queue reconciliation pass is built.

## Capture, image, and artifact

Same shape as receipts (`01-capture-pipeline.md`): `capture` → `capture_image` →
`capture_artifact` land durably before resolution/observation is attempted, in that order, and
the raw OCR JSON is kept permanently regardless of whether the best-effort steps after it
succeed. `capture_image` uses its own bucket, `shelf-tag-images` — split from `receipt-images`
per the pipeline spec's "split buckets by capture type" rule (shelf tag photos are pictures of a
store's public price and are shareable for dispute resolution; receipt photos are not).

The capture photo is also run through `scanBarcodes` (`src/ocr/scanBarcode.ts`, `expo-camera`'s
`scanFromURLAsync`, restricted to `['qr']`) in parallel with OCR. When at least one barcode
decodes, its raw result is written to a **second** `capture_artifact` row
(`parser_version = BARCODE_SCAN_VERSION`) — same "one row per parser run" model as the OCR
artifact (ADR 0002), landed durably alongside it, not merged into the OCR artifact's
`raw_output`. Nothing is written when nothing decodes; an unreadable or absent QR is a normal
outcome (see `deferred.md`), not worth a permanent empty row on every capture. The decoded QR's
path segment also feeds `retailer_product.tag_identifier.qr_token` on the create path — see
"Resolution flow" above.

Per ADR 0017: this project **does not** fetch or resolve the decoded QR shortlink online — that
was tried (ADR 0016) and abandoned the same day after real-device testing hit both Walmart's
bot detection and a page structure unsuitable for static scraping. The raw decoded URL is kept
for a possible future human-in-the-loop use (opening it in a system browser for a person to
review), not for any automated resolution. See `deferred.md` for the full trail.

`price_kind` (`regular` / `sale` / `clearance`) is a manual toggle on the review screen,
defaulting to `regular`. Not detected from the tag today; at least one observed retailer template
signals sale/clearance in OCR-visible text (not only color), so detection is more tractable than
originally assumed — see `deferred.md`. **The default is a known, unresolved gap, not a settled
design**: under snap-and-forget, an unreviewed promotional tag writes `regular`, indistinguishable
from a user-confirmed `regular`, which is exactly the promotional-baseline damage ADR 0003
introduced this column to prevent. Flagged in `deferred.md` as STOP AND ASK — needs a decision
before this default is treated as correct behavior. Each `shelf_tag_template_version` (ADR 0018)
also carries a `price_kind` value (e.g. the Aldi price-drop template asserts `sale`) — stored as
data for future use, but **deliberately not wired into this write path or the review screen in
this pass**. Doing so would mean deciding whether a template's assertion is auto-fill or a
user-confirmed prefill, which is exactly the STOP-AND-ASK gap above; wiring it in without that
decision would just move the same unresolved problem to a new source.

## Known gaps

See the "Shelf tag capture" entry in `docs/decisions/deferred.md`.
