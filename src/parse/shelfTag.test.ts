import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractShelfTagFields, normalizeUnitToken } from './shelfTag.ts';
import type { OcrElement, OcrResult } from './types.ts';

function loadFixture(name: string): OcrResult {
  const path = join(import.meta.dirname, '..', '..', '__fixtures__', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// Synthetic fixtures, not real device output, used for the tests below that
// don't load a fixture file. There is only one real on-device shelf tag
// fixture so far (tai-pei-shelf-tag.json, pulled from an actual failed
// capture — see the test at the bottom); these exercise extraction logic
// in isolation and do not stand in for the "test against real device
// output" bar the rest of the project holds itself to.
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

  assert.deepEqual(extraction.unitPrice, { displayAmount: '$0.25', unitToken: 'OZ', unitCode: 'oz' });
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

test('extractShelfTagFields extracts a store item code from its own digit-only element, preferring the longest', () => {
  const result = ocrResult([element('12345', 0, 0), element('071314540123', 0, 30)]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.storeItemCode, '071314540123');
});

test('extractShelfTagFields leaves storeItemCode null when no digit-only element is present', () => {
  const result = ocrResult([element('GREAT VALUE MILK', 0, 0), element('$3.99', 0, 30)]);
  const extraction = extractShelfTagFields(result);

  assert.equal(extraction.storeItemCode, null);
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
    storeItemCode: null,
    descriptionGuess: null,
  });
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

// Real on-device OCR output (ML Kit, Pixel 7), pulled from capture
// 01a02f72-a4e1-74c6-abca-9bb2d3850790 after it failed to save. The tag
// itself prints "$11 87" as its total price and "25.5¢ PER OZ" as its unit
// price (see docs/decisions/deferred.md), but ML Kit never recognized the
// "$11" text at all — only the "87" (cents) and "25.5" (unit price number)
// came through. This fixture documents that as an honest, known gap: no
// regex can recover text the OCR engine never produced, and the correct
// behavior is to leave priceCent null so the review screen's price field
// stays a normal editable input rather than showing a wrong or fabricated
// number.
test('extractShelfTagFields on a real device fixture: honestly reports the price as unrecoverable when OCR drops the whole-dollar text', () => {
  const extraction = extractShelfTagFields(loadFixture('tai-pei-shelf-tag.json'));

  assert.equal(extraction.priceCent, null);
  assert.deepEqual(extraction.unitPrice, { displayAmount: '25.5', unitToken: 'OZ', unitCode: 'oz' });
  // The trailing "7" is a small shelf-facing marker printed to the right of
  // the title, unrelated to the product name — row reconstruction merges it
  // in because its bounding box vertically overlaps the title row's band by
  // more than the median-height threshold. A real quirk, not a test bug;
  // descriptionGuess is a prefill the user edits, not a written value.
  assert.equal(extraction.descriptionGuess, 'TAI PEI CHKN POTSTKR 7');
  // Known false-positive, not a regression: "3010" is a shelf-facing code
  // from "FAC 1 CAP 6 3010", not an item code, but it's the only standalone
  // 4-14 digit element on the tag and the heuristic can't tell the
  // difference. Flagged in deferred.md rather than papered over here.
  assert.equal(extraction.storeItemCode, '3010');
});
