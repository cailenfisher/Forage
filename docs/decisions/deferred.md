# Deferred register

Decisions deliberately **not** made yet, with the path left open. This file is living — items
move out of it when they become ADRs.

An item being here means: *we considered it, we chose not to build it, and we know what it
would cost to add later.* It does not mean "we forgot."

---

## Corrections

**A general polymorphic `correction` table** covering trip-level fields — wrong store, wrong
date. This is the **higher-damage** case: a mis-attributed trip poisons every observation it
produced. Rejected for MVP specifically to avoid polymorphic FK costs in Postgres.
`line_item_correction` stays narrow. See ADR 0009.

**Correction reconciliation upgrade** — from "human always wins" to "human wins unless the
parser is now confident and disagrees," surfacing conflicts back into the review queue.
Note the consequence: **a re-parse can grow the queue.** Conflict detection is already built
and inert, so the data to evaluate this will exist.

## Review queue

**Dismissal reopen-on-new-information** — triggers: a new alias is learned, a re-parse
differs, a matching product enters the catalog. This would collapse dismiss and snooze into
one concept with different triggers.

**Context-based snooze** — hide until next in this store, rather than time-based. This is the
one that actually fits the in-store review queue and is the most likely first upgrade.

**Per-user vs household dismissal scope.** Currently household.

**Cascading dismissal** via `parent_review_task_id`. Column exists, unused. See ADR 0010.

**Threshold ownership** moving from a computed data column to configuration. See ADR 0008.

## Retail locations

**No write path for `retailer` / `store` yet.** Both are shared-tier and, like the rest of the
shared catalog, writable only through security-definer functions per `03-data-model.md` — but
unlike `product` / `retailer_product` / `product_alias`, no `create_provisional_*` function
exists for them, and RLS grants `SELECT` only. The receipt-capture screen (first pass,
2026-08-23) needs a real `store_id` — it's `NOT NULL` on `shopping_trip` — so one Walmart
retailer/store was seeded directly via migration (`seed_test_store_and_receipt_bucket`) purely
to unblock manual device testing. There is still no way for a user to add a store from the app.
Picking this up means deciding whether store creation gets the same provisional-flag treatment
as products (ADR 0013) or something else — ADR 0014 only settled that store selection must be
manual, not who can create one.

## Capture and ingestion

From the receipt-capture screen's first pass (2026-08-23, `src/lib/receipts.ts`):

- **Processing is synchronous and foreground**, not the "snap-and-forget" async pipeline
  `01-capture-pipeline.md` describes — OCR, parse, upload, and every insert happen while the
  screen waits, in one request/response cycle. The durability guarantee still holds (the
  `capture_artifact` row is written before `shopping_trip`/line items are attempted), but there's
  no background queue or retry UI yet if the trip-creation half fails after the artifact half
  succeeds.
- **Coupon/discount adjustments are netted into `extended_price_cent`**, not stored as their own
  rows — there's no adjustments table on `shopping_trip_line_item`. The individual adjustment
  amounts aren't lost (they're still in `capture_artifact.raw_output` forever), just not
  queryable as separate rows.
- **`tax_cent`, `total_cent`, and `receipt_number`** are not extracted by the parser and are
  always left `null` on `shopping_trip`.
- **`purchased_at` uses the device's local clock to interpret the printed date/time**, not
  `store.timezone` — a real conversion was skipped rather than risk a wrong one. In practice the
  scanning device and the store are almost always in the same timezone, but this is a known gap,
  not a verified equivalence.
- **`store_item_code`**, when the parser extracts one, currently goes nowhere — there's no
  `retailer_product` row to attach it to yet (product/retailer_product resolution is unbuilt).
  It's preserved in the raw OCR JSON, not in any queryable column.

## Catalog

**Provisional state as a merge-candidate queue** for duplicate products. Natural extension of
ADR 0013, since duplicates are the actual failure mode.

**Promoting jsonb attributes to typed columns** once usage reveals which ones matter.

**Trust scoring** on contributors, feeding observation confidence.

**Substitution preferences** — whether a user accepts store brand for name brand is a per-user
judgment. Do not bake "same class means interchangeable" into anything irreversible.

## Identity and tenancy

**Invite-gated household joining.** ADR 0015 resolved the bootstrap question with the loosest
possible version: any authenticated user can browse every household and self-join, no
approval or invite required. That was a deliberate choice for round 1 ("no privacy or
permissions yet"), not a final one. Picking this up means narrowing
`household_select_authenticated` and `household_member_insert_self` (see the ADR) — likely to
an invite code or an owner-approval step — and deciding what happens to a user who already
self-joined a household under the open rule when that household later turns invites on.

**Multiple households per user.** Nothing in the schema prevents a `household_member` row per
household a user joins, but the client currently assumes one and silently takes the
earliest-joined row (`use-household.tsx`). A real multi-household UX — switching, or scoping
capture to "which household is this receipt for" — is unbuilt.

## Sync

**Offline sync — revisit before implementation.** MVP targets one household, where a full
mirror is fine. Corner-avoidance constraints are already reflected in the schema: filterable
read path (full mirror and working set differ by a parameter, not a code path), a shared
`revision` sequence, soft delete everywhere, clean tier separation.

Direction when picked up: **offline-first on the write path, cached working set on the read
path.** The write path is easy because the model is append-only — client-generated UUIDs,
local outbox, no merge conflicts because two devices never write the same row. The read path
is where a full mirror gets expensive on low-end phones: mirror household data in full,
per-store catalog snapshots on visit, global reference data in full.

**ElectricSQL is the leading candidate.** It syncs read-path *shapes* (per-table queries with
a where clause), which maps almost directly onto the shared/private split. Writes go through
our own API rather than Electric — exactly the outbox pattern.

## Privacy

**De-anonymization at low density.** In a store where one person contributes most of the data,
forty observations sharing a timestamp cluster obviously, and "anonymous" gets thin.
Mitigations: coarsen `observed_at` on the public read path; suppress observations below a
corroboration threshold. Not an MVP problem, but "anonymous" is a promise worth not designing
against.

---

## Carried over from the parser POC

The parser (`src/parse/*`) has been ported into this repo from `forage-poc`, with two changes
made on the way in: line item and reconciliation amounts are now integer cents (were float
dollars), and `store_item_code` is extracted from the description per ADR 0004 (previously left
embedded in it). Accepted as ongoing tuning work, not blockers:

- Fixture corpus breadth — one Walmart receipt is not a corpus.
- Reconciliation false-negative coverage.
- Replay path validation (addressed, needs continued exercise).
- iOS / Android ML Kit geometry parity.
- **`store_item_code` extraction is a single-fixture heuristic** — any run of 10–14 digits
  sitting in its own OCR element within the body zone. Untested against a receipt where some
  other multi-digit number (not a UPC) lands in that zone; needs a fixture with a false positive
  before the pattern can be trusted.

**Correction (2026-08-22):** this section previously said per-field confidence emission had "an
interface [that] exists, provider is a stub." That was not accurate against the actual parser
code, ported or otherwise — no `ConfidenceProvider` interface exists anywhere yet, and the
parser emits no confidence signal, per-field or otherwise. `LineItem` has no `field_confidence`
shape. The stub described in `docs/specs/04-review-queue.md` (returns "unknown" for every field)
remains open work, not a wire-up — flagging here rather than leaving the drift in place.
