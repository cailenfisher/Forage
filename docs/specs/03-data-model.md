# Data model

> **Living document.** The *why* behind these structures lives in `docs/decisions/`.
> This file describes the current shape. Update it in the same commit as the migration.

## Naming conventions

Follows the [SvelteBuilder naming conventions](https://github.com/cailenfisher/SvelteBuilder/wiki/Naming-Conventions).

| Layer | Convention | Example |
|---|---|---|
| Table | singular `snake_case` | `price_observation` |
| Primary key | `id` | `id` |
| Foreign key | `<singular_table>_id` | `retailer_product_id` |
| Timestamp | `_at` suffix | `observed_at` |
| Boolean | no `is_` / `has_` prefix | `private_label` |
| Index / constraint | prefixed, descriptive | `idx_price_observation_store_id` |

### Two exceptions established for this project

**Attributed junctions become named entities.** Strictly, linking `household` and
`user_account` yields `household_user_account`. Because the junction carries attributes, it
becomes `household_member`.

**`retailer`, not `store_chain`.** With `store` as the individual location, `store_chain_id`
and `store_id` are a near-collision that produces silent bugs. `retailer` / `store` is
unambiguous at every layer including UI labels.

## Cross-cutting columns

Applied to every table unless noted.

| Column | Purpose |
|---|---|
| `id uuid` | PK. **UUIDv7, client-generated.** Time-sortable, and doubles as the idempotency key for offline retries. |
| `created_at timestamptz` | Always. |
| `updated_at timestamptz` | On mutable tables. |
| `deleted_at timestamptz` | Soft delete. **Mandatory on anything that syncs** — a hard-deleted row can't appear in a delta, so the client keeps it forever. |
| `revision bigint` | On syncable tables, from **one shared sequence**, not per-table. Clients pull "everything above revision N." Timestamps are the tempting alternative and are wrong: clock skew and ties silently drop rows. |
| `household_id uuid` | Denormalized onto **every** private-tier table even where derivable. The one place to deliberately break normalization. |

**Idempotency on receipt ingest:** a unique constraint on `(store_id, receipt_number, purchased_at)`
prevents double-scanning. Receipt numbers are unreliable enough that a soft duplicate warning
may be preferable to a hard constraint.

---

## Tier assignment

Assign the tier **before** writing the migration. A table ambiguous about its tier is a table
you cannot write a coherent policy for.

- **Shared** — `product_class`, `product`, `product_identifier`, `retailer_product`,
  `product_alias`, `retailer`, `store`, `price_observation`, plus reference data.
- **Private** — `capture`, `capture_image`, `capture_artifact`, `shopping_trip`,
  `shopping_trip_line_item`, `line_item_correction`, `review_task`, `cart`, `cart_item`,
  `shopping_list`.

See ADR 0006. **The FK points private → shared, never the reverse.**

---

## Entity reference

### Identity and tenancy

- **`user_account`** — mirrors Supabase `auth.users`; `id` references `auth.users(id)`.
  `display_name`, `created_at`.
- **`household`** — the ownership boundary for all private data.
- **`household_member`** — `household_id`, `user_account_id`, `role`, `joined_at`,
  `invitation_state`.

### Retail (shared)

- **`retailer`** — the chain. `name`, `slug`.
- **`store`** — the location. `retailer_id`, `name`, address fields, `latitude`, `longitude`,
  `timezone`.
  - *`timezone` matters because receipts print local wall time and `purchased_at` is `timestamptz`.*

### Reference data (shared)

- **`unit_of_measure`** — `code`, `label`, `dimension` (`mass`/`volume`/`count`/`length`/`area`),
  `base_factor`.
  - *Load-bearing. Without conversion to a canonical base, `$/oz`, `$/lb`, and `$/g` are three
    incomparable numbers and price intelligence does not work.*
- **`brand`** — `name`, `retailer_id` (nullable, private labels), `private_label` boolean.
  Descriptive only; never affects comparison.
- **`category`** — `name`, `parent_category_id` (self-referencing). Assigned to `product`.
  Used for browsing and budgeting, **not** comparison.
- **`product_attribute_definition`** — `code`, `label`, `value_type`, `comparison_significant`.

### Product identity (shared)

- **`product_class`** — `name`, `category_id`, `comparison_unit_of_measure_id`.
- **`product`** — `product_class_id`, `brand_id`, `canonical_name`, `size_quantity`,
  `unit_of_measure_id`, `attribute` (jsonb, keyed by attribute definition code).
- **`product_identifier`** — `product_id`, `identifier_type` (`upc`/`ean`/`gtin`/`plu`),
  `identifier_value`. Unique on the type/value pair.
- **`retailer_product`** — `retailer_id`, `product_id` (**nullable until resolved**),
  `store_item_code`, `department`, `receipt_description`.
- **`product_alias`** — `retailer_product_id`, `printed_text` (verbatim), `normalized_text`
  (uppercased, whitespace-collapsed), `confidence`.

### Capture and evidence (private)

- **`capture`**, **`capture_image`**, **`capture_artifact`** — see `01-capture-pipeline.md`.

### Purchase (private)

- **`shopping_trip`** — `household_id`, `store_id`, `capture_id`, `purchased_at`,
  `subtotal_cent`, `tax_cent`, `total_cent`, `receipt_number`, `reconciliation_status`.
- **`shopping_trip_line_item`** — `shopping_trip_id`, `retailer_product_id` (nullable),
  `price_observation_id` (nullable), `printed_text`, `sequence`, `quantity`, `size_quantity`,
  `unit_of_measure_id`, `weight`, `unit_price_cent`, `extended_price_cent`,
  `resolution_status` (`unresolved`/`auto_matched`/`user_confirmed`/`ambiguous`).
  - *Nullable `retailer_product_id` + explicit `resolution_status` means ingestion never blocks
    on identity.*
  - *`quantity`, `size_quantity`, and `weight` are three separate things receipts conflate.*

### Price intelligence (shared)

- **`price_observation`** — `retailer_product_id`, `store_id`, `observation_source`
  (`receipt`/`shelf_tag`/`manual`), `price_cent`, `size_quantity`, `unit_of_measure_id`,
  `normalized_unit_price` `numeric(12,6)`, `price_kind`
  (`regular`/`sale`/`clearance`/`loyalty`/`coupon_applied`), `observed_at`,
  `verification_state`, `confidence`, `verified_at`, `verified_by_user_account_id`,
  `superseded_by_id`, `contributed_by_user_account_id` **(restricted)**,
  `capture_id` **(restricted)**.
  - **Append-only.** Corrections are new observations, never `UPDATE`.
- **`price_observation_dispute`** — `price_observation_id`, `raised_by_user_account_id`,
  `reason`, `resolution_state`, `raised_at`.
  - *Rule to enforce: **recency alone never wins over corroboration.***

### Shopping and cart (private)

- **`cart`** — `household_id`, `store_id`, `status` (`active`/`abandoned`/`completed`),
  `shopping_trip_id` (nullable), `started_at`.
- **`cart_item`** — `cart_id`, `retailer_product_id` (nullable), `capture_id` (nullable —
  the shelf tag scanned in response to an unknown-item prompt), `quantity`,
  `estimated_price_cent` (nullable), `price_basis`
  (`recent_observation`/`shelf_tag_scanned`/`manual`/`unknown`),
  `shopping_trip_line_item_id` (nullable).
  - *Nullable price plus explicit `unknown` basis lets the running total honestly report
    "$47.20 plus 3 unpriced items." With the phone clamped to a cart handle, an estimate that
    quietly lies is worse than one that admits ignorance.*
  - *`shopping_trip_line_item_id` is the reconciliation link. Every mismatch is a parser bug,
    a price discrepancy, or an unscanned item — all three worth knowing.*
- **`shopping_list`** / **`shopping_list_item`** — `household_id`, `name`; then
  `shopping_list_id`, `product_class_id` or `retailer_product_id`, `quantity`, `checked_at`.

### Contribution and gamification

- **`contribution_event`** — `user_account_id`, `event_kind`, `points`, `source_type`,
  `source_id`, `awarded_at`, `reversed_at`, `reversal_reason`.
  - *Append-only ledger, not computed on demand. Point rules will change, and a rule change
    must not silently rewrite everyone's history.*
  - *`reversed_at` exists from day one even if unused.*
- **`badge`** / **`badge_award`** — `code`, `label`, `criteria`; then `badge_id`,
  `user_account_id`, `awarded_at`.
- **Leaderboards read from `contribution_event`**, never from `price_observation`.
  Leaderboards are cross-household by definition; the observation table must not be opened up
  to make them work.

---

## Supabase notes

**Two RLS regimes.** Shared tables: readable by all authenticated users, writable only through
security-definer functions, so a bad scan in one household can't corrupt canonical data for
everyone. Private tables: `household_id`-scoped, single-hop policies on the local column.

**`household` itself is a deliberate, temporary exception to the private-tier read scoping**
(see ADR 0015): any authenticated user can `select` every household (`id`/`name`/timestamps
only, `deleted_at is null`), and can `insert` a `household_member` row for themselves into any
household. Nothing else about a household is exposed this way — every other private-tier table
is still scoped by `app.current_household_id_list()`, which only grows through an accepted
membership row. This is round-1 "no privacy or permissions yet" onboarding; narrowing it is
tracked in `docs/decisions/deferred.md`.

**Column-level grants** on `price_observation` for `contributed_by_user_account_id` and
`capture_id`. (A `price_observation_public` view is the alternative; grants are cleaner
because there's one object rather than two to keep in sync.)

**Realtime is cache invalidation, not data transport.** If Realtime payloads are applied
directly to local state, clients diverge silently the moment they miss messages — which is
exactly what happens during a disconnect, and reconnect offers no replay. Instead the message
says "household 7's list changed" or "store 42 moved past revision 90210," and the client runs
the same cursor-based delta pull it would run on cold start. Missed messages cost latency only.
One sync path instead of two.

Subscribe narrowly: household-scoped channels always; a per-store channel only while shopping
or scouting. A global catalog subscription is a firehose.
