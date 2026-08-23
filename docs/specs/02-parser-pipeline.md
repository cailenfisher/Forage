# Receipt parser pipeline

> **Living document.** Each stage is a contract. Changing a stage's output shape is a change
> to every downstream stage and to the fixtures.

The parser is a pure function `(ocrResult) => ParsedReceipt`, staged. Each stage has a defined
input/output contract and is independently testable.

| # | Stage | File | Responsibility |
|---|---|---|---|
| 1 | Row reconstruction | `rows.ts` | Assemble OCR elements into logical rows using geometry |
| 2 | Price column detection | `rows.ts` | Identify the x-position where prices are printed |
| 3 | Zone segmentation | `zones.ts` | Partition into header / body / footer |
| 4 | Line item extraction | `lineItems.ts` | Parse rows into structured line items |
| 5 | Reconciliation | `reconcile.ts` | Validate items against printed subtotal |

---

## The flattening trap

Every ML Kit wrapper exposes a concatenated string, and it is a trap. ML Kit returns a
hierarchy — **blocks → lines → elements**, each with a bounding box. Receipt parsing is a
**layout problem, not a text problem**. The moment you flatten to a string you have thrown
away the only signal that tells you `MOZZARELLA` and `4.29` belong to the same purchase.

**All parsing works from elements and their bounding boxes.**

---

## Stage 1 — Row reconstruction

1. Flatten the OCR hierarchy to elements, each `{ text, box: { x, y, width, height } }`.
2. Compute **median element height** across the image. Use it as the scale reference for all
   thresholds — never hardcode pixel values.
3. Group elements into rows by vertical overlap: sort by y-center, merge elements whose
   vertical overlap exceeds ~50% of median height. Union-find or a greedy sweep both work.
4. Within each row, sort elements by x ascending.
5. Return `Row[]`, each with member elements and a union bounding box.

## Stage 2 — Price column detection

1. Find every element matching a currency-like pattern: optional currency symbol, digits,
   separator, **exactly two trailing digits**.
2. Cluster their bounding-box **right edges**. Receipts right-align prices to within a few
   pixels, so this cluster is tight and gives a vertical anchor line.
3. Expose the detected price-column x-position. Rows whose rightmost element sits in that
   cluster are candidate line items.

## Stage 3 — Zone segmentation

Split rows using anchor keywords, case-insensitive and tolerant of OCR noise:
`SUBTOTAL`, `SUB TOTAL`, `TAX`, `TOTAL`, `BALANCE`, `CHANGE`.

- **Header** — everything above the first row with a price in the price column.
- **Body** — from there to the first anchor row.
- **Footer** — the anchor row onward.

Extract from the header whatever is obviously available (store name, date, time) with loose
heuristics. **Do not overinvest here.**

## Stage 4 — Line item extraction

For each body row, produce a line item with `description` (all elements left of the price
column, joined) and `price`.

Known multi-row and modifier shapes that must be handled:

- **Weighted items** — `1.23 lb @ $1.99/lb` followed by a row with the extended price. Emit
  **one** line item carrying quantity, unit, unit price, and extended price.
- **Quantity multipliers** — `2 @ 3.49` followed by the extended price. Same treatment.
- **Negative rows** — coupons, discounts, deposits. **Attach to the preceding line item as an
  adjustment**, do not emit a standalone item.
- **Tax flags** — single-character codes between description and price. Strip from the
  description, retain on the line item.

**Every line item must carry a reference back to the row(s) and element(s) it came from**, so
the debug overlay can highlight its source and the review UI can crop to it.

### Store item codes

The parser must extract `store_item_code` where the receipt prints it. The canonical item
database is keyed on it — this is not optional enrichment. See ADR 0004.

### Quantity, size, unit price

Quantity, size, and weight are **three separate things receipts conflate**. Keep them separate.
Store `unit_price_cent` as printed when the receipt gives it; derive the normalized unit price
into the observation at write time. Line totals alone are not sufficient for price intelligence.

## Stage 5 — Reconciliation

1. Sum line items including adjustments.
2. Compare against the printed subtotal from the footer.
3. Return `{ parsedSum, printedSubtotal, delta, status }` where status is `match`, `mismatch`,
   or `no_subtotal_found`.
4. On mismatch, run diagnostics and include the findings:
   - **Delta equals exactly one line item's price** → likely a dropped or duplicated row.
   - **Delta is off by a factor of 10 or 100** → likely a lost decimal point from thermal smear.
   - Otherwise, report the delta plainly.

### Reconciliation is a signal, not a gate

A failed reconciliation **flags a capture for review. It does not discard the extracted items.**

This checksum should drive the review queue **rather than OCR confidence scores**, which are
unreliable and inconsistently exposed across wrappers.

---

## Testing

- Fixtures are derived from **actual on-device OCR**, not synthetic text.
- Tests are Node-runnable — the parser has no React Native dependency.
- Current corpus: one Walmart receipt. Breadth is a known gap; see `docs/decisions/deferred.md`.
