# ADR 0007 — No session entity; derive from `capture`

- **Date:** 2026-08-22
- **Status:** Accepted

## Context

Scout mode (walking an aisle capturing many shelf tags) invites a `scouting_session` entity
to hang analytics and gamification off. Committing to one early fixes a boundary that isn't
actually known yet.

## Decision

No session entity. Every `capture` carries `created_by_user_account_id`, `store_id`,
`capture_type`, and `captured_at`. Counting captures per user per time range — and lifetime —
is a plain aggregate over one table. "Longest scouting run" or "tags per session" can be
reconstructed later with a time-gap window function over the same columns.

`cart` exists, but strictly as a **working document** for shopping mode — not an analytics
grouping. Different concept, different lifetime, evolves independently.

## Consequences

- No column, no migration, no decision made early.
- A scout capture taken mid-shopping-trip and one from a dedicated scouting run are identical
  in the data and on leaderboards. This is the desired behavior.
