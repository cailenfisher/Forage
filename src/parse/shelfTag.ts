import { findCurrencyElements, flattenElements, parsePrice, reconstructRows, rowText } from './rows.ts';
import { applyShelfTagTemplate, matchShelfTagTemplate, type ShelfTagTemplateMatch } from './shelfTagTemplates.ts';
import type { OcrElement, OcrResult, Row } from './types.ts';

// Bumped whenever extraction logic in this file changes meaningfully. Stored
// on capture_artifact alongside each shelf-tag OCR run, same convention as
// PARSER_VERSION for receipts (see version.ts).
export const SHELF_TAG_EXTRACTOR_VERSION = '0.1.0';

// docs/specs/06-shelf-tag-capture.md explains why this file works from
// ocrResult.text (the flattened string) rather than element geometry for
// everything except the primary price. The receipt parser's "never flatten"
// rule exists to preserve the description-to-price link across *many* line
// items on one receipt; a shelf tag photographs exactly one item, so there
// is no cross-item layout ambiguity for flattening to lose. Geometry (row
// reconstruction, element height) is still used for the one place order
// matters: picking the tag's big printed price out from among any smaller
// currency-shaped text (a unit price, a strikethrough was-price), and
// detecting a dollars+cents pair rendered as two adjacent elements with no
// decimal point between them — both real device tags have shown this file
// getting wrong when it worked from text alone.

const UNIT_ALIASES: Record<string, string> = {
  OZ: 'oz',
  OZS: 'oz',
  OUNCE: 'oz',
  OUNCES: 'oz',
  LB: 'lb',
  LBS: 'lb',
  POUND: 'lb',
  POUNDS: 'lb',
  G: 'g',
  GRAM: 'g',
  GRAMS: 'g',
  KG: 'kg',
  KILOGRAM: 'kg',
  ML: 'ml',
  MILLILITER: 'ml',
  L: 'l',
  LITER: 'l',
  LITRE: 'l',
  'FL OZ': 'fl_oz',
  FLOZ: 'fl_oz',
  GAL: 'gal',
  GALLON: 'gal',
  QT: 'qt',
  QUART: 'qt',
  PT: 'pt',
  PINT: 'pt',
  EA: 'each',
  EACH: 'each',
  CT: 'each',
  COUNT: 'each',
  DZ: 'dozen',
  DOZEN: 'dozen',
  'SQ FT': 'sq_ft',
  SQFT: 'sq_ft',
  FT: 'ft',
  FOOT: 'ft',
  FEET: 'ft',
};

// Maps OCR-printed unit text (any case, with or without punctuation) to a
// unit_of_measure.code — or null if the tag used a word this table doesn't
// know. Never guesses a code for an unrecognized token.
export function normalizeUnitToken(token: string): string | null {
  const key = token
    .trim()
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');
  return UNIT_ALIASES[key] ?? null;
}

export type ShelfTagUnitPriceGuess = {
  // Verbatim as printed (e.g. "$0.25", "25.5", "25.5¢") — never forced
  // through cents-integer parsing, which would either reject perfectly
  // valid tags that print a single decimal digit ("25.5¢/OZ") or fabricate
  // false precision for a cents-denominated amount. Display only.
  displayAmount: string;
  unitToken: string;
  unitCode: string | null;
  // True when unitCode is "each" — the tag is printing the same total price
  // a second time as a "per-unit" annotation (an item priced by the each
  // has no other price to give), not new information. Two of four real
  // tags in the shelf-tag evidence do this; see docs/decisions/deferred.md.
  // The review screen uses this to skip a redundant "tag also shows" hint.
  isDegenerate: boolean;
};

export type ShelfTagFooterFormat = 'eink' | 'paper';

export type ShelfTagFooterGuess = {
  format: ShelfTagFooterFormat;
  facing: number;
  capacity: number;
  // The trailing 4-digit token after "CAP <n>" on an e-ink tag. Confirmed
  // on three independent tag/package pairs to be the tail of the package
  // UPC-A item reference (drop the check digit, take the last four) — see
  // docs/decisions/deferred.md. This is NOT a store item code and must
  // never be treated as one (false positives here are silent
  // price_observation mis-attributions, per ADR 0004 and non-negotiable
  // #3). Null on a paper tag, which prints no such token.
  fragment: string | null;
};

export type ShelfTagSizeGuess = {
  quantity: number;
  unitToken: string;
  unitCode: string | null;
};

export type ShelfTagExtraction = {
  // The large printed price — total price for whatever quantity `size`
  // describes, or the per-unit price itself when the tag has no separate
  // size (e.g. produce priced by the pound). See 06-shelf-tag-capture.md.
  priceCent: number | null;
  // A "$X.XX/UNIT" annotation, if the tag prints one. Informational — the
  // review screen shows it as a hint, it never silently fills a field.
  unitPrice: ShelfTagUnitPriceGuess | null;
  // A standalone "<number> <unit>" package size, distinct from the unit
  // price fraction above.
  size: ShelfTagSizeGuess | null;
  // The "FAC <n> CAP <n> [<fragment>]" footer, when present. Never a store
  // item code (see ShelfTagFooterGuess) — there is currently no known way
  // to extract a real store item code from a Walmart shelf tag, so this
  // project deliberately does not try. The storeItemCode field on the
  // review screen is manual-entry only; see docs/decisions/deferred.md.
  tagFooter: ShelfTagFooterGuess | null;
  // Best-effort guess at the product name, always user-editable, never the
  // value actually written unless the user leaves it as-is.
  descriptionGuess: string | null;
  // ADR 0018. The tag's own dedicated brand line, when a matched template
  // both prints one and confidently separates it from the product name
  // (currently: aldi-esl-standard only). Null everywhere else, including
  // on Walmart tags — brand is confirmed absent from the Walmart ESL
  // template, not merely unextracted (see deferred.md).
  brand: string | null;
  // ADR 0018. A generalized, retailer-agnostic version of "the footer/
  // identity token this template prints, if any" — replaces the old
  // Walmart-only inline upc_fragment special case. `key` names what
  // tag_identifier field it belongs under: 'upc_fragment' for Walmart's
  // confirmed UPC-A tail, 'unknown' for Aldi's 6-digit code (real, but
  // unconfirmed what it represents — see ADR 0018 and deferred.md). Never
  // store_item_code, never a lookup key on its own.
  identifierCandidate: { key: string; value: string } | null;
  // ADR 0018. Which shelf_tag_template_version (if any) scored above
  // threshold for this capture, and its match confidence alongside the
  // runner-up's — null when nothing matched confidently, in which case
  // every field above came from the flat, retailer-agnostic extraction
  // exactly as before this file knew what a "template" was.
  templateMatch: ShelfTagTemplateMatch | null;
};

// A "$" plus 1-4 digits and nothing else — the whole-dollar part of a price
// rendered with the cents as a visually separate (often superscript)
// element, e.g. a digital shelf tag showing "$11" then "87" with no
// decimal point printed anywhere between them. Extremely common on
// e-ink/digital tags; the single-element $X.XX pattern below never matches
// this style at all.
const DOLLARS_ONLY_PATTERN = /^\$(\d{1,4})$/;
const CENTS_ONLY_PATTERN = /^(\d{1,2})$/;

type PriceCandidate = { priceCent: number; height: number };

function extractPrice(elements: OcrElement[], rows: Row[]): number | null {
  const candidates: PriceCandidate[] = [];

  for (const element of findCurrencyElements(elements)) {
    const priceCent = parsePrice(element.text);
    if (priceCent !== null) candidates.push({ priceCent, height: element.box.height });
  }

  // Row-adjacent dollars+cents pair, e.g. ["$11", "87"] -> 1187. Requires
  // the literal "$" on the first element specifically so this can't
  // misfire on two unrelated bare numbers that happen to land in the same
  // OCR row (e.g. a unit-price figure next to an unrelated shelf code).
  for (const row of rows) {
    for (let i = 0; i < row.elements.length - 1; i++) {
      const dollarsMatch = DOLLARS_ONLY_PATTERN.exec(row.elements[i].text.trim());
      const centsMatch = dollarsMatch ? CENTS_ONLY_PATTERN.exec(row.elements[i + 1].text.trim()) : null;
      if (dollarsMatch && centsMatch) {
        const priceCent = parseInt(dollarsMatch[1], 10) * 100 + parseInt(centsMatch[1].padStart(2, '0'), 10);
        const height = Math.max(row.elements[i].box.height, row.elements[i + 1].box.height);
        candidates.push({ priceCent, height });
      }
    }
  }

  if (candidates.length === 0) return null;
  // Largest glyph wins, same reasoning as before: the tag's primary price
  // is reliably the biggest text on it, bigger than a unit-price annotation
  // or a was-price strikethrough.
  return candidates.reduce((tallest, c) => (c.height > tallest.height ? c : tallest)).priceCent;
}

function rowHasSplitPricePair(row: Row): boolean {
  for (let i = 0; i < row.elements.length - 1; i++) {
    if (DOLLARS_ONLY_PATTERN.test(row.elements[i].text.trim()) && CENTS_ONLY_PATTERN.test(row.elements[i + 1].text.trim())) {
      return true;
    }
  }
  return false;
}

// Known 1- or 2-word unit tokens (the UNIT_ALIASES keys), longest first, so
// a two-word unit like "FL OZ" is captured whole. A generic greedy/lazy
// character class can't do this correctly either way: lazy stops at the
// first word ("FL"), confirmed as a real bug against the milk tag's ground
// truth ("PER FL OZ" — see docs/decisions/deferred.md); greedy overreaches
// into trailing unrelated words when the class allows spaces. Falls back to
// a single bare word (no spaces) for a unit the table doesn't recognize, so
// an unrecognized-but-printed unit still surfaces verbatim (unitCode null,
// per non-negotiable #2) instead of being silently dropped.
const KNOWN_UNIT_TOKENS = Object.keys(UNIT_ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((token) => token.replace(/ /g, '\\s+'))
  .join('|');
const UNIT_TOKEN = `(?:${KNOWN_UNIT_TOKENS}|[A-Za-z][A-Za-z.]{0,10})`;

// "$1.99/LB", "25.5¢/OZ", "0.25 per oz" — an amount (dollars or cents,
// one or more decimal digits, symbol optional) immediately followed by a
// unit, standing for "price per that unit". Never parsed into cents: a
// cents-denominated or single-decimal amount ("25.5¢") can't be forced
// through the dollars-and-exactly-two-decimals shape the rest of this
// project's money handling assumes without either rejecting valid data or
// fabricating precision that wasn't printed. Purely a display hint.
const UNIT_PRICE_PATTERN = new RegExp(`(\\$?\\d+(?:\\.\\d+)?¢?)\\s*(?:\\/|per)\\s*(${UNIT_TOKEN})(?=[\\s,;)\\n]|$)`, 'i');

// A trailing "/<unit>" or "per <unit>" with no leading amount — completes a
// unit price whose amount comes from a split dollars+cents row pair
// instead (e.g. ["$3", "67", "PER", "EA"]). Without this, UNIT_PRICE_PATTERN
// run against the flattened text matches the cents element itself as the
// amount ("67 PER EA" -> displayAmount "67"), which is wrong on any tag that
// splits its unit price the same way it splits its main price — confirmed
// on a real device tag. See docs/decisions/deferred.md.
const PER_UNIT_SUFFIX_PATTERN = new RegExp(`^(?:\\/|per)\\s*(${UNIT_TOKEN})(?=[\\s,;)\\n]|$)`, 'i');

function rowSplitUnitPrice(row: Row): ShelfTagUnitPriceGuess | null {
  for (let i = 0; i < row.elements.length - 1; i++) {
    const dollarsMatch = DOLLARS_ONLY_PATTERN.exec(row.elements[i].text.trim());
    const centsMatch = dollarsMatch ? CENTS_ONLY_PATTERN.exec(row.elements[i + 1].text.trim()) : null;
    if (!dollarsMatch || !centsMatch) continue;
    const rest = row.elements
      .slice(i + 2)
      .map((element) => element.text)
      .join(' ')
      .trim();
    const suffixMatch = PER_UNIT_SUFFIX_PATTERN.exec(rest);
    if (!suffixMatch) continue;
    const displayAmount = `$${dollarsMatch[1]}.${centsMatch[1].padStart(2, '0')}`;
    const unitToken = suffixMatch[1].trim();
    const unitCode = normalizeUnitToken(unitToken);
    return { displayAmount, unitToken, unitCode, isDegenerate: unitCode === 'each' };
  }
  return null;
}

function extractUnitPrice(text: string, rows: Row[]): ShelfTagUnitPriceGuess | null {
  // Geometry first: a row-adjacent split pair is a more specific match than
  // the flattened-text pattern below, and must win when both could fire —
  // see PER_UNIT_SUFFIX_PATTERN.
  for (const row of rows) {
    const split = rowSplitUnitPrice(row);
    if (split) return split;
  }

  const match = UNIT_PRICE_PATTERN.exec(text);
  if (!match) return null;
  const unitToken = match[2].trim();
  const unitCode = normalizeUnitToken(unitToken);
  return { displayAmount: match[1].trim(), unitToken, unitCode, isDegenerate: unitCode === 'each' };
}

// "16 OZ", "12 CT", "1.5 LB" — a bare quantity + unit, i.e. the package
// size the tag's total price is for. Searched against the text with the
// unit-price fragment (if any) already removed, so "$0.25/OZ" can't also be
// misread as a "0.25 OZ" size.
const SIZE_PATTERN = /(\d+(?:\.\d+)?)\s*(fl\.?\s?oz|sq\.?\s?ft|oz|lbs?|g|kg|ml|l|gal|qt|pt|ea|each|ct|dz|dozen|ft)\b/i;

// Same shape as SIZE_PATTERN but anchored to the whole (trimmed) row, for
// isNoiseRow: Aldi prints size on its own row, separate from both price and
// unit price (e.g. "0.31 lb" — see deferred.md's second evidence batch),
// unlike Walmart where size is either absent or embedded in a row with
// other content. Without this, a bare size row leaks into
// descriptionCandidateRows and breaks the aldi-esl-standard brand/name
// split, which depends on exactly two candidate rows remaining.
const BARE_SIZE_ROW_PATTERN =
  /^(\d+(?:\.\d+)?)\s*(fl\.?\s?oz|sq\.?\s?ft|oz|lbs?|g|kg|ml|l|gal|qt|pt|ea|each|ct|dz|dozen|ft)$/i;

function extractSize(text: string, unitPrice: ShelfTagUnitPriceGuess | null): ShelfTagSizeGuess | null {
  const withoutUnitPrice = unitPrice ? text.replace(UNIT_PRICE_PATTERN, ' ') : text;
  const match = SIZE_PATTERN.exec(withoutUnitPrice);
  if (!match) return null;
  const quantity = parseFloat(match[1]);
  if (Number.isNaN(quantity)) return null;
  const unitToken = match[2].trim();
  return { quantity, unitToken, unitCode: normalizeUnitToken(unitToken) };
}

// "FAC <n> CAP <n> [<fragment>]" — anchored on the literal facing/capacity
// tokens rather than scanning for digit runs, so a multi-digit capacity
// (e.g. "CAP 1440") can never be confused with the trailing fragment: the
// fragment is whatever four-digit token immediately follows CAP <n>, by
// position, not by being "the longest digit run on the tag" (the previous
// heuristic here, which is exactly what made that confusion possible).
// Confirmed against three real e-ink tags (fragment present) and one real
// paper tag (no fragment — loose bulk produce has no UPC to fragment). See
// docs/decisions/deferred.md. Returns null when the tag has no such footer
// at all, per non-negotiable #2 — never guessed.
const TAG_FOOTER_PATTERN = /\bFAC\s+(\d+)\s+CAP\s+(\d+)(?:\s+(\d{4})\b)?/i;

function extractTagFooter(text: string): ShelfTagFooterGuess | null {
  const match = TAG_FOOTER_PATTERN.exec(text);
  if (!match) return null;
  const fragment = match[3] ?? null;
  return {
    format: fragment ? 'eink' : 'paper',
    facing: parseInt(match[1], 10),
    capacity: parseInt(match[2], 10),
    fragment,
  };
}

function isNoiseRow(row: Row): boolean {
  const trimmed = rowText(row).trim();
  if (trimmed.length === 0) return true;
  if (/^\d+$/.test(trimmed)) return true; // bare item code / UPC row
  if (UNIT_PRICE_PATTERN.test(trimmed)) return true;
  if (BARE_SIZE_ROW_PATTERN.test(trimmed)) return true;
  if (parsePrice(trimmed) !== null) return true;
  if (rowHasSplitPricePair(row)) return true;
  if (TAG_FOOTER_PATTERN.test(trimmed)) return true;
  return false;
}

function letterCount(text: string): number {
  return (text.match(/[A-Za-z]/g) ?? []).length;
}

// Shared with shelfTagTemplates.ts (ADR 0018): the rows left over after
// excluding anything that's obviously a price, unit-price, footer, or bare
// item-code row. Both the flat description guess below and the Aldi
// brand/name-split template logic work from this same candidate set, so a
// row that's noise for one is noise for the other.
function descriptionCandidateRows(rows: Row[]): Row[] {
  return rows.filter((row) => !isNoiseRow(row));
}

// The row with the most letters that isn't obviously a price, unit-price,
// or item-code row — a coarse guess, always shown in an editable field.
function extractDescriptionGuess(candidates: Row[]): string | null {
  const texts = candidates.map((row) => rowText(row));
  if (texts.length === 0) return null;
  return texts.reduce((best, candidate) => (letterCount(candidate) > letterCount(best) ? candidate : best));
}

// Pure function, no I/O — mirrors the receipt parser's (ocrResult) => shape
// contract so replay (re-running extraction over a stored capture_artifact)
// works the same way for shelf tags.
export function extractShelfTagFields(ocrResult: OcrResult): ShelfTagExtraction {
  const elements = flattenElements(ocrResult);
  const rows = reconstructRows(ocrResult);
  const text = ocrResult.text;

  const unitPrice = extractUnitPrice(text, rows);
  const candidates = descriptionCandidateRows(rows);

  // ADR 0018: score the seeded templates on cheap content signals only
  // (retailer isn't known yet at extraction time — see shelfTagTemplates.ts
  // for why matching is retailer-agnostic). Below threshold, templateMatch
  // is null and every field below falls through to the flat extraction
  // exactly as it worked before this file knew what a "template" was —
  // the ADR's "never gate" rule.
  const templateMatch = matchShelfTagTemplate(text, rows, candidates);
  const templateFields = templateMatch ? applyShelfTagTemplate(templateMatch, rows, candidates) : null;

  return {
    priceCent: extractPrice(elements, rows),
    unitPrice,
    size: extractSize(text, unitPrice),
    tagFooter: extractTagFooter(text),
    descriptionGuess: templateFields?.descriptionOverride ?? extractDescriptionGuess(candidates),
    brand: templateFields?.brand ?? null,
    identifierCandidate: templateFields?.identifierCandidate ?? null,
    templateMatch,
  };
}
