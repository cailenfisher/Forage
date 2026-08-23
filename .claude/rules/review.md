---
paths:
  - "src/review/**"
  - "src/**/*review*"
  - "src/**/*correction*"
  - "src/**/*confidence*"
---

# Review queue rules

**Read `docs/specs/04-review-queue.md` first.** ADRs 0008–0013 are the reasoning.

## The governing constraint

**Review by exception, not review by row.** If every field is an exception, the review screen
becomes a data-entry form and the feature is dead. Every design choice here serves skippability.

## Invariants

- **`field_confidence` null ≠ 0.0.** Null is "no opinion"; zero is "confident it's wrong."
- **Threshold logic lives in exactly one place.** Do not inline a comparison at a call site —
  it needs to move to config later without a hunt.
- **The `ConfidenceProvider` stub returns unknown for everything.** That correctly forces full
  review during the stub period. Do not fake confidence to make the queue look shorter.
- **Corrections go through `CorrectionStore`.** Field-level only, append-only, real FK, no
  polymorphic FK.
- **Structural problems route to reject-and-recapture**, never to a structural correction record.
- **On re-parse, human always wins.** Corrections replay in `corrected_at` order. Conflict
  detection is built but **inert** — log a would-be disagreement, don't act on it.
- **`review_task` closure is by timestamp, never deletion.**
- **Dismissal and snooze are columns on `review_task`**, not `resolution_status` members. A
  dismissed item is still unresolved; the user's intent changed, not the data.
- **A dismissed item produces no price observation.** Permanently out of the price book.
- **Verification is scoped and enforcing.** A confirmation verifies only the fields the crop
  showed. Carry both crop geometry (authoritative) and derived field list (cache). Geometry wins.
- **Provisional means visible-but-marked, never hidden.** Hiding provisional rows makes
  corroboration structurally impossible and guarantees duplicates.

## Don't build these yet

Reopen-on-new-information, context-based snooze, per-user dismissal scope, cascading dismissal
via `parent_review_task_id`. All are in `docs/decisions/deferred.md` with their paths left open.
