# ADR 0011 — Dismissal and snooze live on `review_task`

- **Date:** 2026-08-22
- **Status:** Accepted

## Context

The queue must be able to reach zero, or it stops being a queue and becomes a wall.

A dismissed line item is still genuinely *unresolved* — the data didn't change, the user's
intent toward it did. So dismissal is not a `resolution_status`.

## Decision

- Dismissal and snooze are **columns on `review_task`**, not members of the
  `resolution_status` enum.
- **Dismissal is permanent.** No reopen at MVP.
- **Snooze is time-based** via `snoozed_until`.
- Both are **household-scoped**.
- A **dismissed item produces no price observation** and is permanently out of the price book.

## Consequences

- Simplest viable version, with several upgrade paths deliberately left open (reopen triggers,
  context-based snooze, per-user scope, cascading dismissal). See the deferred register.
- Context-based snooze ("hide until I'm next in this store") is the one that actually fits the
  in-store review queue, and is the most likely first upgrade.
