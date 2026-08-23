---
paths:
  - "supabase/migrations/**"
  - "src/db/**"
  - "src/**/*schema*"
  - "**/*.sql"
---

# Schema rules

**Read `docs/specs/03-data-model.md` before writing a migration.** The reasoning behind these
structures is in `docs/decisions/` — ADRs 0003 through 0007 are load-bearing.

## Before writing any migration

1. **Assign the tier.** Shared (readable by all authenticated users) or private
   (`household_id`-scoped)? A table ambiguous about its tier is one you cannot write a coherent
   RLS policy for.
2. **Check the FK direction.** Private → shared. Never shared → private. An observation linking
   back to a trip lets anyone reconstruct a stranger's basket. (ADR 0006)
3. **Update `docs/specs/03-data-model.md` in the same commit.**

## Invariants

- **`price_observation` is append-only.** Corrections are new observations with
  `superseded_by_id` linking the chain. Never `UPDATE`.
- **Money is integer minor units** (`price_cent`). Never float, never `money`. Exception:
  `normalized_unit_price numeric(12,6)`.
- **`id` is UUIDv7, client-generated.** Time-sortable, and doubles as the offline idempotency key.
- **`deleted_at` soft delete is mandatory on anything that syncs.** A hard-deleted row can't
  appear in a delta, so the client keeps it forever.
- **`revision bigint` comes from one shared sequence, not per-table.** Timestamps are the
  tempting alternative and are wrong — clock skew and ties silently drop rows.
- **Denormalize `household_id` onto every private-tier table**, even where derivable. This is
  the one place we deliberately break normalization; multi-join RLS policies are slow and hard
  to reason about.
- **No polymorphic FKs.** Where multiple parents are possible, use nullable FKs plus a `CHECK`
  enforcing exactly-one-non-null, plus partial unique indexes. See `review_task`.
- **`household`, not `user_account`, owns private data.** Always.
- **Restricted columns** on `price_observation`: `contributed_by_user_account_id` and
  `capture_id` are column-level-granted, not freely readable.

## Naming

Singular `snake_case` · `id` PK · `<singular_table>_id` FK · `_at` suffix · no `is_`/`has_`.
`retailer` not `store_chain`. Attributed junctions get real names (`household_member`).
