# ADR 0006 — Two data tiers, with the FK pointing private → shared

- **Date:** 2026-08-22
- **Status:** Accepted
- **Severity:** Privacy-critical. Reversing the FK direction is a data breach, not a refactor.

## Context

Price facts are a public good — if every household starts from zero, the app never becomes
useful to anyone. Purchase history is not shareable: what you bought, in what quantity, at
what time, is identifying.

## Decision

- **Shared tier** (readable by any authenticated user): `product_class`, `product`,
  `product_identifier`, `retailer_product`, `product_alias`, `retailer`, `store`,
  `price_observation`.
- **Private tier** (`household_id`-scoped): `capture`, `capture_image`, `capture_artifact`,
  `shopping_trip`, `shopping_trip_line_item`, `line_item_correction`, `review_task`, `cart`,
  `cart_item`, `shopping_list`.

**The foreign key points from private into shared.** `shopping_trip_line_item.price_observation_id`
— never the reverse. If the shared observation held a link back to a trip, anyone could group
observations by trip and reconstruct a stranger's entire basket. The basket itself is
identifying regardless of whether the contributor is anonymized.

Columns on `price_observation` that would leak — `contributed_by_user_account_id`, `capture_id`
— are retained for gamification and replay provenance but **restricted via Postgres
column-level grants**.

Two RLS regimes: shared tables readable by all, writable only through security-definer
functions; private tables `household_id`-scoped.

`household` — not `user_account` — is the ownership boundary for all private data. Retrofitting
multi-user onto user-owned rows is miserable, and it's needed the first time a partner scans
a receipt.

## Consequences

- A table ambiguous about which tier it belongs to is a table you cannot write a coherent
  policy for. Assign the tier before writing the migration.
- `household_id` is denormalized onto every private-tier table even where derivable.
