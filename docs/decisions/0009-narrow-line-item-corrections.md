# ADR 0009 — Corrections are narrow, append-only, and field-level

- **Date:** 2026-08-22
- **Status:** Accepted

## Context

Human corrections must survive re-parse. Without a record that a human touched a field,
parser v-next clobbers it.

## Decision

- **`line_item_correction`** — append-only: line item FK (a **real** FK), field name,
  old value, new value, `corrected_at`.
- **No polymorphic FK.** Deliberately narrow, deliberately not general.
- **Field-level edits only.** Structural problems (split a row, delete a row, merge rows)
  route to **reject-and-recapture**, not to a structural correction record.
- Written through a **`CorrectionStore` interface** so call sites stay ignorant of whether
  corrections later generalize beyond line items.

### Reconciliation policy on re-parse

**Human always wins.** Corrections replay in `corrected_at` order after the parser runs.

Conflict detection is **built but inert**: when a re-parse would have disagreed with a
correction, log it. Do not act on it.

## Consequences

- A general polymorphic `correction` table covering trip-level fields (wrong store, wrong
  date — the higher-damage case) is deferred, specifically to avoid polymorphic FK costs in
  Postgres. See the deferred register.
- The eventual upgrade ("human wins unless the parser is now confident and disagrees") means
  a re-parse can **grow** the review queue. Noted, not implemented.
