---
paths:
  - "src/capture/**"
  - "src/**/*capture*"
  - "src/**/*camera*"
  - "src/**/*ocr*"
---

# Capture rules

**Read `docs/specs/01-capture-pipeline.md` first.**

## Invariants

- **Raw artifacts are persisted permanently.** Raw OCR JSON and source image. Never deleted,
  never overwritten. `capture_artifact` gets a new row per parser run, so the parse history is
  intact. Any code path that discards an artifact after a successful parse is a bug. (ADR 0002)
- **Capture is non-blocking.** The UI never waits on OCR, parsing, or reconciliation, and never
  blocks on a parse failure. Snap and forget.
- **Partial results are success**, not an error state. Surface what resolved; record what didn't.
- **Store a storage bucket + key, never a URL.**
- **Set `content_hash` and `byte_size` on every image.** The hash is free deduplication and the
  cheapest defense against the same receipt being uploaded twice.
- **Multiple images per capture are normal** — long receipts get 2–3 overlapping shots. Order
  by `sequence`.
- **Separate storage buckets by capture type.** Shelf tag photos are pictures of a store's
  public price and are shareable for dispute resolution. Receipt photos are not.
- **`capture_type` and `observation_source` are different axes.** How data entered ≠ what
  evidences the price. A barcode scan produces zero observations, or one *manual* observation
  if the user types a price.
- **Location is optional.** Never gate capture on geolocation permission; store selection is
  always manually available. (ADR 0014)
