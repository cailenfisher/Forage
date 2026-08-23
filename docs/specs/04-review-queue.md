# Review queue

> **Living document.** Decisions behind this are ADRs 0008–0013.

## The governing constraint

**Review by exception, not review by row.** The review UI only works if most fields can be
skipped. If every field is an exception, the review screen degrades into a data-entry form
and nobody uses it twice.

Three consequences ripple through the schema: confidence is per-field; human corrections
survive re-parse; and the queue must be able to reach zero.

---

## Per-field confidence

`field_confidence jsonb`, keyed by field name, values 0–1. Persisted on **line item, trip,
capture, and shelf-tag observation**.

**`null` (no opinion) is distinct from `0.0` (confident it's wrong).** Never collapse them.

`needs_review` is a **computed boolean column**. Threshold logic lives in exactly one place.

The stub `ConfidenceProvider` returns **unknown for every field** — which honestly forces full
review during the stub period rather than silently faking confidence.

## Corrections

`line_item_correction` — append-only: line item FK (real FK), field, old value, new value,
`corrected_at`. **Field-level only. No polymorphic FK.**

Structural problems — split a row, delete a row, merge rows — route to **reject-and-recapture**.

Written through a **`CorrectionStore`** interface.

**Reconciliation on re-parse: human always wins.** Corrections replay in `corrected_at` order
after the parser runs. Conflict detection is **built but inert** — when a re-parse would have
disagreed, log it; do not act.

## Review tasks

`review_task` is a **real table** and **is** the queue. The parser writes task rows eagerly.

- Three nullable FKs — `capture_id`, `shopping_trip_line_item_id`, `retailer_product_id` —
  with `CHECK` exactly-one-non-null plus partial unique indexes.
- `snoozed_until`, `dismissed_at`, `resolved_at`, `assigned_to_user_account_id` (nullable),
  `parent_review_task_id` (present, unused).
- **Closure is by timestamp, never deletion.**
- A **reconciliation pass** closes ghost tasks whose source row no longer qualifies. Not optional.

### Dismissal and snooze

Both live on `review_task`, **not** as `resolution_status` enum members — a dismissed line item
is still genuinely unresolved; the data didn't change, the user's intent toward it did.

- Dismissal is **permanent** (no reopen at MVP).
- Snooze is **time-based** via `snoozed_until`.
- Both are **household-scoped**.
- **A dismissed item produces no price observation** and is permanently out of the price book.

## Verification scope

Verification is **enforcing, not merely recording**. A confirmation can only verify the fields
the crop actually showed, so a line item may need **multiple confirmations at different scopes**.

Carry **both**:

- **Crop geometry** in artifact coordinate space — ground truth, re-derivable, authoritative.
- **Derived field list** — the working answer, cheap to query, a cache of the geometry.

If they disagree, the geometry wins. Applies to shelf tag captures as well as receipts.

## Provisional products

Purely a **flag** at MVP. Does not block, filter, or weight anything differently. Applies to
`product`, `retailer_product`, **and** `product_alias`.

Promotion default is a second independent capture; moderator action is an override.

**Provisional must mean visible-but-marked, never hidden** — otherwise a second contributor
never sees the row, creates a duplicate, and corroboration becomes structurally impossible.

The real failure mode is **duplicates, not malice**.

---

## Interfaces to build against

Three seams where the backing implementation is deliberately deferred. Build the interface,
stub the implementation, keep call sites ignorant.

| Interface | Stub behavior | What's deferred |
|---|---|---|
| `ConfidenceProvider` | Returns unknown for every field | Real per-field emission from the parser |
| `CorrectionStore` | Writes `line_item_correction` | Whether corrections generalize beyond line items |
| Snooze / dismiss | Writes `review_task` state | Reopen triggers, context-based snooze, per-user scope |

The verification scope path passes `scope` through to the confirmation call regardless of what
ultimately persists it.

## Location

The in-store review queue **degrades gracefully without location**, falling back to a manual
"my stores" list. Store selection is always manually selectable. See ADR 0014.
