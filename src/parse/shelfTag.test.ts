import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractShelfTagFields, normalizeUnitToken } from './shelfTag.ts';
import type { OcrElement, OcrResult } from './types.ts';

// Synthetic fixtures, not real device output. As of 2026-08-23 there are
// zero real on-device shelf-tag OCR fixtures — the one that existed
// (tai-pei-shelf-tag.json) was pulled from an internet screenshot, not a
// physical tag photographed in-store, and has been removed; its ML Kit
// geometry was genuine device output but the subject wasn't a real capture,
// so it didn't meet the project's "test against real device output" bar
// either. Twelve real tags across three retailers have ground truth
// recorded in docs/decisions/deferred.md and docs/specs/06-shelf-tag-capture.md
// pending device re-capture — see that ground truth before adding fixtures
// here so expected values aren't reverse-engineered from parser output.
// These synthetic tests exercise extraction logic in isolation and do not
// stand in for that bar.
function element(text: string, x: number, y: number, width = text.length * 10, height = 20): OcrElement {
  return { text, box: { x, y, width, height } };
}

function ocrResult(elements: OcrElement[]): OcrResult {
  return {
    text: elements.map((e) => e.text).join(' '),
    blocks: [
      {
        text: elements.map((e) => e.text).join(' '),
        box: { x: 0, y: 0, width: 0, height: 0 },
        lines: elements.map((e) => ({ text: e.text, box: e.box, elements: [e] })),
      },
    ],
  };
}

test('extractShelfTagFields picks the tallest currency element as the price', () => {
  const result = ocrResult([
    element('GREAT VALUE MILK', 0, 0, 160, 20),
    element('$3.99', 0, 30, 60, 48), // large printed price
    element('$0.25/OZ', 0, 90, 80, 16), // small unit-price annotation
  ]);

  const extraction = extractShelfTagFields(result);
  assert.equal(extraction.priceCent, 399);
});

test('extractShelfTagFields reads a dollars+cents pair split across two adjacent elements with no decimal point', () => {
  // The common digital-shelf-tag rendering: "$11" then "87" as two separate
  // OCR elements, no "." between them anywhere.
  const result = ocrResult([element('$11', 0, 0, 60, 100), element('87', 65, 0, 40, 90)]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.priceCent, 1187);
});

test('extractShelfTagFields prefers the taller of a split price pair vs. a single-element price', () => {
  const result = ocrResult([
    element('$1.99', 0, 0, 60, 16), // small, single-element
    element('$11', 0, 30, 60, 100), // large, split pair
    element('87', 65, 30, 40, 90),
  ]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.priceCent, 1187);
});

test('extractShelfTagFields does not treat two unrelated bare numbers as a split price pair', () => {
  // No "$" on the first element -> not a dollars+cents pair.
  const result = ocrResult([element('12', 0, 0), element('34', 20, 0)]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.priceCent, null);
});

test('extractShelfTagFields reads a unit-price annotation verbatim, including a single decimal digit', () => {
  const result = ocrResult([element('$0.25/OZ', 0, 0)]);
  const extraction = extractShelfTagFields(result);

  assert.deepEqual(extraction.unitPrice, {
    displayAmount: '$0.25',
    unitToken: 'OZ',
    unitCode: 'oz',
    isDegenerate: false,
  });
});

test('extractShelfTagFields reads a two-token unit ("PER FL OZ") in the flattened unit-price annotation', () => {
  // Ground-truth milk tag shape (docs/decisions/deferred.md): unit price
  // prints as its own element followed by "PER" and "FL OZ" as separate
  // OCR elements, unlike the split dollars+cents case below.
  const result = ocrResult([element('4.5¢', 0, 0), element('PER', 40, 0), element('FL OZ', 70, 0)]);
  const extraction = extractShelfTagFields(result);

  assert.deepEqual(extraction.unitPrice, {
    displayAmount: '4.5¢',
    unitToken: 'FL OZ',
    unitCode: 'fl_oz',
    isDegenerate: false,
  });
});

test('extractShelfTagFields reads a unit price whose amount is split across a dollars+cents row pair, not the cents alone', () => {
  // Ground-truth celery tag shape: the unit price prints as "$3.67 PER EA"
  // but "$3" and "67" render as separate OCR elements with no decimal point
  // between them, same style as the main price. A flattened-text-only match
  // would grab "67" (the cents element) as the amount and miss the dollars
  // entirely — this is the real bug the row-based match below fixes.
  const result = ocrResult([
    element('$3', 0, 0, 40, 20),
    element('67', 45, 0, 30, 20),
    element('PER', 80, 0, 30, 20),
    element('EA', 115, 0, 25, 20),
  ]);
  const extraction = extractShelfTagFields(result);

  assert.deepEqual(extraction.unitPrice, {
    displayAmount: '$3.67',
    unitToken: 'EA',
    unitCode: 'each',
    isDegenerate: true,
  });
});

test('extractShelfTagFields does not let a split unit-price row also register as a package size', () => {
  const result = ocrResult([
    element('$3', 0, 0, 40, 20),
    element('67', 45, 0, 30, 20),
    element('PER', 80, 0, 30, 20),
    element('EA', 115, 0, 25, 20),
  ]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.size, null);
});

test('extractShelfTagFields reads a bare "<qty> <unit>" as the package size, distinct from the unit price', () => {
  const result = ocrResult([element('16 OZ', 0, 0), element('$3.99', 0, 30), element('$0.25/OZ', 0, 60)]);
  const extraction = extractShelfTagFields(result);

  assert.deepEqual(extraction.size, { quantity: 16, unitToken: 'OZ', unitCode: 'oz' });
});

test('extractShelfTagFields does not mistake the unit-price fraction for a size', () => {
  // No standalone "16 OZ" anywhere — only the per-unit annotation.
  const result = ocrResult([element('$0.25/OZ', 0, 0)]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.size, null);
});

test('extractShelfTagFields reads an e-ink tag footer as facing/capacity/fragment, not a store item code', () => {
  // Ground-truth ramen tag footer (docs/decisions/deferred.md): "FAC 4 CAP
  // 136 0212". Confirmed against the package UPC-A on three independent
  // tag/package pairs — the fragment is the UPC's last four digits with the
  // check digit dropped.
  const result = ocrResult([element('FAC 4 CAP 136 0212', 0, 0)]);
  const extraction = extractShelfTagFields(result);

  assert.deepEqual(extraction.tagFooter, { format: 'eink', facing: 4, capacity: 136, fragment: '0212' });
});

test('extractShelfTagFields reads a paper tag footer with no trailing fragment (bulk produce has no UPC to fragment)', () => {
  const result = ocrResult([element('FAC 12 CAP 288', 0, 0)]);
  const extraction = extractShelfTagFields(result);

  assert.deepEqual(extraction.tagFooter, { format: 'paper', facing: 12, capacity: 288, fragment: null });
});

test('extractShelfTagFields does not mistake a 4-digit capacity for the footer fragment', () => {
  // A capacity that happens to be 4 digits (e.g. "CAP 1440") with nothing
  // printed after it must not be read as a fragment — the previous
  // longest-digit-run heuristic could not tell these apart; the FAC/CAP
  // anchor can, because it takes the fragment by position, not by length.
  const result = ocrResult([element('FAC 4 CAP 1440', 0, 0)]);
  const extraction = extractShelfTagFields(result);

  assert.deepEqual(extraction.tagFooter, { format: 'paper', facing: 4, capacity: 1440, fragment: null });
});

test('extractShelfTagFields leaves tagFooter null when the tag has no FAC/CAP footer at all', () => {
  const result = ocrResult([element('GREAT VALUE MILK', 0, 0), element('$3.99', 0, 30)]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.tagFooter, null);
});

test('extractShelfTagFields guesses the description from the row with the most letters, skipping price/code/unit-price rows', () => {
  const result = ocrResult([
    element('071314540123', 0, 0),
    element('GREAT VALUE WHOLE MILK GALLON', 0, 30),
    element('$3.99', 0, 60),
    element('$0.25/OZ', 0, 90),
  ]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.descriptionGuess, 'GREAT VALUE WHOLE MILK GALLON');
});

test('extractShelfTagFields excludes a split dollars+cents price row from the description guess', () => {
  const result = ocrResult([element('GREAT VALUE MILK', 0, 0), element('$11', 0, 30), element('87', 30, 30)]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.descriptionGuess, 'GREAT VALUE MILK');
});

test('extractShelfTagFields returns all-null fields for an empty capture rather than fabricating any', () => {
  const extraction = extractShelfTagFields(ocrResult([]));

  assert.deepEqual(extraction, {
    priceCent: null,
    unitPrice: null,
    size: null,
    tagFooter: null,
    descriptionGuess: null,
    brand: null,
    identifierCandidate: null,
    templateMatch: null,
  });
});

// ADR 0018 — template matching. Ground truth for these shapes is the
// second evidence batch in docs/decisions/deferred.md.

test('extractShelfTagFields matches walmart-esl and surfaces the UPC fragment as a generalized identifier candidate', () => {
  // Ramen tag footer, ground truth in deferred.md.
  const result = ocrResult([element('RAMEN BEEF', 0, 0), element('FAC 4 CAP 136 0212', 0, 30)]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.templateMatch?.slug, 'walmart-esl');
  assert.deepEqual(extraction.identifierCandidate, { key: 'upc_fragment', value: '0212' });
});

test('extractShelfTagFields matches walmart-paper and does not guess an identifier candidate from the corn tag', () => {
  // Corn paper tag footer, no trailing fragment — ground truth in deferred.md.
  const result = ocrResult([element('CORN BULK HM', 0, 0), element('FAC 12 CAP 288', 0, 30)]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.templateMatch?.slug, 'walmart-paper');
  // The corn tag's own 4100-0001-shaped code is a different, unconfirmed
  // field — see deferred.md's open questions — so this stays null rather
  // than guessing it's the same thing as the eink fragment.
  assert.equal(extraction.identifierCandidate, null);
});

test('extractShelfTagFields matches aldi-esl-standard, splits brand from name, and routes the 6-digit code to identifierCandidate.unknown', () => {
  // Tuna tag ground truth (deferred.md): brand line, name line, footer row.
  const result = ocrResult([
    element('NORTHERN CATCH', 0, 0),
    element('Chunk Tuna in Oil', 0, 30),
    element('0.31 lb', 0, 60),
    element('$3.20 per lb', 0, 90),
    element('201552', 0, 120),
    element('$0.99', 0, 150, 60, 40),
  ]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.templateMatch?.slug, 'aldi-esl-standard');
  assert.equal(extraction.brand, 'NORTHERN CATCH');
  assert.equal(extraction.descriptionGuess, 'Chunk Tuna in Oil');
  assert.deepEqual(extraction.identifierCandidate, { key: 'unknown', value: '201552' });
});

test('extractShelfTagFields matches aldi-esl-price-drop from the PRICE DROPS badge text and does not split a brand', () => {
  // Strawberries tag ground truth (deferred.md): no brand line (open
  // question whether that's the price-drop template or commodity produce —
  // either way, this template must not fabricate a brand split).
  const result = ocrResult([
    element('PRICE DROPS', 0, 0),
    element('Strawberries', 0, 30),
    element('1.00 lb', 0, 60),
    element('$1.89 per lb', 0, 90),
    element('356646', 0, 120),
    element('$1.89', 0, 150, 60, 40),
  ]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.templateMatch?.slug, 'aldi-esl-price-drop');
  assert.equal(extraction.brand, null);
  assert.deepEqual(extraction.identifierCandidate, { key: 'unknown', value: '356646' });
});

test('extractShelfTagFields matches aldi-esl-numeric-only when nothing but price and footer are printed', () => {
  // Milk tag ground truth (deferred.md): no brand, no description, no
  // currency symbol on the price — everything else is on the display card,
  // not the ESL itself.
  const result = ocrResult([element('1.00 gal', 0, 0), element('$5.25 per gal', 0, 30), element('416943', 0, 60), element('5.25', 0, 90, 60, 40)]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.templateMatch?.slug, 'aldi-esl-numeric-only');
  assert.equal(extraction.descriptionGuess, null);
  assert.equal(extraction.brand, null);
  assert.deepEqual(extraction.identifierCandidate, { key: 'unknown', value: '416943' });
});

test('extractShelfTagFields does not match any template on an unrelated tag, and every field still comes from flat extraction', () => {
  const result = ocrResult([element('GREAT VALUE MILK', 0, 0), element('$3.99', 0, 30)]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.templateMatch, null);
  assert.equal(extraction.brand, null);
  assert.equal(extraction.identifierCandidate, null);
  assert.equal(extraction.descriptionGuess, 'GREAT VALUE MILK');
});

test('normalizeUnitToken maps known tokens case- and punctuation-insensitively', () => {
  assert.equal(normalizeUnitToken('oz'), 'oz');
  assert.equal(normalizeUnitToken('LBS'), 'lb');
  assert.equal(normalizeUnitToken('fl. oz'), 'fl_oz');
  assert.equal(normalizeUnitToken('EACH'), 'each');
});

test('normalizeUnitToken returns null for an unrecognized unit rather than guessing', () => {
  assert.equal(normalizeUnitToken('SLEEVE'), null);
});
