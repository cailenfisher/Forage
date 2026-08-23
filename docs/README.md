# Forage documentation

Two kinds of document live here, and the distinction is load-bearing.

## `decisions/` — dated ADRs

Historical records. Each one says what was decided, when, and why. **They are never edited to
reflect a new decision** — a reversal gets a new ADR that supersedes the old one, and the old
one's `Status:` line is updated to point at it.

An ADR cannot go stale, because it never claimed to describe the present.

Start with [`decisions/README.md`](decisions/README.md) for the index, and
[`decisions/deferred.md`](decisions/deferred.md) for what was deliberately not built.

## `specs/` — living contracts

These describe the **present state** of the system. They must be updated in the same commit as
the code they describe. A spec that has drifted is worse than no spec, because an agent will
follow it confidently.

| File | Covers |
|---|---|
| [`00-project-overview.md`](specs/00-project-overview.md) | What Forage is, capture modes, working principles, stack |
| [`01-capture-pipeline.md`](specs/01-capture-pipeline.md) | Snap-and-forget, artifacts, replay path, image lifecycle |
| [`02-parser-pipeline.md`](specs/02-parser-pipeline.md) | The five parser stages and their contracts |
| [`03-data-model.md`](specs/03-data-model.md) | Entity reference, conventions, tiers, Supabase notes |
| [`04-review-queue.md`](specs/04-review-queue.md) | Confidence, corrections, review tasks, verification, provisional |

## How Claude Code reads all this

`CLAUDE.md` at the repo root loads every session and is deliberately short — pointers plus the
handful of invariants that apply everywhere.

`.claude/rules/*.md` carry `paths:` frontmatter and load **only** when Claude opens a matching
file. Each rule is short and points at the relevant spec rather than inlining it.

The specs themselves are read on demand. They are not imported into `CLAUDE.md` with `@path`
syntax, because imports expand into context at launch and would consume the window every
session regardless of what's being worked on.
