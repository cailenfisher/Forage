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

## Catalog

**Provisional state as a merge-candidate queue** for duplicate products. Natural extension of
ADR 0013, since duplicates are the actual failure mode.

**Promoting jsonb attributes to typed columns** once usage reveals which ones matter.

**Trust scoring** on contributors, feeding observation confidence.

**Substitution preferences** — whether a user accepts store brand for name brand is a per-user
judgment. Do not bake "same class means interchangeable" into anything irreversible.

## Identity and tenancy

**`user_account` / `household` bootstrap on first sign-in.** Confirmed against the disposable
test project (2026-08-23): no trigger on `auth.users`, and `public.user_account` /
`public.household` / `public.household_member` are all empty. Google sign-in (see
`docs/specs/05-auth.md`) produces a Supabase session with nothing behind it in `public`.

Rejected building this alongside the login gate because it bakes in a real product decision —
does every new user get a private household by default, or is household membership
invite-only from day one? — that isn't written down anywhere. Options to weigh when picked up:
a `security definer` trigger on `auth.users` insert (the pattern Supabase's own quickstart uses
for a `profiles` table) that creates `user_account` plus a starter `household` +
`household_member` row, versus a client-driven onboarding step that lets a new user join an
existing household by invite instead of always minting a new one.

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
