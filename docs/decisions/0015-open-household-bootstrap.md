# ADR 0015 — Household bootstrap is open, client-driven onboarding (round 1)

- **Date:** 2026-08-23
- **Status:** Accepted

## Context

`docs/decisions/deferred.md` left the `user_account` / `household` bootstrap question open: does
every new user get a private household by default, or is membership invite-only from day one?
Two options were on the table — a `security definer` trigger on `auth.users` that always mints a
starter household, versus a client-driven onboarding step.

## Decision

**Client-driven onboarding, open join, no invites.** After sign-in, a new user is shown a screen
to either create a household (becoming its `owner`) or join any existing household from a full
list (becoming a `member`). No invitation, approval, or ownership check gates joining — this is
deliberately the loosest possible version, matching "no privacy or permissions yet" for this
round.

Rejected the `auth.users` trigger: it forces "every user gets a private household" before we know
whether that's the right default, and a client step is easy to change later without a data
migration.

Two RLS changes were required, made in the same migration as this ADR:

- `household` gained an authenticated-read-all policy (`household_select_authenticated`),
  superseding the membership-scoped `household_select_member`. A new user has no membership yet,
  so they could not otherwise see the list to join.
- `household_member` gained a self-insert policy (`household_member_insert_self`,
  `with_check (user_account_id = auth.uid())`). The existing `household_member_write` policy
  requires `household_id` already be in `app.current_household_id_list()` — true for an existing
  member managing their household, but circular for a user's *first* membership row.
- A unique index on `household_member (household_id, user_account_id) where deleted_at is null`
  guards against duplicate membership rows (double-tap on Join).

`user_account` needed no policy change — `user_account_insert_self` already allowed a user to
create their own row.

## Consequences

- Any authenticated user can read every household's `id`/`name`/timestamps, and can join any
  household outright. This is intentionally wide open — no basket, price, or other private-tier
  data is exposed by it, since every private-tier table is still scoped by
  `app.current_household_id_list()`, which only grows via an accepted `household_member` row.
- **Invite-gated joining is now deferred**, not decided — see `docs/decisions/deferred.md`. The
  open read/join policies added here will need to be narrowed when that's picked up.
- A user with no accepted `household_member` row is treated as "needs onboarding." MVP assumes
  one household per user; the client takes the earliest-joined membership if more than one ever
  exists, but nothing in the schema prevents multiple.
