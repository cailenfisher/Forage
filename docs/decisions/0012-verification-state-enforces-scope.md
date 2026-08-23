# ADR 0012 — `verification_state` enforces scope, it does not merely record it

- **Date:** 2026-08-22
- **Status:** Accepted

## Context

A user confirming a cropped region of a receipt has only seen what the crop showed. Recording
"this line item was verified" when the crop only contained the price is a lie the system will
later act on.

## Decision

Verification is **scoped and enforcing**: a confirmation can only verify the fields the crop
actually showed. A line item may therefore require **multiple confirmations at different scopes**
before it is fully verified.

Carry **both**:

- **Crop geometry**, in artifact coordinate space — the ground truth, re-derivable.
- **Derived field list** — the working answer, cheap to query.

The geometry is authoritative; the field list is a cache of it. If they disagree, the geometry wins.

Applies to **shelf tag captures as well as receipts**.

`scope` is passed through to the confirmation call regardless of what ultimately persists it.

## Consequences

- Partial verification is a normal state, not an error.
- `verification_state` is the hook for gating contribution points on corroboration rather than
  on submission.
