# ADR 0018 — Shelf tag extraction is scoped by template, not applied retailer-flat

- **Date:** 2026-08-23
- **Status:** Accepted

## Context

`extractShelfTagFields` (`shelfTag.ts`) is one flat function applied to every shelf tag
regardless of retailer. Evidence from twelve real tags across three retailers (Walmart and Aldi
are build targets; Dollar Tree is a generalization stress test only) shows that assumption
breaking down in three ways — full evidence in `deferred.md`'s "Shelf tag capture" entry, second
batch, 2026-08-23:

- **The same field moves position between layouts of the same retailer.** Walmart's unit price
  sits right of the price on the ESL template, below it on the paper template.
- **The same field means something different, or carries a different trust level, between
  retailers.** Aldi's trailing 6-digit footer code looks like a safe store item code (six digits
  against roughly 1,400–2,000 Aldi SKUs); Walmart's 4-digit footer fragment is a UPC remnant that
  already caused a live mis-attribution incident when an earlier version of this parser treated
  it as one (see `deferred.md`'s "live, unmitigated data-corruption bug" entry).
- **Field absence is ambiguous without knowing what a layout ever prints.** Aldi's numeric-only
  ESL prints no brand, no description, and no currency symbol *by design* — today,
  indistinguishable from catastrophic OCR failure on a normal tag.

Six distinct layouts were observed in one session. A flat parser can't safely absorb a second
retailer without either overfitting Walmart's shape onto Aldi or growing an unreviewable pile of
retailer conditionals inside `shelfTag.ts`.

## Decision

Extraction rules become **data, scoped by template, selected at runtime before extraction
runs** — not code branches inside `extractShelfTagFields`.

- **`shelf_tag_template`** — the lineage, the stable concept that survives layout revisions.
  `retailer_id` (nullable — null applies to any retailer, a fallback tier), `slug`,
  `physical_form` (`esl`/`paper`/`laminated`), `region` (nullable, null = everywhere — mint a
  regional lineage only when a divergence is actually photographed, not up front, to avoid the
  `product_class`-style proliferation trap). Shared tier, reference data — same treatment as
  `unit_of_measure`/`brand`/`category`.
- **`shelf_tag_template_version`** — immutable revisions. `shelf_tag_template_id`, `version`
  (int, scoped per lineage), `match_rules` (jsonb — cheap runtime-selection signals),
  `field_manifest` (jsonb — which fields this template ever prints; the piece that makes "field
  missing" mean something), `extraction_rules` (jsonb), `price_kind` (ADR 0003's existing enum —
  a version may only assert the shelf-observable subset, `regular`/`sale`/`clearance`; `loyalty`
  and `coupon_applied` aren't things a shelf tag can show), `superseded_at` (nullable, null =
  current — same closure-by-timestamp pattern as `review_task`, ADR 0010/0011, not a boolean
  flag).
- **`price_observation.shelf_tag_template_version_id`** — new nullable FK, populated only for
  `observation_source = 'shelf_tag'`. Records the version, never the lineage: the version gives
  exact replay, and grouping by lineage ("every observation ever parsed as Walmart ESL") is one
  join away.
- **The fork rule**, so it isn't decided ad hoc later: layout reflow (fields move, appear,
  disappear) → new lineage, which declares its own `price_kind`. Same layout, badge/colour
  added → same lineage, new version; the badge becomes a manifest field, not a fork.
- **Runtime selection is scored on cheap signals, never geometric** — no tag-boundary detection,
  no rectification. Literal token signatures, machine-readable shape (QR/barcode presence and
  structure), token-shape fingerprints, coarse chroma. **Never gates**: below-threshold falls
  through to today's flat extraction unchanged, so this can ship without regressing any tag it
  doesn't confidently recognize.
- **Templates are seeded in-repo via migration**, not authored remotely. The interpreter for
  `match_rules`/`extraction_rules` stays deliberately simple at MVP — interpreter versioning for
  exact replay is an accepted, named gap (`deferred.md`), not solved here.
- **Aldi's footer code gets the same treatment already established for Walmart's footer
  fragment: `retailer_product.tag_identifier` jsonb, never `store_item_code`, never a lookup
  key.** No new schema — `tag_identifier` and its write path (`create_provisional_retailer_product`'s
  `p_tag_identifier` param, migration `add_retailer_product_tag_identifier`) already exist, seeded
  from Walmart's `{"tag_format": "eink", "upc_fragment": "0212"}`. Each template's
  `extraction_rules` declares which `tag_identifier` key (if any) its footer/identity token maps
  to. Walmart's version keeps asserting `upc_fragment` — confirmed, on three tag/package pairs, to
  be the UPC-A tail. **Aldi's version asserts `unknown`** (`{"tag_format": "eink", "unknown":
  "201552"}`) rather than inventing a confident-sounding key: unlike Walmart's fragment, nothing
  has confirmed what Aldi's 6-digit code actually is (a real store SKU is the working guess, not
  a verified fact), and non-negotiable #2 rules out asserting a semantic the evidence hasn't
  earned. Rename the key once a captured Aldi receipt or catalog cross-reference confirms it —
  match-verification/candidate-narrowing signal only, exactly like Walmart's fragment, never
  sufficient for a match on its own.

**Out of scope for this ADR**, already tracked in `deferred.md`: region proliferation beyond the
nullable column, template inheritance, a zone sub-table, geometric matching, remote/authoring
UI, automated template induction, drift-monitoring dashboards, retailer inference from the QR
domain. Also out of scope: `price_kind`'s default-value gap (a version can *assert* a price
kind; whether that write is auto-fill or a user-confirmed prefill is a separate, still-open
decision) and the cents-denominated price extraction bug. Neither is resolved by adopting this
schema.

## Consequences

- `extractShelfTagFields` needs restructuring into select-then-apply (score candidate template
  versions, run the winner's `extraction_rules`, fall through to today's flat function below
  threshold) before Aldi support can be added safely. This ADR authorizes that restructuring; it
  doesn't perform it.
- Every shelf-tag `price_observation` going forward carries its own match confidence and its
  runner-up's, once this ships — drift (a retailer's layout changing) shows up as scores sagging
  across many captures rather than as a silent cliff.
- A field a template's manifest says is never printed is a non-event; a field it says should
  print but didn't is a `needs_review` input. This is what makes "brand missing" mean two
  different things at Walmart vs. Aldi instead of one ambiguous null.
- Aldi's 6-digit footer code is **not** routed into `store_item_code` just because it looks safer
  than Walmart's — it goes into `retailer_product.tag_identifier.unknown` on the create path,
  same mechanism and same never-a-lookup-key posture as Walmart's `upc_fragment`, until its
  semantics are confirmed and it earns a real key name.
