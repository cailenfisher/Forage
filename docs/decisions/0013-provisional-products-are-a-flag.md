# ADR 0013 — Provisional products are a flag, nothing more

- **Date:** 2026-08-22
- **Status:** Accepted

## Context

New catalog entries created from a single uncorroborated capture shouldn't carry the same
weight as well-established ones. The tempting move is to hide them until promoted.

## Decision

At MVP, "provisional" is **purely a flag**. It does not block, filter, or weight anything
differently.

- Applies to `product`, `retailer_product`, **and** `product_alias`.
- **Promotion default:** a second independent capture. Moderator action is an override.
- **Provisional must mean visible-but-marked, never hidden.** If provisional rows are hidden,
  a second contributor never sees them, creates a duplicate, and corroboration becomes
  structurally impossible.

## Consequences

- The real failure mode here is **duplicates, not malice**. Design against duplication first.
- Provisional state doing double duty as a merge-candidate queue for duplicate products is a
  natural extension. Deferred.
