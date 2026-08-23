# ADR 0002 — Raw capture artifacts are persisted permanently

- **Date:** 2026-08-22
- **Status:** Accepted
- **Severity:** Non-negotiable. This is the single most important constraint in the capture pipeline.

## Context

The parser will be bad at first and will improve. If artifacts are discarded after a
successful parse, every parser improvement requires re-photographing receipts that no
longer exist.

## Decision

Every capture retains its **raw OCR output and source image, permanently**.

- `capture_artifact` holds `raw_output` (jsonb), `parser_version`, `parsed_at` — one row
  per parser run, never overwritten.
- `capture_image` holds a storage bucket + key (never a URL), `content_hash`, `byte_size`.
- The parser is a **pure function** over stored artifacts: `(ocrResult) => ParsedReceipt`.
- The **replay path** — re-running the current parser over stored artifacts — is a
  supported, tested, first-class operation, not a debugging convenience.

## Consequences

- OCR JSON is text, is tiny, and is kept forever regardless of image tiering.
- Because the JSON is kept, images become tierable: full resolution until parsed and
  user-verified, then downscale and drop the original.
- Any design that discards raw artifacts after a successful parse is wrong and should be
  rejected in review.
