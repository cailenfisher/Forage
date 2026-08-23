# ADR 0014 — Location is optional and opt-out-able

- **Date:** 2026-08-22
- **Status:** Accepted

## Context

Store detection by geolocation is convenient and is the obvious way to drive the in-store
review queue. It is also a permission a user may reasonably decline, and a feature that fails
in a basement-level grocery store.

## Decision

- Location is **optional and opt-out-able**.
- Store selection for shop and scout trips is **always manually selectable**, regardless of
  location availability.
- The in-store review queue and store-suggestion features **degrade gracefully**, falling back
  to a manual "my stores" list rather than requiring geolocation.
- Keep the MVP implementation deliberately light.

## Consequences

- No feature may be built such that it is unreachable without location permission.
- `store.latitude` / `store.longitude` exist for suggestion and distance display, not as a
  gate on capture.
