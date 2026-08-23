---
paths:
  - "src/parser/**"
  - "src/**/*parser*"
  - "tests/fixtures/**"
---

# Parser rules

**Read `docs/specs/02-parser-pipeline.md` before changing any parser stage.** Each stage is a
contract; changing an output shape changes every downstream stage and every fixture.

## Invariants

- **Never flatten OCR output to a string.** ML Kit returns blocks → lines → elements, each with
  a bounding box. Receipt parsing is a layout problem. Flattening discards the only signal that
  links a description to its price.
- **The parser is a pure function** `(ocrResult) => ParsedReceipt`. No I/O, no clock, no
  randomness, no React Native imports. This is what makes the replay path real and the tests
  Node-runnable.
- **All thresholds scale off median element height.** Never hardcode pixel values.
- **Reconciliation is a signal, not a gate.** A mismatch flags the capture for review; it never
  discards extracted items.
- **Drive the review queue from the subtotal checksum, not OCR confidence scores** — those are
  unreliable and inconsistently exposed across wrappers.
- **Every line item carries a reference back to its source row(s) and element(s)**, so the debug
  overlay can highlight and the review UI can crop.
- **Extract `store_item_code` where printed.** The canonical item database is keyed on it.
- **Quantity, size, and weight are three separate things.** Receipts conflate them; we don't.
  Line totals alone are insufficient for price intelligence.

## When a receipt doesn't parse

Record the gap. Do not add a heuristic that happens to fix the one fixture in front of you
without stating what it assumes and adding a fixture that exercises it.
