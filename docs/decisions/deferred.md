# Deferred register

Decisions deliberately **not** made yet, with the path left open. This file is living — items
move out of it when they become ADRs.

An item being here means: *we considered it, we chose not to build it, and we know what it
would cost to add later.* It does not mean "we forgot."

---

## Corrections

**A general polymorphic `correction` table** covering trip-level fields — wrong store, wrong
date. This is the **higher-damage** case: a mis-attributed trip poisons every observation it
produced. Rejected for MVP specifically to avoid polymorphic FK costs in Postgres.
`line_item_correction` stays narrow. See ADR 0009.

**Correction reconciliation upgrade** — from "human always wins" to "human wins unless the
parser is now confident and disagrees," surfacing conflicts back into the review queue.
Note the consequence: **a re-parse can grow the queue.** Conflict detection is already built
and inert, so the data to evaluate this will exist.

## Review queue

**Dismissal reopen-on-new-information** — triggers: a new alias is learned, a re-parse
differs, a matching product enters the catalog. This would collapse dismiss and snooze into
one concept with different triggers.

**Context-based snooze** — hide until next in this store, rather than time-based. This is the
one that actually fits the in-store review queue and is the most likely first upgrade.

**Per-user vs household dismissal scope.** Currently household.

**Cascading dismissal** via `parent_review_task_id`. Column exists, unused. See ADR 0010.

**Threshold ownership** moving from a computed data column to configuration. See ADR 0008.

## Retail locations

**No write path for `retailer` / `store` yet.** Both are shared-tier and, like the rest of the
shared catalog, writable only through security-definer functions per `03-data-model.md` — but
unlike `product` / `retailer_product` / `product_alias`, no `create_provisional_*` function
exists for them, and RLS grants `SELECT` only. The receipt-capture screen (first pass,
2026-08-23) needs a real `store_id` — it's `NOT NULL` on `shopping_trip` — so one Walmart
retailer/store was seeded directly via migration (`seed_test_store_and_receipt_bucket`) purely
to unblock manual device testing. There is still no way for a user to add a store from the app.
Picking this up means deciding whether store creation gets the same provisional-flag treatment
as products (ADR 0013) or something else — ADR 0014 only settled that store selection must be
manual, not who can create one.

## Capture and ingestion

From the receipt-capture screen's first pass (2026-08-23, `src/lib/receipts.ts`):

- **Processing is synchronous and foreground**, not the "snap-and-forget" async pipeline
  `01-capture-pipeline.md` describes — OCR, parse, upload, and every insert happen while the
  screen waits, in one request/response cycle. The durability guarantee still holds (the
  `capture_artifact` row is written before `shopping_trip`/line items are attempted), but there's
  no background queue or retry UI yet if the trip-creation half fails after the artifact half
  succeeds.
- **Coupon/discount adjustments are netted into `extended_price_cent`**, not stored as their own
  rows — there's no adjustments table on `shopping_trip_line_item`. The individual adjustment
  amounts aren't lost (they're still in `capture_artifact.raw_output` forever), just not
  queryable as separate rows.
- **`tax_cent`, `total_cent`, and `receipt_number`** are not extracted by the parser and are
  always left `null` on `shopping_trip`.
- **`purchased_at` uses the device's local clock to interpret the printed date/time**, not
  `store.timezone` — a real conversion was skipped rather than risk a wrong one. In practice the
  scanning device and the store are almost always in the same timezone, but this is a known gap,
  not a verified equivalence.
- **`store_item_code`**, when the parser extracts one, currently goes nowhere — there's no
  `retailer_product` row to attach it to yet (product/retailer_product resolution is unbuilt).
  It's preserved in the raw OCR JSON, not in any queryable column.

## Shelf tag capture

From the shelf-tag-capture screen's first pass (2026-08-23, `src/parse/shelfTag.ts`,
`src/lib/shelfTags.ts`) — see `docs/specs/06-shelf-tag-capture.md` for the full design. First
on-device test (2026-08-23, Pixel 7, capture `01a02f72-a4e1-74c6-abca-9bb2d3850790`) surfaced two
real bugs, both fixed same-day, plus concrete (not hypothetical) evidence for gaps already listed
below.

**Correction (2026-08-23, later same day):** the fixture that test produced,
`tai-pei-shelf-tag.json`, has been removed. Its subject was an internet screenshot, not a tag
physically photographed in-store — the ML Kit geometry in the file was genuine device output
(the OCR was real), but the tag itself was not a real capture, and several bullets below and in
`docs/specs/06-shelf-tag-capture.md` previously described it as "the one real on-device fixture."
That was wrong in that specific way. With it gone, **the real-tag OCR fixture count is zero**,
not one — see the corpus bullet near the end of this entry for what replaces it.

A separate batch of five real Walmart tags (four analyzed, one a duplicate description) was
photographed in-store the same day, three with a matching product package alongside for
cross-checking. That evidence is what the rest of this entry, and the corrections below, are
based on:

| Tag | Format | Footer | Package UPC-A tail | Match |
|---|---|---|---|---|
| Ramen (`RAMEN BEEF`) | e-ink | `FAC 4 CAP 136 0212` | `0212` | ✅ |
| Celery (`CELERY HEART HM`) | e-ink | `FAC 1 CAP 12 5301` | `5301` | ✅ |
| Milk (`GAL … VITAMIN D`) | e-ink | `FAC 4 CAP 20 0010` | `0010` | ✅ |
| Corn (`CORN BULK HM`) | paper | `FAC 12 CAP 288` (no fragment) | — (loose bulk, no UPC) | n/a |

- **The four `create_provisional_*` / `record_price_observation` write RPCs were unreachable
  from any client, full stop — not merely unused.** They're defined in the `app` Postgres schema
  (`app.create_provisional_retailer_product` etc.), but this project's PostgREST only exposes
  `public` and `graphql_public` (confirmed by POSTing directly to
  `/rest/v1/rpc/create_provisional_retailer_product`, which 404s with `PGRST202`). Every shelf-tag
  save failed at the first RPC call as a result — `capture`/`capture_image`/`capture_artifact`
  landed fine (they're plain table writes under RLS), but no `retailer_product` or
  `price_observation` row was ever created; `capture.processing_status` ended up `'failed'`.
  Fixed via migration `expose_provisional_write_rpcs`: thin same-signature `public.*` wrapper
  functions that forward to the `app.*` implementations, which keep doing their own `auth.uid()`
  check and keep their own SECURITY DEFINER privileges regardless of which schema the call
  entered through. **`app.reconcile_review_task` (04-review-queue.md's reconciliation pass) has
  the identical problem and has no wrapper yet** — nothing calls it today, but whoever builds that
  pass next will hit this exact 404 unless a `public.reconcile_review_task` wrapper is added too.
- **Split dollars+cents price rendering.** The tag in the on-device test prints its price as
  `$11` and `87` in two separate OCR elements with no decimal point anywhere between them (a
  common digital/e-ink shelf tag style) — `extractPrice` originally only recognized a price
  inside a single OCR element containing a literal `.`, so it had nothing to pick and silently
  returned null despite a price clearly being the largest text on the tag. Fixed: `extractPrice`
  now also looks for a `$<digits>` element immediately followed by a bare 1–2 digit element within
  the same reconstructed row, still picking whichever candidate (single-element or split-pair) has
  the tallest glyph.
- **Unit price format was over-narrow.** `extractUnitPrice` required exactly two decimal digits
  in dollars (`\d+\.\d{2}`), so a tag printing `25.5¢ PER OZ` (one decimal digit, cents-denominated,
  no `$`) silently failed to extract even though the text was right there. Fixed: the field is now
  `displayAmount`, the verbatim matched text ("25.5", "$0.25", "25.5¢" — whatever was printed),
  shown to the user as-is rather than forced through cents-integer parsing that would either
  reject valid data or fabricate false precision.
- **On the same on-device test tag, ML Kit never recognized the "$11" text at all** — only "87"
  (the cents) and "25.5" (the unit price number) came through as text; the whole-dollar glyphs
  produced zero OCR elements. This is a genuine text-recognition-model limitation on this tag's
  font, not something a regex fix can address; `extractPrice` correctly returns null in this case
  (see the `tai-pei-shelf-tag.json` fixture and its test) and the user falls back to typing the
  price manually, exactly as designed. Real fixture corpus is still one tag — breadth remains open.
- **`store_item_code` extraction's false-positive risk was demonstrated, not hypothetical — and
  it was worse than first understood.** On the ramen tag (footer `FAC 4 CAP 136 0212`, same
  footer shape as the removed Tai Pei fixture), the old heuristic (longest standalone 4–14 digit
  OCR element) picked up `"0212"` — not a random miss. Checked against the ramen package's
  UPC-A (`041789002120`), `0212` is exactly the UPC's last four digits with the check digit
  dropped. The heuristic grabbed a real, meaningful token — by accident, via a rule (longest
  digit run) that is demonstrably ambiguous: `FAC`/`CAP` are the shelf facing and capacity, not
  part of an item code, and nothing about "longest digit run" distinguishes the UPC-fragment
  case from a tag whose capacity alone happens to print four digits (e.g. `CAP 1440` with no
  fragment at all). **Fixed** (2026-08-23): `extractStoreItemCode` is removed outright rather
  than patched. There is currently no known way to extract a real store item code from a
  Walmart shelf tag at all — see the next two bullets for what replaced it.
- **The false-positive above was a live, unmitigated data-corruption bug, not just an extraction
  quirk — highest-priority fix in this batch.** The wrong 4-digit fragment was flowing straight
  into the `storeItemCode` field the review screen prefills, which `saveShelfTagObservation`
  then uses as the exact-match key against `retailer_product.store_item_code` (ADR 0004). A
  4-digit space against a chain catalog of 100,000+ SKUs makes a collision likely, not
  hypothetical: the second tag whose fragment collides with an existing `store_item_code`
  attaches its `price_observation` to the wrong product, silently — no create, so the
  provisional-product flag (ADR 0013) never fires, and `price_observation` is append-only (ADR
  0003) so a wrong attachment can't be corrected away, only appended around. **Fixed**
  (2026-08-23): the review screen no longer prefills `storeItemCode` from extraction at all
  (`shelf-tag-capture-screen.tsx`) — the field is manual-entry only now. An empty field the user
  fills in is correct under non-negotiable #2; a prefilled field holding a value that means
  something else (a UPC fragment, not a SKU) is a fabrication.
- **The footer fragment itself is real, useful signal — just not identity.** Replaced the
  longest-digit-run heuristic with a format-scoped grammar (`extractTagFooter` in
  `shelfTag.ts`) anchored on the literal `FAC`/`CAP` tokens: the fragment is whatever 4-digit
  token immediately *follows* `CAP <n>`, by position, not by being the longest digit run on the
  tag — which is what let a multi-digit capacity get confused with the fragment before. Emits
  `format: 'eink' | 'paper'` alongside it (paper tags print no fragment at all — loose bulk
  produce has no UPC to fragment; see the corn tag above). Returns `null` when the tag has no
  such footer, never a guess. The extraction is kept (on `ShelfTagExtraction.tagFooter`) but not
  wired to any database field yet — see the "tag identifier storage" item below, which needs a
  decision before it's persisted anywhere beyond `capture_artifact.raw_output` (which already
  retains it permanently under ADR 0002, since it's derived from the stored OCR text).
- **Correction (second evidence batch, 2026-08-23) — `format` is derived unsoundly, and the
  paper tag's own identity code is dropped.** `extractTagFooter` infers `format: 'paper'` from
  the *absence* of the trailing fragment. That's classification from missing data — an e-ink tag
  whose fragment fails OCR would be misclassified `paper` — the shape non-negotiable #2 exists to
  prevent, even though no user-facing field is filled by it. Separately, the corn paper tag does
  print an identity code, `4100-0001`, eight digits with a hyphen, in a different position (right
  of the price, not appended to the `FAC`/`CAP` line) alongside an explicit date (`08/04/26`).
  Neither is extracted; `isNoiseRow` has no path for a hyphenated code outside the footer line,
  and `format` is being asked to do template-matching work in the wrong place. A decoded-QR check
  corroborates independently, without inferring from absence: the paper tag's QR opens `20`, all
  four e-ink samples open `30` (see the QR-structure finding below) — a positive signal available
  before any glyph is read. Not fixed. Whether `4100-0001` is the same field as the e-ink
  fragment (paper printing strictly more) is open — one photo of a Walmart paper tag on a UPC
  item would settle it.
- **Split unit-price rendering had the same bug `extractPrice` was already fixed for, on the
  same real tag.** The celery tag renders both its total price *and* its per-unit price as a
  split dollars+cents pair with no decimal point (`$3` `67`, twice) — `extractUnitPrice`
  previously only ran a flattened-text regex, which matched the cents element ("67") as if it
  were the whole amount and returned `displayAmount: "67"` for a $3.67 item. **Fixed**: geometry
  (row-adjacency) is now checked first, same technique as `extractPrice`'s split-pair
  detection, before falling back to the flattened-text pattern.
- **Multi-word unit tokens ("PER FL OZ") were silently truncated to the first word.** Confirmed
  while writing the regression test for the fix above, against the milk tag's ground truth
  (`4.5¢ PER FL OZ`) — not a hypothetical, the test failed on the first attempt. The unit-price
  regex's capture group was a generic lazy character class that stops at the first space
  ("FL OZ" → "FL", `unitCode: null`). **Fixed**: the capture now tries each known 1- or 2-word
  unit from the `UNIT_ALIASES` table (longest first) before falling back to a single bare word,
  so a recognized two-word unit is captured whole and an unrecognized unit still surfaces
  verbatim rather than being silently dropped or truncated.
- **The "each"/"count" unit price is a degenerate case, now recognized as one.** Two of the four
  real tags (celery, corn) print their total price a second time as a "$X.XX PER EA" annotation
  — nothing new, the unit is "each". `ShelfTagUnitPriceGuess` now carries `isDegenerate: boolean`
  (true when `unitCode === 'each'`), and the review screen skips the "tag also shows X/UNIT"
  hint in that case rather than showing a redundant echo of the price the user already sees.
- **No real shelf-tag OCR corpus.** The one real fixture that existed (`tai-pei-shelf-tag.json`)
  has been removed (see the correction near the top of this entry) — its subject was not an
  actual in-store capture. Ground truth for four real tags (ramen, celery, milk, corn — table
  above) is recorded here and in `docs/specs/06-shelf-tag-capture.md`, covering meaningfully
  different ground (split vs. non-split price, `PER EA` degenerate case, two-token unit, paper
  vs. e-ink format, an effective date, a non-UPC hyphenated code), but **Claude Code cannot
  generate these fixtures** — `OcrResult` JSON carries real ML Kit geometry, and synthesizing it
  from a photograph would mean fabricating box coordinates, defeating the point of `CLAUDE.md`'s
  "test against real device output" rule. Awaiting device re-capture — the second evidence batch
  below extends the ground-truth set from four Walmart tags to twelve tags across three
  retailers; suggested capture priority (one per distinct failure mode, not one per retailer) is
  Walmart ramen (cents-denominated price), Aldi milk (no currency symbol/brand/description —
  the manifest case), Aldi syrup (brand/name split, normalized size, ceiling rounding), Walmart
  corn (paper template, `4100-0001`, bleed-through), Aldi strawberries (inverted colour,
  `PRICE DROPS`).
- **Processing is synchronous and foreground**, same tradeoff as the receipt-capture screen's
  first pass, not the async "snap-and-forget" pipeline `01-capture-pipeline.md` describes.
  Durability still holds — `capture_artifact` lands before resolution/observation is attempted —
  but there's no background queue or retry UI if the observation half fails after the artifact
  half succeeds.
- **Alias creation only happens when a new `retailer_product` is created**, not on a matched
  existing one. If the printed text on a later scan differs from the first (e.g. an abbreviation
  changed), that phrasing is never recorded as a `product_alias`. Acceptable for a first pass;
  revisit if alias coverage turns out to matter for matching quality.
- **`price_kind` is a manual toggle**, not detected from the tag. (Rationale corrected
  2026-08-23: the original claim — "a plain OCR pass over text doesn't see color" — is true but
  incomplete. Aldi's price-drop template prints the literal string `PRICE DROPS` in the badge
  area; the signal is in the text, not only the color, and a plain OCR pass does see it.
  Detection is more tractable than this entry originally assumed. Colour inversion is still real
  and still relevant for any template that signals sale/clearance *only* by colour, if one turns
  out to exist. Still not implemented — see the `price_kind` default gap below, which is the
  higher-priority problem regardless of whether detection ever gets built.)
- **No barcode decode.** A UPC printed as a barcode graphic (not OCR'd text) isn't read — this is
  explicitly the separate "Barcode scan" capture mode's job (`00-project-overview.md`), not
  shelf tag photography's.
- **Product identity resolution (brand, product_class, canonical size) is unbuilt**, same gap as
  receipts. Every shelf-tag-created `retailer_product` has `product_id = null`.
- **Brand is confirmed absent from shelf tags — scoped to the Walmart ESL template, not a
  general claim.** (Corrected 2026-08-23, second evidence batch below.) The milk tag
  (`GAL … VITAMIN D`, no "Galliker's") is the stronger evidence than the produce case — a
  branded gallon of milk gets a generic tag description too, on Walmart. But every standard Aldi
  tag prints the brand on its own dedicated line above the product name (`NORTHERN CATCH` /
  `Chunk Tuna in Oil`, `MILLVILLE` / `Original Pancake Syrup`) — at Aldi, brand is a first-class
  extractable field. The Walmart conclusion stands (create `retailer_product` with
  `product_id = null` on Walmart shelf-tag saves), but the reasoning doesn't transfer to other
  retailers — "brand not found" means two different things at the two retailers, and only the
  template knows which. This was the strongest single argument for the per-retailer field
  manifest in ADR 0018 (accepted, built same day) — the `aldi-esl-standard` template now splits
  brand from name when exactly two non-noise rows remain and the first is all-caps
  (`ShelfTagExtraction.brand`, see `shelfTagTemplates.ts`). The review screen recombines
  `brand` + `descriptionGuess` into one editable prefill rather than dropping brand on the
  floor, since there's still no dedicated brand column or product-identity resolution to put it
  in.
- **PLU on produce packages** — the celery package prints `#4575` (IFPS produce PLU) above its
  barcode, a categorically different identifier from the UPC (class-level "celery hearts from
  any grower," not "this bag"). `product_identifier.identifier_type` already accepts `plu`
  (ADR 0004) and nothing populates it — no schema change needed. Out of scope for this file
  specifically: the PLU is on the **package**, not the tag, so this belongs to the barcode-scan
  capture path, not shelf-tag photography.
- **`HM` recurs on produce tag descriptions** (`CELERY HEART HM`, `CORN BULK HM` — two of two
  produce tags). Meaning unknown. Systematic rather than noise, so worth normalizing out during
  `product_alias.normalized_text` construction eventually (so `CELERY HEART` from a later
  capture still matches) — but that construction happens server-side (in the
  `create_provisional_product_alias` RPC path), not in this file, and "strip an unexplained
  token for matching purposes" is exactly the kind of heuristic `CLAUDE.md` says to write down
  and review before adding, not infer from two samples. Not implemented. `printed_text` keeps
  `HM` verbatim regardless (ADR 0004).
- **Hypothesis, not fact: a boxed `W` glyph near `FAC` may signal WIC eligibility.** Present on
  celery and milk (both WIC-eligible categories), absent on ramen (not WIC-eligible), plain text
  on the corn tag. Three-for-one is suggestive, not confirmed — needs a WIC-eligible item that
  isn't produce/dairy and a non-eligible item that is before it's trustworthy. Not implemented;
  do not name a `wic_eligible` field until confirmed on more tags.
- **Applied (2026-08-23) — tag identifier storage.** The footer fragment (see above) is real
  signal but not identity: it can't go in `store_item_code` (wrong meaning, guaranteed
  collisions) or `product_identifier` (unique on type+value; a 4-digit fragment isn't remotely
  unique). Migration `add_retailer_product_tag_identifier` added a nullable
  `retailer_product.tag_identifier jsonb` column, populated on the create path only with
  whichever of `tag_format`, `upc_fragment`, `qr_token` are known (see `buildTagIdentifier` in
  `shelfTags.ts`) — never sufficient for a match on its own, only for future match verification
  and candidate narrowing (nothing reads it back for that purpose yet). `printed_code` (the
  paper-tag hyphenated code) is in the proposal's key set but nothing populates it — there's no
  extractor for it (Section 2b's "do not guess at its structure" still holds). Both
  `app.create_provisional_retailer_product` and its `public.*` wrapper got the new
  `p_tag_identifier jsonb default null` param in the same migration, avoiding the "miss the
  wrapper" failure mode already hit once on this feature (see above). A same-migration follow-up
  (`drop_old_create_provisional_retailer_product_overload`) dropped the pre-existing 5-argument
  overload of both functions: `create or replace function` with an added trailing parameter
  creates a *new* overload rather than replacing the old one — confirmed against this project's
  live `pg_proc`, not assumed — which would otherwise have left an ambiguous duplicate for
  PostgREST to resolve on every call. Deliberately excludes `FAC`/`CAP`/corner-badge/paper-tag
  date, which are per-capture facts already retained permanently in `capture_artifact`, not
  chain-scoped facts that belong on `retailer_product`. An expression index
  (`retailer_product_upc_fragment_idx`, not unique) supports the future narrowing use case.
- **Applied (2026-08-23) — QR/barcode decode capability added.** All four real tags carry a
  19-character QR token (`w-mt.co/q/...`) that appears to be a stable opaque per-item identifier
  (an earlier 2-sample hypothesis that the token encoded the store was killed by the 4-sample
  set — treat the whole token as opaque). This codebase had no barcode/QR decoding capability at
  all before today — no ML Kit barcode module, no scan step in the capture pipeline. Added
  `expo-camera` (`~57.0.4`, the SDK-57-compatible version resolved by `npx expo install`, not
  guessed) purely for its static-image decoder, `scanFromURLAsync` — verified against current
  Expo docs and the installed package's own `.d.ts` files rather than assumed from training data
  (non-negotiable #7), since this project already had one API surprise from an unverified
  assumption in this same feature (the `PGRST202` schema-exposure bug above). New module:
  `src/ocr/scanBarcode.ts` (`scanBarcodes`, restricted to `['qr']` at the call site in
  `shelf-tag-capture-screen.tsx`, run in parallel with OCR via `Promise.all` since both read the
  same static image independently). A decoded barcode is written to its **own**
  `capture_artifact` row (`parser_version` = `BARCODE_SCAN_VERSION`), not merged into the OCR
  artifact's `raw_output` — same "one row per parser run" model as OCR (ADR 0002), only inserted
  when at least one barcode actually decoded. **Not yet exercised on a real device** — `expo
  prebuild` needs to run before the native module is linked into the gitignored local `android/`
  project, and per user instruction this session does not run native builds locally (they've
  frozen this machine before); the user needs to run prebuild/build themselves. Section 5d's
  caution about decode difficulty (OpenCV needed cropping/upscaling/CLAHE for the glossy,
  angled milk tag QR; ML Kit is expected to do better but is unverified) is therefore still
  fully open.
- **Built, tested, and abandoned same day (2026-08-23) — QR shortlink resolution, ADR 0016 →
  ADR 0017.** Online resolution (fetching the decoded QR shortlink to enrich the catalog with a
  better description) got its required ADR (0016), was built same-day scoped deliberately narrow
  (alias enrichment only — full identity resolution has no taxonomy to resolve against, since
  `product_class` and `brand` both have zero rows in this database), and was real-device tested
  the same day. Two independent, unfixable problems killed it: Walmart's bot detection blocked
  every automated request tried (the app's original `HEAD`, its `GET` fallback, and a manual
  fetch from an unrelated client — three for three), and even an unblocked page turned out to be
  a dynamic, JS-rendered product-family page with flavor/size as interactive chips, not something
  a static fetch could read the exact SKU off of. **ADR 0017 records the full finding and
  reverses the decision** — `src/lib/qrResolution.ts`, `src/lib/walmartUrl.ts` (+ test),
  `resolveShelfTagQr`, the QR-resolution debug card, and the `expo-network` dependency are all
  removed. Local QR **capture** (decode + permanent raw storage in its own `capture_artifact`
  row, plus `tag_identifier.qr_token`) was never part of ADR 0016 and is unaffected — see the
  entry above. Read ADR 0017 for the complete writeup rather than this summary.
- **Fixed (2026-08-23) — `scanFromURLAsync` barcode results were never recognized as QR codes,
  on-device, despite decoding correctly.** Found during real-device debugging (Pixel 7) of "no
  QR detected" on the ramen tag. Two hypotheses were pursued and both were **wrong** — worth
  recording precisely, because the debugging trail is as informative as the fix:
  1. *First hypothesis: tag-photo quality (too small in frame, glare, angle).* Killed decisively
     by pushing a clean, near-full-frame synthetic QR onto the device and running it through the
     same pipeline — it also read "no QR decoded," which a real quality problem couldn't explain.
  2. *Second hypothesis: `scanFromURLAsync` loads the bitmap via Glide
     (`expo-image-loader`'s `ImageLoaderInterface`) instead of ML Kit's own `InputImage.fromFilePath`
     (which `expo-mlkit-ocr`'s OCR path uses, confirmed by reading both native sources side by
     side) — theorized a Glide/hardware-bitmap incompatibility.* Also wrong, and disproven by
     the user's own follow-up: an earlier real capture's `capture_artifact.raw_output` had
     already recorded `{"data": "w-mt.co/q/300ctBZ0VD4J3-ZDQBP", "type": 256}` — the scan had
     been finding the QR correctly the whole time.
  3. **Actual root cause:** `type: 256` is ML Kit's raw `Barcode.FORMAT_QR_CODE` integer
     constant (`0x0100`), not the string `"qr"`. `BarCodeScannerResultSerializer.kt` (used by
     `scanFromURLAsync`) writes `putInt("type", result.type)` — the raw format — while the
     *live* `CameraView`'s `onBarcodeScanned` path (`ExpoCameraView.kt`) separately calls
     `BarcodeType.mapFormatToString(barcode.type)` before handing results to JS.
     `expo-camera`'s own `.d.ts` declares `type: string` for both, which is simply incorrect for
     `scanFromURLAsync` — a real upstream type-declaration bug, not a training-data assumption
     this project made. This project's own `qrBarcode = barcodeResults.find(b => b.type === 'qr')`
     was therefore comparing a string literal against a number and was **always** false,
     regardless of platform/device/photo — the scan step (`scanBarcodes` in `scanBarcode.ts`) was
     correct and had been working the entire time; only the JS-side type comparison built on top
     of it was broken. Fixed by normalizing at the boundary:
     `normalizeBarcodeType` (`src/ocr/barcodeType.ts`, kept import-free of `expo-*` so it's
     unit-testable — the exact table lives there, reversed from `expo-camera`'s own
     `BarcodeType.mapToBarcode()`) converts the raw ML Kit int to the documented string shape
     before it ever reaches `BarcodeScanGuess`, so every downstream comparison (`.type === 'qr'`
     in `shelf-tag-capture-screen.tsx`, the `qrToken`/`tag_identifier` wiring in `shelfTags.ts`)
     needed no changes at all. Regression-tested against the exact real value (`256 -> 'qr'`)
     pulled from that `capture_artifact` row, not a synthetic guess.
  4. **Process note:** two debug-variant functions (`resolveShelfTagQrShortlinkDebug`,
     `scanBarcodesDebug`) and a debug card on the review screen were built specifically to make
     this kind of on-device failure checkable without a native rebuild — and that's exactly what
     let the second, wrong hypothesis (a Glide/ML-Kit bitmap issue) get discarded quickly instead
     of chasing a native fix for a bug that didn't exist there. The eventual fix required no
     native changes at all, only a JS-side normalization miss. Both debug variants and the debug
     card were removed once QR resolution itself was abandoned (ADR 0017) and there was nothing
     left to debug with them — `scanBarcode.ts` now only exports the plain `scanBarcodes`, which
     still carries the `normalizeBarcodeType` fix internally. Worth remembering the pattern next
     time a "silent no-result" on a real device tempts a native-layer explanation first: a cheap,
     removable debug variant beats guessing.
- **Deferred (2026-08-23, explicit decision) — implied package size from price ÷ unit price.**
  When a tag prints both a total price and a per-unit price, package size is recoverable even
  though the tag never states it (worked twice against real packages: ramen's 46¢ ÷ 15.3¢/oz
  bands to 3.00–3.02 oz, matching the 43g×2 = 86g = 3.03oz package; milk's $5.78 ÷ 4.5¢/fl oz
  bands to 127.0–129.9 fl oz, matching the 1 gal = 128 fl oz package). Not a math problem —
  "only emit when the band contains exactly one **plausible** pack size" requires a definition
  of "plausible" that doesn't exist anywhere in this codebase or its docs. The milk band
  actually contains two integers (128 and 129), so "the only standard size in range" has to
  mean something more specific than "any whole number": almost certainly a curated list of real
  retail package sizes per unit, which is domain knowledge (US grocery packaging conventions),
  not something to invent inline — the "stop and ask before improvising a heuristic" case in
  `CLAUDE.md`'s working agreement, even though the rest of this feature batch was safe to build
  without that gate. **Explicitly deferred rather than built** pending that size-reference list
  being specified and reviewed. Would live downstream of `extractShelfTagFields`, not inside
  it, per the replay contract in ADR 0002, whenever it's picked up.
- **Second evidence batch (2026-08-23) — Aldi and Dollar Tree tags, plus two more Walmart
  tags.** Twelve tags total, three retailers, one photography session. Walmart and Aldi are
  build targets; Dollar Tree is a generalization stress test only — not a build target, but two
  of its findings falsify rules that otherwise looked safe (see `isDegenerate` below). Machine-
  readable content decoded with OpenCV/pyzbar as a stand-in for ML Kit — decode difficulty is not
  a prediction of on-device behaviour and should be re-measured per non-negotiable #7.

  | # | Retailer | Template | Description as printed | Price | Unit price | Size on tag | Code(s) | Machine-readable |
  |---|---|---|---|---|---|---|---|---|
  | 1 | Walmart | ESL | `RAMEN BEEF` | 46¢ | 15.3¢ PER OZ | — | `0212` | QR `w-mt.co/q/300ctBZ0VD4J3-ZDQBP` |
  | 2 | Walmart | ESL | `CELERY HEART HM` | $3.67 | $3.67 PER EA | — | `5301` | QR `w-mt.co/q/30bP5WB0VD4R0-9RXN3` |
  | 3 | Walmart | ESL | `GA… VITAMIN D` | $5.78 | 4.5¢ PER FL OZ | — | `0010` | QR decode failed |
  | 4 | Walmart | ESL | `DT COKE 2OFO` | $2.48 | 12.4¢ PER FL OZ | — | `0045` | QR `w-mt.co/q/300eFYF0VD4R0-9RGGA` |
  | 5 | Walmart | paper produce | `CORN BULK HM` | 33¢ | 33.0¢ PER EA | — | `4100-0001` | QR `w-mt.co/q/20bOFDr0VDSF.AP.9.3` |
  | 6 | Aldi | ESL standard | `NORTHERN CATCH` / `Chunk Tuna in Oil` | $0.99 | $3.20 per lb | 0.31 lb | `201552` | none |
  | 7 | Aldi | ESL standard | `MILLVILLE` / `Original Pancake Syrup` | $2.35 | $3.14 per qt | 0.75 qt | `365419` | none |
  | 8 | Aldi | ESL standard | `L'OVEN FRESH` / `White Bread` | $1.45 | $1.16 per lb | 1.25 lb | `500641` | none |
  | 9 | Aldi | ESL price-drop | `Strawberries` | $1.89 | $1.89 per lb | 1.00 lb | `356646` | none |
  | 10 | Aldi | ESL numeric-only | *(none on tag)* | 5.25 | $5.25 per gal | 1.00 gal | `416943` | none |
  | 11 | Dollar Tree | laminated two-zone | `LMC-STEERING WHEEL TRAY FR CAR` | $5 | $5.00 PER EA | — | `03-81283`, `02786` | Code 39 → `0381283` |
  | 12 | Dollar Tree | laminated two-zone | `FBREZE AUTO GAIN FRESH 4ML 2PK` | $6 | $3.00 PER EA | — | `04-17392`, `01077` | Code 39 → `0417392` |

  Tags 1–5 overlap the first batch above; tags 3 and 4 are additions to it. Source photos are
  with the project owner, not in the repo — see the fixture-corpus bullet above for why they
  can't yet become `__fixtures__` entries.
- **Live bug, not yet fixed (found 2026-08-23) — cents-denominated prices extract as null, and
  worse, sometimes extract as the wrong field's value.** `CURRENCY_PATTERN` and `PRICE_PATTERN`
  in `rows.ts` both require a literal `.` and exactly two fractional digits; `DOLLARS_ONLY_PATTERN`
  requires a literal `$`. A price printed as `46¢` or `33¢` (no dollar sign, no decimal point)
  satisfies none of them, so it never becomes a `PriceCandidate`, and the split-pair scan doesn't
  fire either since it requires a leading `$`. Two of five real Walmart tags (ramen `46¢`, corn
  `33¢`) extract no price at all — both low-priced items, exactly the population where
  cents-only rendering is used, so this isn't a rare edge. It gets worse where a unit price is
  well-formed: Dollar Tree tag #12 prints retail `$6` (fails every pattern) and unit price `$3.00`
  (a valid currency element); `extractPrice` finds exactly one candidate, and "largest glyph wins"
  sets `priceCent` to the **unit price** — half the actual price, with nothing marking it
  suspect. The null cases are correct behaviour under non-negotiable #2 (missing recorded as
  missing); the Dollar Tree case is a non-negotiable #2 violation — a value from a different
  field gets written into `priceCent`. The same shape would occur at Walmart on any tag pairing a
  cents-denominated retail price with a dollar-denominated unit price. **Not fixed.** Fix shape
  under consideration: recognize a cents amount (a trailing `¢`, merged or split across adjacent
  elements) as a price form in its own right, converting directly to `price_cent` with no float
  intermediate — but how ML Kit segments `46` and `¢` on a real capture is unknown to this
  analysis and must be confirmed on device before implementing, per non-negotiable #7's spirit.
  **Highest-priority open item from this batch.**
- **Walmart QR structure — a refinement, not a reversal, of the killed store hypothesis.** The
  "token encodes store" hypothesis above stays killed (opaque token). New finding: the QR's
  leading two characters are `30` on every e-ink sample and `20` on the one paper sample, which
  also switches its internal separator from `-` to `.`. That's a template discriminator readable
  from the decoded QR before any glyph is OCR'd — feeds the template proposal below, not online
  resolution (ADR 0017 still stands; this is inspection of the already-persisted token, no
  network call). Separately confirmed: Walmart's ESL layout is department-invariant across
  grocery, dairy, produce, and beverage in this sample — the only observed Walmart split is by
  physical medium (ESL vs. paper), not department. And the coke tag's description
  (`DT COKE 2OFO`, an OCR'd `0` read as `O`) is disambiguated by the derived-size cross-check:
  $2.48 ÷ 12.4¢/fl oz = 20.0 fl oz snaps cleanly, confirming "20 FO" meant 20 fl oz — the
  deferred size-derivation item above has a second use as an OCR cross-check on the description,
  not just size recovery.
- **Aldi has three distinct ESL templates in one store, not one.** Standard (brand line +
  product name line + footer row of size/unit-price/code); price-drop (inverted red field, white
  text, `PRICE DROPS` badge, no brand line — same footer structure); numeric-only (shows only the
  price and footer row — brand, description, size, and unit are printed on the physical display
  card the ESL is taped to, not on the ESL itself, and the price has no currency symbol at all, a
  second and independent reason it fails `CURRENCY_PATTERN` beyond the live bug above). The
  numeric-only case is the clearest argument for a field manifest: without one, a parser sees no
  brand, no description, and no currency symbol, and can't distinguish catastrophic OCR failure
  from correct extraction of a template that prints none of those things by design.
- **Resolved (ADR 0018, 2026-08-23) — Aldi's trailing 6-digit code (`201552`, `365419`, etc.)
  looks like a real, safe store item code — unlike Walmart's 4-digit UPC fragment — but its
  exact meaning is unconfirmed, so it does not go into `store_item_code`.** Six digits against
  an assortment of roughly 1,400–2,000 Aldi SKUs makes collision negligible; four digits against
  a 100,000+ item Walmart catalog makes collision certain, which is exactly why the Walmart
  fragment was kept out of `store_item_code` too. The decision (user-directed, correcting an
  earlier draft of ADR 0018 that left this as an open question): treat it exactly like Walmart's
  fragment always has been — `retailer_product.tag_identifier` jsonb, never a lookup key, never
  `store_item_code`. Unlike Walmart's fragment (confirmed, on three tag/package pairs, to be the
  UPC-A tail), nothing has confirmed what Aldi's code actually is, so it's keyed `unknown`
  (`{"tag_format": "eink", "unknown": "201552"}`) rather than a confident-sounding name — rename
  the key once a receipt or catalog cross-reference confirms it. Implemented in
  `src/parse/shelfTagTemplates.ts` (`applyShelfTagTemplate`) and wired through the generalized
  `identifierCandidate` field in `shelfTag.ts` / `buildTagIdentifier` in `shelfTags.ts`.
- **Aldi's unit price is ceilinged to the cent, not rounded.** Confirmed twice: tuna
  ($0.99 ÷ 0.31 lb = $3.19354, printed $3.20; round-half-up would give $3.19) and syrup
  ($2.35 ÷ 0.75 qt = $3.13333, printed $3.14; round-half-up would give $3.13). A reconciliation
  validator built against standard rounding would flag both correct tags as inconsistent. Nothing
  consumes this today so nothing is broken by it yet, but it's a known gap for whoever builds
  reconciliation — see "Reconciliation rounding is unspecified" below; Walmart appears to round
  to a tenth of a cent, so one shared rounding assumption would misfire at whichever retailer it
  wasn't tuned against.
- **Aldi's printed size is normalized into Aldi's chosen unit, not the package's declared
  unit** — a 5 oz tuna can shows `0.31 lb`, a 24 fl oz syrup shows `0.75 qt`. Free extraction (no
  derivation needed, unlike Walmart), but "size present on tag" doesn't mean "size in the unit
  the user expects to see"; comparing an Aldi size against a Walmart size requires unit
  normalization regardless. Validates existing canonical-unit handling rather than adding new
  work.
- **`isDegenerate` (`unitCode === 'each'`) is Walmart-scoped, not universal, and is currently
  documented in the code as if it were general.** True at Walmart (celery, corn: price and unit
  price are identical when priced by the each). Confirmed false at Dollar Tree: tag #12 prints
  retail `$6`, unit price `$3.00 PER EA`, description ending `2PK` — "each" means per unit
  *inside* the multipack there, and `retail ÷ unit price = 2`, confirmed by the `2PK` in the
  description. Dollar Tree is not a build target and no code change follows from this alone, but
  the general lesson holds: UOM semantics are per-retailer, and any `if unitCode === 'each'` rule
  is a template-scoped rule currently wearing a global disguise in the
  `ShelfTagUnitPriceGuess.isDegenerate` comment.
- **No notion of a tag boundary anywhere in the pipeline — OCR picks up text that isn't on the
  tag.** Confirmed on both build-target retailers: the Aldi milk tag's surrounding display card
  supplies the product identity, and Walmart product packages behind the tag are legible in
  frame. On the Aldi milk tag this happens to produce the right answer by accident via
  `extractDescriptionGuess`, which is worse than failing, because there's no way to tell it apart
  from a correct extraction. Not proposing tag-boundary detection here — real work, probably
  wants perspective rectification too — recording as a known gap.
- **Moved to ADR 0018 (2026-08-23, Accepted) — the shelf-tag template schema.**
  Was a STOP-AND-ASK item here; the proposal (retailer × physical-form lineage table, versioned
  rules/field-manifest, `price_kind` asserted per version, plus the negative-space list of what's
  deliberately excluded — region proliferation, template inheritance, a zone table, geometric
  matching, remote authoring, automated induction, interpreter versioning, drift monitoring,
  retailer inference from the QR domain) now lives in full in
  `docs/decisions/0018-shelf-tag-templates-are-versioned-lineages.md`. **Accepted and built
  same day** — see the "Applied" entry directly below for what shipped. The underlying findings
  that motivated it (six templates, three retailers, the Aldi/Walmart footer-code trust
  asymmetry, the manifest-ambiguity case) stay recorded above as evidence regardless.
- **Applied (2026-08-23) — ADR 0018 built: shelf-tag template matching.** Migrations
  `create_shelf_tag_template_tables`, `add_price_observation_shelf_tag_template_version`,
  `seed_shelf_tag_templates` — two new shared-tier reference tables (`shelf_tag_template`,
  `shelf_tag_template_version`), a nullable `price_observation.shelf_tag_template_version_id`
  FK, `record_price_observation` gained a trailing `p_shelf_tag_template_version_id` param (old
  10-arg overload dropped, same pattern as the earlier `create_provisional_retailer_product`
  overload fix), and five template versions seeded at version 1: `walmart-esl`, `walmart-paper`,
  `aldi-esl-standard`, `aldi-esl-price-drop`, `aldi-esl-numeric-only`. An `aldi` retailer row was
  also seeded (name/slug only, no store — same low-stakes reference-data treatment as the
  existing Walmart retailer row from `seed_test_store_and_receipt_bucket`), since it didn't
  exist yet and `shelf_tag_template.retailer_id` needed something real to point at.
  `src/parse/shelfTagTemplates.ts` is new: hand-written (not generic-jsonb-driven) scoring and
  per-template field overrides for all five templates, scored on content signals only —
  retailer-agnostic, because the capture flow doesn't know the user's chosen store/retailer
  until after extraction already ran (`shelf-tag-capture-screen.tsx`). `shelfTag.ts` gained
  `brand`, `identifierCandidate`, and `templateMatch` on `ShelfTagExtraction`, plus a
  `BARE_SIZE_ROW_PATTERN` fix to `isNoiseRow` (a standalone size row like Aldi's `"0.31 lb"`
  wasn't previously excluded from description candidates, which would have broken the Aldi
  brand/name split before it could work). `shelfTags.ts` generalized `buildTagIdentifier` to
  take the new `identifierCandidate` instead of a hardcoded Walmart-only fragment check, and
  added `resolveShelfTagTemplateVersionId` (two plain lookups, not an embedded-resource filter
  query, to avoid relying on unverified PostgREST join-filter syntax) to turn a `{slug, version}`
  match into the real FK value. **Not yet exercised on a real device** — synthetic fixtures only
  (`shelfTag.test.ts`), same caveat as the rest of this feature. `price_kind` on each template
  version is stored but deliberately not wired into any write path — see the STOP-AND-ASK entry
  below, unchanged by this work per explicit instruction. The cents-denominated price bug (live
  bug entry above) is also unchanged — explicitly deferred, not touched.
- **STOP AND ASK — `price_kind`'s default is the actual gap, not the column.** `price_kind`
  currently defaults to `regular` on the review screen (`06-shelf-tag-capture.md`). Under
  snap-and-forget, an unreviewed clearance or sale tag writes `regular`, which is precisely the
  promotional-baseline damage ADR 0003 introduced the column to prevent — and because
  `price_observation` is append-only, correcting a wrong `price_kind` costs a full
  `superseded_by_id` chain rather than an edit. The column can't currently distinguish "user
  confirmed regular" from "nobody looked," which is non-negotiable #6's null-vs-zero distinction
  one layer up, except here the wrong value is worse than an absent one. Whether the fix is a
  nullable column, an `unknown` enum member, or leaning on `field_confidence` is a real decision,
  not an implementation detail. Separately: nothing in the codebase's analytics or comparison
  specs currently consumes `price_kind` at all, so recording the distinction is only half the
  value — excluding sale/clearance from baseline price figures is the half that pays for it, and
  it's unclear whether that's deliberate sequencing or simply hasn't come up yet. Not implemented.
- **Open questions, each settled by one more photograph:** is the Aldi price-drop brand-line
  absence a template property or a commodity-produce property (Walmart's celery has the same
  absence for the second reason — capture an Aldi price-drop tag on a branded packaged good); is
  the corn tag's `4100-0001` the same field as the e-ink fragment (capture a Walmart paper tag on
  a UPC item); does the QR's constant `0VD4` segment encode store, region, or encoding version
  (capture any ESL at a different Walmart); what does a Walmart promotional/rollback tag look
  like — none in the corpus yet, and it determines whether the template fork rule above actually
  fires (capture a rollback tag). Uninterpreted and not worth naming yet, capture verbatim if
  recaptured: the Walmart corner badge digits (`19`, `11`, `17`, `-5`, `1`), the small boxed glyph
  left of `FAC` on three of four Walmart e-ink tags (correlates with fresh/perishable across five
  samples — not enough to name), `HM` in the two Walmart produce descriptions, and Dollar Tree's
  `P6/F1`/`P8/F1`, `02/26`, and secondary 5-digit codes.

## Catalog

**Provisional state as a merge-candidate queue** for duplicate products. Natural extension of
ADR 0013, since duplicates are the actual failure mode.

**Promoting jsonb attributes to typed columns** once usage reveals which ones matter.

**Trust scoring** on contributors, feeding observation confidence.

**Substitution preferences** — whether a user accepts store brand for name brand is a per-user
judgment. Do not bake "same class means interchangeable" into anything irreversible.

## Identity and tenancy

**Invite-gated household joining.** ADR 0015 resolved the bootstrap question with the loosest
possible version: any authenticated user can browse every household and self-join, no
approval or invite required. That was a deliberate choice for round 1 ("no privacy or
permissions yet"), not a final one. Picking this up means narrowing
`household_select_authenticated` and `household_member_insert_self` (see the ADR) — likely to
an invite code or an owner-approval step — and deciding what happens to a user who already
self-joined a household under the open rule when that household later turns invites on.

**Multiple households per user.** Nothing in the schema prevents a `household_member` row per
household a user joins, but the client currently assumes one and silently takes the
earliest-joined row (`use-household.tsx`). A real multi-household UX — switching, or scoping
capture to "which household is this receipt for" — is unbuilt.

## Sync

**Offline sync — revisit before implementation.** MVP targets one household, where a full
mirror is fine. Corner-avoidance constraints are already reflected in the schema: filterable
read path (full mirror and working set differ by a parameter, not a code path), a shared
`revision` sequence, soft delete everywhere, clean tier separation.

Direction when picked up: **offline-first on the write path, cached working set on the read
path.** The write path is easy because the model is append-only — client-generated UUIDs,
local outbox, no merge conflicts because two devices never write the same row. The read path
is where a full mirror gets expensive on low-end phones: mirror household data in full,
per-store catalog snapshots on visit, global reference data in full.

**ElectricSQL is the leading candidate.** It syncs read-path *shapes* (per-table queries with
a where clause), which maps almost directly onto the shared/private split. Writes go through
our own API rather than Electric — exactly the outbox pattern.

## Privacy

**De-anonymization at low density.** In a store where one person contributes most of the data,
forty observations sharing a timestamp cluster obviously, and "anonymous" gets thin.
Mitigations: coarsen `observed_at` on the public read path; suppress observations below a
corroboration threshold. Not an MVP problem, but "anonymous" is a promise worth not designing
against.

---

## Carried over from the parser POC

The parser (`src/parse/*`) has been ported into this repo from `forage-poc`, with two changes
made on the way in: line item and reconciliation amounts are now integer cents (were float
dollars), and `store_item_code` is extracted from the description per ADR 0004 (previously left
embedded in it). Accepted as ongoing tuning work, not blockers:

- Fixture corpus breadth — one Walmart receipt is not a corpus.
- Reconciliation false-negative coverage.
- Replay path validation (addressed, needs continued exercise).
- iOS / Android ML Kit geometry parity.
- **`store_item_code` extraction is a single-fixture heuristic** — any run of 10–14 digits
  sitting in its own OCR element within the body zone. Untested against a receipt where some
  other multi-digit number (not a UPC) lands in that zone; needs a fixture with a false positive
  before the pattern can be trusted.

**Correction (2026-08-22):** this section previously said per-field confidence emission had "an
interface [that] exists, provider is a stub." That was not accurate against the actual parser
code, ported or otherwise — no `ConfidenceProvider` interface exists anywhere yet, and the
parser emits no confidence signal, per-field or otherwise. `LineItem` has no `field_confidence`
shape. The stub described in `docs/specs/04-review-queue.md` (returns "unknown" for every field)
remains open work, not a wire-up — flagging here rather than leaving the drift in place.
