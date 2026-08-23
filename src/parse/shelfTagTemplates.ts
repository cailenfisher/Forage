import { rowText } from './rows.ts';
import type { Row } from './types.ts';

// ADR 0018. Templates are matched and applied by hand-written TS per slug,
// not by a generic jsonb rule interpreter -- the shelf_tag_template_version
// rows seeded in the `seed_shelf_tag_templates` migration carry
// match_rules/field_manifest/extraction_rules as a documentary mirror of
// the logic below, for audit and future tooling, but nothing here reads
// that jsonb back and executes it. Keeping the interpreter "deliberately
// dumb" is an accepted MVP gap, not solved (see the ADR and deferred.md).
//
// Matching is retailer-agnostic: extractShelfTagFields is a pure function
// of OCR text with no I/O, and retailer isn't known yet at extraction time
// in the current capture flow (store selection happens after review, per
// shelf-tag-capture-screen.tsx) -- so every template is scored on content
// signals alone. This is always the ADR's "retailer unknown" runtime-scope
// path; it never takes the "scope by retailer first" shortcut. Safe because
// Walmart's FAC/CAP footer grammar and Aldi's lack of it are, in the
// evidence gathered so far, mutually exclusive.

export const SHELF_TAG_TEMPLATE_SLUGS = [
  'walmart-esl',
  'walmart-paper',
  'aldi-esl-standard',
  'aldi-esl-price-drop',
  'aldi-esl-numeric-only',
] as const;

export type ShelfTagTemplateSlug = (typeof SHELF_TAG_TEMPLATE_SLUGS)[number];

export type ShelfTagTemplateMatch = {
  slug: ShelfTagTemplateSlug;
  version: number;
  matchConfidence: number;
  runnerUpConfidence: number;
};

// What a matched template contributes on top of the base flat extraction
// (see shelfTag.ts). `null` fields mean "this template doesn't override
// that field" -- the base extraction's value stands.
export type ShelfTagTemplateFields = {
  brand: string | null;
  descriptionOverride: string | null;
  identifierCandidate: { key: string; value: string } | null;
};

const FAC_CAP_FOOTER_PATTERN = /\bFAC\s+\d+\s+CAP\s+\d+/i;
const PRICE_DROP_PATTERN = /PRICE\s+DROPS?/i;
// Exactly six digits, standing alone as its own row -- the shape confirmed
// across all five Aldi samples in deferred.md's second evidence batch.
// Deliberately not a wider range: a looser digit-count match risks picking
// up an unrelated number, which is exactly the false-positive failure mode
// the Walmart footer-fragment incident (deferred.md) already demonstrated.
const ALDI_CODE_ROW_PATTERN = /^\d{6}$/;

function hasAldiCodeRow(rows: Row[]): string | null {
  for (const row of rows) {
    const trimmed = rowText(row).trim();
    if (ALDI_CODE_ROW_PATTERN.test(trimmed)) return trimmed;
  }
  return null;
}

function isAllCaps(text: string): boolean {
  return !/[a-z]/.test(text);
}

// Score in [0, 1]. A template's own doc comment explains what each point
// corresponds to; thresholds are chosen so the five templates are mutually
// exclusive on every sample in the evidence corpus (see shelfTag.test.ts).
function scoreWalmartEsl(text: string): number {
  const footer = FAC_CAP_FOOTER_PATTERN.test(text);
  const fragment = /\bFAC\s+\d+\s+CAP\s+\d+\s+\d{4}\b/i.test(text);
  if (!footer) return 0;
  return fragment ? 1 : 0;
}

function scoreWalmartPaper(text: string): number {
  const footer = FAC_CAP_FOOTER_PATTERN.test(text);
  const fragment = /\bFAC\s+\d+\s+CAP\s+\d+\s+\d{4}\b/i.test(text);
  if (!footer) return 0;
  return fragment ? 0 : 1;
}

function scoreAldiStandard(text: string, rows: Row[], descriptionCandidates: Row[]): number {
  if (FAC_CAP_FOOTER_PATTERN.test(text)) return 0;
  let points = 0;
  const max = 4;
  if (hasAldiCodeRow(rows)) points += 2;
  else return 0;
  if (!PRICE_DROP_PATTERN.test(text)) points += 1;
  if (descriptionCandidates.length >= 1) points += 1;
  return points / max;
}

function scoreAldiPriceDrop(text: string, rows: Row[]): number {
  if (FAC_CAP_FOOTER_PATTERN.test(text)) return 0;
  let points = 0;
  const max = 4;
  if (hasAldiCodeRow(rows)) points += 2;
  else return 0;
  if (PRICE_DROP_PATTERN.test(text)) points += 2;
  return points / max;
}

function scoreAldiNumericOnly(text: string, rows: Row[], descriptionCandidates: Row[]): number {
  if (FAC_CAP_FOOTER_PATTERN.test(text)) return 0;
  let points = 0;
  const max = 4;
  if (hasAldiCodeRow(rows)) points += 2;
  else return 0;
  if (!PRICE_DROP_PATTERN.test(text)) points += 1;
  if (descriptionCandidates.length === 0) points += 1;
  return points / max;
}

// Below this, no template is considered matched: extraction falls through
// to today's flat, retailer-agnostic logic unchanged (ADR 0018's "never
// gate" rule). Scores in the evidence corpus land at 0, 0.75, or 1 -- never
// between 0.5 and 0.75 -- so 0.5 separates "clearly this template" from
// "clearly not," with headroom either side.
const MATCH_THRESHOLD = 0.5;

export function matchShelfTagTemplate(text: string, rows: Row[], descriptionCandidates: Row[]): ShelfTagTemplateMatch | null {
  const scores: { slug: ShelfTagTemplateSlug; score: number }[] = [
    { slug: 'walmart-esl', score: scoreWalmartEsl(text) },
    { slug: 'walmart-paper', score: scoreWalmartPaper(text) },
    { slug: 'aldi-esl-standard', score: scoreAldiStandard(text, rows, descriptionCandidates) },
    { slug: 'aldi-esl-price-drop', score: scoreAldiPriceDrop(text, rows) },
    { slug: 'aldi-esl-numeric-only', score: scoreAldiNumericOnly(text, rows, descriptionCandidates) },
  ];
  scores.sort((a, b) => b.score - a.score);
  const [best, runnerUp] = scores;
  if (best.score < MATCH_THRESHOLD) return null;

  // Every seeded lineage is at version 1 -- see seed_shelf_tag_templates.
  // A future re-seed that supersedes a version would need this hardcoded
  // to move too; there is currently no runtime lookup back to the DB from
  // this pure function (see the module doc comment on why matching stays
  // retailer-agnostic and I/O-free).
  return { slug: best.slug, version: 1, matchConfidence: best.score, runnerUpConfidence: runnerUp.score };
}

// Applies the winning template's field-level overrides on top of the base
// flat extraction. Only aldi-esl-standard currently does a brand/name
// split; every other template either has no brand line (confirmed absent)
// or isn't confident enough about the split to attempt it.
export function applyShelfTagTemplate(
  match: ShelfTagTemplateMatch,
  rows: Row[],
  descriptionCandidates: Row[]
): ShelfTagTemplateFields {
  const fields: ShelfTagTemplateFields = { brand: null, descriptionOverride: null, identifierCandidate: null };

  if (match.slug === 'walmart-esl') {
    const fragmentMatch = /\bFAC\s+\d+\s+CAP\s+\d+\s+(\d{4})\b/i.exec(rows.map((r) => rowText(r)).join(' '));
    if (fragmentMatch) fields.identifierCandidate = { key: 'upc_fragment', value: fragmentMatch[1] };
    return fields;
  }

  if (match.slug === 'walmart-paper') {
    // Deliberately no identifierCandidate: the corn tag's hyphenated
    // 4100-0001-shaped code is real but unconfirmed as the same field as
    // the eink fragment -- see deferred.md's open questions. Extracting it
    // here would be exactly the premature-semantic-assignment mistake
    // already corrected once for Aldi's 6-digit code.
    return fields;
  }

  // All three Aldi templates share the identifier extraction: the
  // standalone 6-digit row, keyed 'unknown' because -- unlike Walmart's
  // confirmed UPC fragment -- nothing has verified what this code actually
  // is yet (a real store SKU is the working guess, not a fact). Rename the
  // key once that's confirmed; see ADR 0018 and deferred.md.
  const code = hasAldiCodeRow(rows);
  if (code) fields.identifierCandidate = { key: 'unknown', value: code };

  if (match.slug === 'aldi-esl-standard' && descriptionCandidates.length === 2) {
    const [first, second] = descriptionCandidates.map((row) => rowText(row).trim());
    if (isAllCaps(first)) {
      fields.brand = first;
      fields.descriptionOverride = second;
    }
  }

  return fields;
}
