# Shelf tag capture

> **Living document.** First pass, 2026-08-23; revised same day after the first on-device test
> (Pixel 7) surfaced a schema-exposure bug that made every save fail, plus real extraction gaps.
> See the "Shelf tag capture" entry in `deferred.md` for what changed and why. Describes the
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
- **Unit price** — a `$X.XX/UNIT`, `X.X/UNIT`, or `X.X¢/UNIT` pattern found in the flattened OCR
  text, shown to the user **verbatim** (`displayAmount`, e.g. `"25.5"` or `"$0.25"`) rather than
  parsed into cents — a cents-denominated or single-decimal amount can't be forced through
  dollars-and-exactly-two-decimals without either rejecting valid data or fabricating precision
  that wasn't printed. Informational only; never written to a field automatically.
- **Size** — a bare `<qty> <unit>` token, found only after stripping out the unit-price fragment
  so `$0.25/OZ` can't also register as a `0.25 OZ` size.
- **Store item code** — a standalone digit run (4–14 digits) sitting in its own OCR element,
  same heuristic and same caveats as the receipt parser's `store_item_code` extraction (see
  `deferred.md`): untested against a tag where an unrelated number would false-positive.
- **Description guess** — the OCR row with the most letters that isn't a price/unit-price/code
  row. A prefill, nothing more.

Unit tokens (`OZ`, `LB`, `FL OZ`, `EACH`, ...) map to `unit_of_measure.code` through a fixed
alias table in `shelfTag.ts`. An unrecognized token maps to `null` rather than a guess.

Tests in `shelfTag.test.ts` are mostly synthetic fixtures; `tai-pei-shelf-tag.json` is the one
real on-device fixture so far (Pixel 7, ML Kit), pulled from an actual failed capture. One tag is
a start, not a corpus — real-device validation breadth is still open work.

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
2. If a store item code was extracted or typed in, look up an existing `retailer_product` for
   that `(retailer_id, store_item_code)` pair. `store_item_code` is only unique per retailer
   (ADR 0004), so the lookup is always retailer-scoped, never global. The review screen shows a
   "matches an existing catalog item" note as soon as both are known, so the user isn't
   surprised by matched-vs-created after saving.
3. **Match found** → attach the new observation to it. **No match** → call
   `app.create_provisional_retailer_product` (existing security-definer RPC; shared-tier tables
   are writable only through these — see `03-data-model.md`) with `product_id = null` (identity
   resolution — brand, product class, canonical size — is unbuilt for shelf tags just as it is
   for receipts; this file does not change that). On the create path only, also call
   `app.create_provisional_product_alias` with the printed description text, `confidence = null`
   (the stub `ConfidenceProvider` returns unknown for everything — see `04-review-queue.md`).
   Skipped on the match path: matching on `store_item_code` already means this isn't new
   phrasing worth recording as an alias.
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

`price_kind` (`regular` / `sale` / `clearance`) is a manual toggle on the review screen,
defaulting to `regular` — shelf tag color/format usually signals this but isn't something OCR
text alone reliably captures, so it's asked rather than guessed.

## Known gaps

See the "Shelf tag capture" entry in `docs/decisions/deferred.md`.
