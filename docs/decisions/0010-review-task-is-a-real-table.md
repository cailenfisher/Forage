# ADR 0010 — `review_task` is a real table, eagerly materialized

- **Date:** 2026-08-22
- **Status:** Accepted
- **Supersedes:** an earlier working assumption that review items could be derived on demand.

## Context

Dismissal, snooze, and assignment are state that belongs to the *task*, not to the underlying
row. A derived queue has nowhere to put them.

## Decision

`review_task` exists from the start.

- **Three nullable FKs** — `capture_id`, `shopping_trip_line_item_id`, `retailer_product_id` —
  with a `CHECK` constraint enforcing **exactly one non-null**, plus partial unique indexes.
  This avoids a polymorphic FK while keeping referential integrity real.
- **Columns:** `snoozed_until`, `dismissed_at`, `resolved_at`, `assigned_to_user_account_id`
  (nullable), `parent_review_task_id` (present but **unused**).
- **Closure is by timestamp, never by deletion.**
- **Eager materialization:** the parser writes task rows. The table *is* the queue.
- A **reconciliation pass** closes ghost tasks whose source row no longer qualifies.
- Hierarchy is flat for now; `parent_review_task_id` exists only to keep the cascade path open.

## Consequences

- The queue can be indexed, assigned, and counted like any other table.
- Ghost tasks are a real failure mode and the reconciliation pass is not optional.
