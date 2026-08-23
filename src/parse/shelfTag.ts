import { findCurrencyElements, flattenElements, parsePrice, reconstructRows, rowText } from './rows.ts';
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
  // Digit run pulled from its own OCR element — same heuristic and same
  // caveats as the receipt parser's store_item_code extraction (see
  // docs/decisions/deferred.md): untested against a tag where an unrelated
  // multi-digit number would produce a false positive.
  storeItemCode: string | null;
  // Best-effort guess at the product name, always user-editable, never the
  // value actually written unless the user leaves it as-is.
  descriptionGuess: string | null;
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

// "$1.99/LB", "25.5¢/OZ", "0.25 per oz" — an amount (dollars or cents,
// one or more decimal digits, symbol optional) immediately followed by a
// unit, standing for "price per that unit". Never parsed into cents: a
// cents-denominated or single-decimal amount ("25.5¢") can't be forced
// through the dollars-and-exactly-two-decimals shape the rest of this
// project's money handling assumes without either rejecting valid data or
// fabricating precision that wasn't printed. Purely a display hint.
const UNIT_PRICE_PATTERN = /(\$?\d+(?:\.\d+)?¢?)\s*(?:\/|per)\s*([A-Za-z][A-Za-z. ]{0,10}?)(?=[\s,;)\n]|$)/i;

function extractUnitPrice(text: string): ShelfTagUnitPriceGuess | null {
  const match = UNIT_PRICE_PATTERN.exec(text);
  if (!match) return null;
  const unitToken = match[2].trim();
  return { displayAmount: match[1].trim(), unitToken, unitCode: normalizeUnitToken(unitToken) };
}

// "16 OZ", "12 CT", "1.5 LB" — a bare quantity + unit, i.e. the package
// size the tag's total price is for. Searched against the text with the
// unit-price fragment (if any) already removed, so "$0.25/OZ" can't also be
// misread as a "0.25 OZ" size.
const SIZE_PATTERN = /(\d+(?:\.\d+)?)\s*(fl\.?\s?oz|sq\.?\s?ft|oz|lbs?|g|kg|ml|l|gal|qt|pt|ea|each|ct|dz|dozen|ft)\b/i;

function extractSize(text: string, unitPrice: ShelfTagUnitPriceGuess | null): ShelfTagSizeGuess | null {
  const withoutUnitPrice = unitPrice ? text.replace(UNIT_PRICE_PATTERN, ' ') : text;
  const match = SIZE_PATTERN.exec(withoutUnitPrice);
  if (!match) return null;
  const quantity = parseFloat(match[1]);
  if (Number.isNaN(quantity)) return null;
  const unitToken = match[2].trim();
  return { quantity, unitToken, unitCode: normalizeUnitToken(unitToken) };
}

// A standalone digit run of plausible UPC/EAN/PLU length, sitting in its
// own OCR element rather than embedded in surrounding text. Longest match
// wins on the assumption a full UPC/EAN outranks a shorter PLU or a stray
// number — an assumption, not a certainty; see the module doc comment.
function extractStoreItemCode(elements: OcrElement[]): string | null {
  const candidates = elements
    .map((element) => element.text.trim())
    .filter((text) => /^\d{4,14}$/.test(text));
  if (candidates.length === 0) return null;
  return candidates.reduce((longest, candidate) => (candidate.length > longest.length ? candidate : longest));
}

function isNoiseRow(row: Row): boolean {
  const trimmed = rowText(row).trim();
  if (trimmed.length === 0) return true;
  if (/^\d+$/.test(trimmed)) return true; // bare item code / UPC row
  if (UNIT_PRICE_PATTERN.test(trimmed)) return true;
  if (parsePrice(trimmed) !== null) return true;
  if (rowHasSplitPricePair(row)) return true;
  return false;
}

function letterCount(text: string): number {
  return (text.match(/[A-Za-z]/g) ?? []).length;
}

// The row with the most letters that isn't obviously a price, unit-price,
// or item-code row — a coarse guess, always shown in an editable field.
function extractDescriptionGuess(rows: Row[]): string | null {
  const candidates = rows.filter((row) => !isNoiseRow(row)).map((row) => rowText(row));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) => (letterCount(candidate) > letterCount(best) ? candidate : best));
}

// Pure function, no I/O — mirrors the receipt parser's (ocrResult) => shape
// contract so replay (re-running extraction over a stored capture_artifact)
// works the same way for shelf tags.
export function extractShelfTagFields(ocrResult: OcrResult): ShelfTagExtraction {
  const elements = flattenElements(ocrResult);
  const rows = reconstructRows(ocrResult);
  const text = ocrResult.text;

  const unitPrice = extractUnitPrice(text);

  return {
    priceCent: extractPrice(elements, rows),
    unitPrice,
    size: extractSize(text, unitPrice),
    storeItemCode: extractStoreItemCode(elements),
    descriptionGuess: extractDescriptionGuess(rows),
  };
}
