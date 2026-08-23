# ADR 0004 — Product identity has three layers

- **Date:** 2026-08-22
- **Status:** Accepted

## Context

A UPC identifies a product globally. A store SKU identifies it within one chain. A single
product legitimately carries several identifiers (case UPC and unit UPC; store brands get
repackaged). Two layers cannot hold this without one of them lying.

## Decision

- **`product`** — the platonic item, retailer-agnostic. What you compare across chains.
- **`product_identifier`** — UPC / EAN / GTIN / PLU. Separate table; unique on
  (`identifier_type`, `identifier_value`).
- **`retailer_product`** — the item as a chain carries it. Owns `store_item_code` (the SKU),
  `department`, `receipt_description`. `product_id` is **nullable until resolved**.
- **`product_alias`** — `retailer_product_id`, `printed_text` (verbatim), `normalized_text`
  (uppercased, whitespace-collapsed), `confidence`. Match on normalized, audit against verbatim.

`retailer_product` is scoped to **retailer, not store**. SKUs are chain-wide; prices are
store-specific. A SKU learned at one Walmart resolves instantly at every other Walmart.

There is **no `store_product` table**. Store-level facts that matter — price, availability —
are observations, not identity.

## Consequences

- Ingestion never blocks on identity: an unresolved line item is a valid row with a price
  and a date; it just can't join the price book yet.
- Aliases are chain-scoped, because `GV MILK 2% GAL` is a Walmart string.
