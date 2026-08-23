# Forage — project overview

> **Living document.** Describes the present. If it disagrees with the code, one of them is
> wrong — say so rather than quietly following either.

## What Forage is

A grocery and household goods **price-tracking** app. React Native, Expo.

The value proposition is **price intelligence**: a personal price book tracking unit price
per item per store over time. It is **not** a budgeting app and **not** a pantry inventory
app. Groceries and household goods are a single consumables bucket.

Built as a learning and portfolio project, but a genuine personal tool — the correctness bar
is "I will actually rely on this in a store," not "it demos well."

## Core concepts

**Canonical item database.** Keyed on store SKUs and UPCs, with an alias table mapping
printed receipt text to catalog entries. This is the foundation everything else stands on.

**Price observation.** The atomic fact: this retailer product, at this store, at this price,
in this size, at this time, from this kind of evidence. Everything reads from observations.

## Capture modes

| Mode | Produces |
|---|---|
| Receipt scan | Purchase record + price observations |
| Shelf tag photo | Price observations, no purchase |
| Barcode scan | Identity resolution, no price |
| Manual entry | Price observation |

Receipt scanning is the flagship. **Shelf tag photography is a first-class source**, not
merely a UPC-to-SKU bridge — it independently yields unit price and size data.

## User-facing modes

- **Scout mode** — walk an aisle, capture many shelf tags, buy nothing.
- **Shopping mode** — barcode-scan items into a cart, get a running estimated total, get
  prompted to capture a shelf tag when an item is unknown.

## Working principles

1. **Spec-first.** Specify and review a stage before implementing it.
2. **Incremental, with staged reviews.** Ship one stage, review, then the next.
3. **Document known gaps explicitly.** A silent workaround is worse than a filed gap.
4. **Test against real device output.** OCR geometry from a real camera differs meaningfully
   from idealized input. Emulator confidence is not confidence.
5. **Never silently guess to fill a gap.** An absent field is recoverable; a fabricated one
   corrupts the price book.
6. **Partial data is success.** Three items resolved out of twenty is three more price
   observations than the user had before.
7. **Honest feasibility assessment.** Say when something won't work.
8. **Verify native dependency compatibility against current docs before installing.** Do not
   infer versions from training data.
9. **Surface conflicts, don't resolve them unilaterally.** If this spec contradicts a task,
   flag it.

## Stack

| Concern | Choice |
|---|---|
| Framework | Expo (prebuild / CNG) |
| Native modules | Expo Modules API |
| OCR | ML Kit, on-device |
| Local persistence | SQLite |
| Backend | Supabase (Postgres + RLS + Storage) |
| Package manager | pnpm |

## Where things are written down

- **`docs/decisions/`** — dated ADRs. Historical, append-only, never edited.
- **`docs/specs/`** — living contracts. Edited in lockstep with code.
- **`docs/decisions/deferred.md`** — what we chose not to build yet, and why.
