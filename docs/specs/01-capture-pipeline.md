# Capture pipeline

> **Living document.** See ADR 0002 — raw artifact persistence is non-negotiable.

## Snap-and-forget

Capture is **instant and non-blocking**. The user photographs a receipt or tag and moves on.
All OCR, parsing, and reconciliation happen asynchronously. The capture UI never waits on
processing and never blocks on a parse failure.

## Partial data is a normal state

A capture yielding partial results is a **success**. The data model, the UI, and the parser
must all accommodate incompleteness as a normal state rather than an error condition.

**Corollary: never silently guess to fill a gap.** Missing data is recorded as missing.

## Artifacts

Every capture retains raw OCR output and source image **permanently**.

- `capture` — `household_id`, `created_by_user_account_id`, `store_id` (nullable),
  `capture_type` (`receipt` / `shelf_tag` / `barcode` / `manual`), `processing_status`,
  `captured_at`, `deleted_at`.
- `capture_image` — `storage_bucket`, `storage_key`, `content_hash`, `byte_size`,
  `variant` (`original` / `compressed`), `sequence`.
- `capture_artifact` — `raw_output` (jsonb), `parser_version`, `parsed_at`. **One row per
  parser run. Never overwritten.**

### Rules

- Store a **storage key and bucket, never a URL**.
- `content_hash` gives free deduplication and integrity checking — the cheapest defense
  against the same receipt being uploaded twice.
- **Multiple images per capture.** Long receipts get photographed in two or three overlapping
  shots. `sequence` orders them.
- **Split buckets by capture type.** A shelf tag photo is a picture of a store's public price
  and is genuinely useful to share for dispute resolution. A receipt photo is about as private
  as it gets. Separate them now.

## `capture_type` vs `observation_source`

These are different axes and must not be conflated.

- `capture_type` — **how data entered the system**.
- `observation_source` — **what evidences the price**.

A barcode scan is an identity event producing zero observations, or one *manual* observation
if the user types a price. Retaining `capture_id` on the observation preserves the difference
between "manual price typed right after a barcode scan in-store" and "manual price typed at
the kitchen table three days later."

## Replay path

Re-running the current parser over stored artifacts is a **supported, tested, first-class
operation**. It must be exercised, not just possible.

The parser is a pure function: `(ocrResult) => ParsedReceipt`. No I/O, no clock, no
randomness. This is what makes replay meaningful.

## Image lifecycle

Full resolution until the capture is parsed and user-verified, then downscale and drop the
original. Roughly 1 GB/year per household at ten trips a week.

OCR JSON is text, is tiny, and is **kept forever regardless**. That is precisely what makes
the images tierable at all.
