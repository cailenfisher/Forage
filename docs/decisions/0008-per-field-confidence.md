# ADR 0008 — Per-field confidence, with unknown distinct from zero

- **Date:** 2026-08-22
- **Status:** Accepted

## Context

The review UI only works if most fields can be skipped. That makes per-field confidence
**blocking rather than tuning** — without it every field is an exception and the review screen
degrades into a data-entry form.

## Decision

- `field_confidence jsonb`, keyed by field name, values 0–1.
- **`null`/absent (no opinion) is distinct from `0.0` (confident it's wrong).** Never collapse them.
- Persisted on: line item, trip, capture, and shelf-tag observation.
- `needs_review` is a **computed boolean column**. Threshold logic lives in exactly one place
  so it can move to config later without touching call sites.
- The stub `ConfidenceProvider` returns **unknown for every field**.

## Consequences

- During the stub period the queue honestly forces full review rather than silently faking
  confidence. That is the correct failure mode.
- Threshold ownership moving from a data column to configuration is a known future change and
  is listed in the deferred register.
