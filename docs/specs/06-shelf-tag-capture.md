# Shelf tag capture

> **Living document.** First pass, 2026-08-23; revised same day twice — once after the first
> on-device test (Pixel 7) surfaced a schema-exposure bug that made every save fail, and again
> after five real Walmart tags photographed in-store (three matched against their package
> barcode) surfaced a live data-corruption bug in `store_item_code` handling and several
> extraction gaps. See the "Shelf tag capture" entry in `deferred.md` for the full account of
> what changed and why. Describes the present. If it disagrees with the code, say so rather
> than quietly following either.

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

- **Price** — the tallest of two kinds of candidate: a single currency-shaped OCR element
  (`$3.99`), or a `$<digits>` element immediately followed by a bare 1–2 digit element in the same
  reconstructed row (`$11` + `87` → 1187 cents). The second shape exists because digital/e-ink
  shelf tags commonly print the cents as a visually separate (often superscript) element with no
  decimal point anywhere in the text — the on-device test tag that motivated this file is one.
  Geometry (row reconstruction, element height) is used for both: the tag's total price is
  reliably the largest glyph on it, bigger than a unit-price annotation or a was-price
  strikethrough. If OCR never recognized the price text at all (also observed on-device — see
  `deferred.md`), this correctly returns null rather than guessing; the price field stays a plain
  editable input.
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
  footer at all. **This is never treated as a store item code** — see the next bullet — and
  is fed into `retailer_product.tag_identifier` on the create path (see "Resolution flow"
  below) only as match-verification/candidate-narrowing signal, never as a lookup key.
- **Store item code is not extracted from the tag at all.** There is currently no known way to
  read a real store SKU off a Walmart shelf tag — everything on the footer is
  facing/capacity/UPC-fragment (above), never a chain item number. An earlier version of this
  parser filled `storeItemCode` with a longest-digit-run guess that, on a real tag, turned out to
  be that UPC fragment — which was then used as the exact-match key against
  `retailer_product.store_item_code`, silently mis-attaching `price_observation` rows to the
  wrong product on any collision (append-only, ADR 0003, so uncorrectable). Fixed by removing
  the extraction entirely: `storeItemCode` is a plain manual-entry field on the review screen,
  never prefilled. See `deferred.md` for the full incident writeup.
- **Description guess** — the OCR row with the most letters that isn't a price/unit-price/footer
  row. A prefill, nothing more.

Unit tokens (`OZ`, `LB`, `FL OZ`, `EACH`, ...) map to `unit_of_measure.code` through a fixed
alias table in `shelfTag.ts`. An unrecognized token maps to `null` rather than a guess.

Tests in `shelfTag.test.ts` are entirely synthetic fixtures as of 2026-08-23. There are zero real
on-device OCR fixtures — the one that existed (`tai-pei-shelf-tag.json`) has been removed: its
subject was an internet screenshot, not a tag physically photographed in-store, so it didn't meet
this project's "test against real device output" bar despite carrying genuine ML Kit geometry.
Ground truth for four real Walmart tags (ramen, celery, milk, corn — covering split vs.
non-split price rendering, the `PER EA` degenerate case, a two-token unit, e-ink vs. paper tag
format, and a paper-tag effective date) is recorded in `deferred.md`, awaiting device
re-capture to become real fixtures.

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
   `tag_format`, `upc_fragment`, `qr_token` extraction found (`buildTagIdentifier` in
   `shelfTags.ts`; `null` when none did) — written to `retailer_product.tag_identifier jsonb`
   (migration `add_retailer_product_tag_identifier`, 2026-08-23). This is match-verification and
   candidate-narrowing signal, **never sufficient for a match on its own** — nothing reads it
   back for that purpose yet, and it is never used as a lookup key the way `store_item_code` is
   in step 2. On the create path only, also call `app.create_provisional_product_alias` with the
   printed description text, `confidence = null` (the stub `ConfidenceProvider` returns unknown
   for everything — see `04-review-queue.md`). Both of these create-path-only calls are skipped
   on the match path: matching on `store_item_code` already means this isn't new phrasing or
   signal worth recording.
4. Call `app.record_price_observation` (existing RPC) with `observation_source = 'shelf_tag'`,
   `capture_id`, and the price/size/unit fields above. The RPC computes `normalized_unit_price`
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
outcome (see `deferred.md`), not worth a permanent empty row on every capture.

`price_kind` (`regular` / `sale` / `clearance`) is a manual toggle on the review screen,
defaulting to `regular` — shelf tag color/format usually signals this but isn't something OCR
text alone reliably captures, so it's asked rather than guessed.

## Known gaps

See the "Shelf tag capture" entry in `docs/decisions/deferred.md`.
