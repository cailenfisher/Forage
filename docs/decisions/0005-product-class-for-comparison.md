# ADR 0005 — `product_class` plus comparison-significant attributes

- **Date:** 2026-08-22
- **Status:** Accepted

## Context

Brand + category + unit of measure does **not** make two items comparable. Category is too
coarse: "Dairy → Milk" contains whole, skim, organic, lactose-free, and buttermilk.

## Decision

`product_class` names the commodity independent of brand and package size — "whole milk,"
"large eggs," "unsalted butter." It carries its own `comparison_unit_of_measure_id`, so milk
compares by volume and eggs by count automatically.

Variants that block substitution are handled by **attributes flagged as comparison-significant**
(`product_attribute_definition.comparison_significant`), not by proliferating classes.

**Two products are comparable when they share a class and match on every significant attribute.**

Comparison key = `product_class_id` + the jsonb subset whose definitions are significant.

- **Decided:** store brand is comparable to name brand. `brand` is descriptive only and
  never affects grouping.
- **Decided:** organic and lactose-free are the significant distinctions at MVP. Keep the
  significant set tiny.
- `category` is assigned to `product`, used for browsing and budgeting, **never** for comparison.

## Consequences

- The significance flag is data, not schema. Deciding next year that grass-fed blocks
  substitution is one row, not a migration and a reclassification pass.
- Non-significant attributes accumulate in jsonb until one earns promotion to a typed column.
