# ADR 0003 — `price_observation` is the append-only spine

- **Date:** 2026-08-22
- **Status:** Accepted

## Context

Prices arrive from receipts, shelf tags, and manual entry. Only one of those is a purchase.
If price lived on the receipt line item, shelf tags would have nowhere to go and a second,
parallel price path would emerge that never quite reconciles with the first.

## Decision

`price_observation` is an **append-only fact table**. A receipt line item *produces* an
observation. A shelf tag *produces* an observation. All price intelligence — trends,
best-store-for-item, deal detection — reads only from observations.

Corrections are **new observations**, never `UPDATE`. `superseded_by_id` links the chain.

Money is stored as integer minor units (`price_cent`) — never float, never `money`. The one
exception is `normalized_unit_price` at `numeric(12,6)`, because `$/g` runs to fractions of
a cent.

`price_kind` (`regular` / `sale` / `clearance` / `loyalty` / `coupon_applied`) is recorded
at write time. It is cheap now and impossible to backfill; without it a clearance markdown
permanently poisons the "typical price at this store" figure.

## Consequences

- The analytics layer is reproducible and bug reports are debuggable.
- Shelf tag photography is a genuine first-class price source, not a bridge.
- Nothing writes price data anywhere except through an observation.
