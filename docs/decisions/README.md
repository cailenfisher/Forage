# Decision records

Each file here records **one decision, made once, on a date**. They are historical documents.

## Rules

1. **Never edit an accepted ADR to reflect a new decision.** Write a new ADR that says
   `Supersedes: NNNN` and change the old one's `Status:` line to
   `Superseded by NNNN` — that one-line status edit is the only permitted change.
2. **Never delete an ADR.** A reversed decision is more informative than a missing one.
3. Number sequentially. Filename is `NNNN-kebab-case-title.md`.
4. Keep the shape: Context / Decision / Consequences. Add `Severity:` when getting it wrong
   is expensive or irreversible.

## Why this shape

An ADR cannot go stale, because it never claimed to describe the present. A document that
*does* claim to describe the present — see `docs/specs/` — can drift silently, and an agent
will follow it confidently right off the edge. Keeping the two kinds of document physically
separate is the whole point of this directory.

## Index

| # | Decision | Status |
|---|---|---|
| [0001](0001-expo-with-prebuild.md) | Expo with prebuild/CNG over bare React Native | Accepted |
| [0002](0002-persist-raw-capture-artifacts.md) | Raw capture artifacts persisted permanently | Accepted |
| [0003](0003-price-observation-is-the-spine.md) | `price_observation` is the append-only spine | Accepted |
| [0004](0004-three-layer-product-identity.md) | Product identity has three layers | Accepted |
| [0005](0005-product-class-for-comparison.md) | `product_class` + comparison-significant attributes | Accepted |
| [0006](0006-shared-and-private-tiers.md) | Two data tiers; FK points private → shared | Accepted |
| [0007](0007-no-session-entity.md) | No session entity; derive from `capture` | Accepted |
| [0008](0008-per-field-confidence.md) | Per-field confidence; unknown ≠ zero | Accepted |
| [0009](0009-narrow-line-item-corrections.md) | Corrections narrow, append-only, field-level | Accepted |
| [0010](0010-review-task-is-a-real-table.md) | `review_task` is a real table, eagerly materialized | Accepted |
| [0011](0011-dismissal-and-snooze.md) | Dismissal and snooze live on `review_task` | Accepted |
| [0012](0012-verification-state-enforces-scope.md) | `verification_state` enforces scope | Accepted |
| [0013](0013-provisional-products-are-a-flag.md) | Provisional products are a flag only | Accepted |
| [0014](0014-location-is-optional.md) | Location is optional and opt-out-able | Accepted |
| [0015](0015-open-household-bootstrap.md) | Household bootstrap is open, client-driven onboarding (round 1) | Accepted |
