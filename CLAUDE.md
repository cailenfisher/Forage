# Forage

Grocery and household goods **price tracking**. React Native / Expo. The value proposition is
price intelligence — unit price per item per store over time. Not budgeting, not pantry
inventory.

<!-- Keep this file under 200 lines. Detail belongs in docs/; scoped guidance belongs in
     .claude/rules/. If this file grows, move content out rather than trimming meaning. -->

## Where things are written down

| Path | Kind | Rule |
|---|---|---|
| `docs/decisions/` | Dated ADRs | **Historical. Never edit to reflect a new decision** — write a new ADR that supersedes. |
| `docs/specs/` | Living contracts | Describe the present. **Update in the same commit as the code.** |
| `docs/decisions/deferred.md` | Deferred register | What we chose not to build, and why. |

If a spec disagrees with the code, **say so**. Do not quietly follow either one.

## Non-negotiables

These are the constraints where a silent workaround compounds into an unrecoverable problem.

1. **Raw capture artifacts are persisted permanently.** Raw OCR JSON and source image, forever.
   Never delete, never overwrite. `capture_artifact` gets a new row per parser run.
   The replay path is a tested feature, not a debugging convenience. (ADR 0002)

2. **Never silently guess to fill a gap.** An absent field is recoverable; a fabricated one
   corrupts the price book. Missing data is recorded as missing.

3. **`price_observation` is append-only.** Corrections are new observations. Never `UPDATE`.
   (ADR 0003)

4. **The FK points private → shared, never the reverse.** `shopping_trip_line_item.price_observation_id`
   is correct; an observation linking back to a trip is a privacy breach — it lets anyone
   reconstruct a stranger's basket. (ADR 0006)

5. **Money is integer minor units** (`price_cent`). Never float, never Postgres `money`. The
   one exception is `normalized_unit_price` at `numeric(12,6)`.

6. **Confidence `null` ≠ `0.0`.** Null is "no opinion"; zero is "confident it's wrong."
   Collapsing them breaks review-by-exception. (ADR 0008)

7. **Verify native dependency compatibility against current docs before installing.** Do not
   infer versions or APIs from training data.

## Working agreement

- **Spec-first.** Specify and review a stage before implementing it. If a task requires a
  design decision that isn't written down, **stop and ask** — do not improvise a schema, a
  state machine, or a parser heuristic.
- **Document known gaps explicitly.** Add to `docs/decisions/deferred.md` rather than working
  around something quietly.
- **Test against real device output.** OCR geometry from a real camera differs meaningfully
  from idealized input. Emulator confidence is not confidence.
- **Partial data is success.** Three items resolved out of twenty is three more price
  observations than the user had before. Design for incompleteness as a normal state.
- **Surface conflicts, don't resolve them unilaterally.**

## Stack

Expo (prebuild/CNG) · Expo Modules API for native · ML Kit on-device OCR · SQLite locally ·
Supabase (Postgres + RLS + Storage) · **pnpm**

Use `pnpm`, never `npm` or `yarn`.

## Naming

Singular `snake_case` tables · `id` PKs · `<singular_table>_id` FKs · `_at` timestamp suffix ·
no `is_`/`has_` boolean prefixes. Two project exceptions: attributed junctions become named
entities (`household_member`), and it is `retailer`, not `store_chain`.

Full conventions: `docs/specs/03-data-model.md`.
