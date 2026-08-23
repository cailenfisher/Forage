import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detectPriceColumn,
  findCurrencyElements,
  findPriceElementIndex,
  flattenElements,
  medianElementHeight,
  parsePrice,
  reconstructRows,
  rowMatchesPriceColumn,
} from './rows.ts';
import type { OcrElement, OcrResult } from './types.ts';

function loadFixture(name: string): OcrResult {
  const path = join(import.meta.dirname, '..', '..', '__fixtures__', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

test('flattenElements discards block/line grouping and returns every element', () => {
  const ocrResult = loadFixture('simple-receipt.json');
  assert.equal(flattenElements(ocrResult).length, 15);
});

test('medianElementHeight returns the median of element heights', () => {
  const elements = flattenElements(loadFixture('simple-receipt.json'));
  assert.equal(medianElementHeight(elements), 20);
});

test('medianElementHeight returns 0 for no elements', () => {
  assert.equal(medianElementHeight([]), 0);
});

test('reconstructRows groups the fixture into 8 rows in top-to-bottom order', () => {
  const rows = reconstructRows(loadFixture('simple-receipt.json'));

  assert.equal(rows.length, 8);
  assert.deepEqual(
    rows.map((row) => row.elements.map((element) => element.text)),
    [
      ['TEST', 'MART'],
      ['01/15/2024'],
      ['APPLES', '1.99'],
      ['BREAD', '2.50'],
      ['MILK', '3.25'],
      ['SUBTOTAL', '7.74'],
      ['TAX', '0.50'],
      ['TOTAL', '8.24'],
    ]
  );
});

test('reconstructRows sorts elements within a row left to right', () => {
  const rows = reconstructRows(loadFixture('simple-receipt.json'));
  const appleRow = rows[2];
  assert.equal(appleRow.elements[0].text, 'APPLES');
  assert.equal(appleRow.elements[1].text, '1.99');
});

test('reconstructRows returns a union bounding box per row', () => {
  const rows = reconstructRows(loadFixture('simple-receipt.json'));
  assert.deepEqual(rows[2].box, { x: 10, y: 60, width: 180, height: 20 });
});

test('reconstructRows returns an empty array for no elements', () => {
  assert.deepEqual(reconstructRows({ text: '', blocks: [] }), []);
});

function element(text: string, x: number, y: number, width: number, height = 20): OcrElement {
  return { text, box: { x, y, width, height } };
}

test('findCurrencyElements matches currency-like text and rejects everything else', () => {
  const matching = ['1.99', '$1.99', '0.50', '1,234.56'];
  const nonMatching = ['1lb', 'TOTAL', '1.999', '1.9', 'ABC', '-3.00'];

  for (const text of matching) {
    assert.equal(findCurrencyElements([element(text, 0, 0, 10)]).length, 1, text);
  }
  for (const text of nonMatching) {
    assert.equal(findCurrencyElements([element(text, 0, 0, 10)]).length, 0, text);
  }
});

test('detectPriceColumn returns null when there are no currency elements', () => {
  const elements = [element('TOTAL', 0, 0, 40)];
  assert.equal(detectPriceColumn(elements), null);
});

test('detectPriceColumn finds the right-edge x-position from the fixture', () => {
  const elements = flattenElements(loadFixture('simple-receipt.json'));
  const priceColumn = detectPriceColumn(elements);

  // All 6 price elements in the fixture sit at x:150 width:40, so every
  // right edge is 190.
  assert.equal(priceColumn?.x, 190);
  assert.equal(priceColumn?.elements.length, 6);
});

test('detectPriceColumn picks the dominant cluster over a stray outlier', () => {
  const elements = [
    // A per-unit price sitting mid-row, not right-aligned with the rest.
    element('$1.99', 80, 0, 40),
    // Five real line-item prices, all right-aligned at x+width = 190.
    element('2.50', 150, 30, 40),
    element('3.25', 150, 60, 40),
    element('4.00', 150, 90, 40),
    element('5.10', 150, 120, 40),
    element('6.20', 150, 150, 40),
  ];

  const priceColumn = detectPriceColumn(elements);
  assert.equal(priceColumn?.x, 190);
  assert.equal(priceColumn?.elements.length, 5);
});

test('rowMatchesPriceColumn is true only for rows whose rightmost element sits in the column', () => {
  const rows = reconstructRows(loadFixture('simple-receipt.json'));
  const elements = flattenElements(loadFixture('simple-receipt.json'));
  const priceColumn = detectPriceColumn(elements)!;

  const headerRow = rows[0]; // "TEST MART" — no price
  const appleRow = rows[2]; // "APPLES 1.99" — has a price

  assert.equal(rowMatchesPriceColumn(headerRow, priceColumn), false);
  assert.equal(rowMatchesPriceColumn(appleRow, priceColumn), true);
});

test('parsePrice returns integer cents, never a float dollar amount', () => {
  assert.equal(parsePrice('1.99'), 199);
  assert.equal(parsePrice('0.50'), 50);
  assert.equal(parsePrice('-0.50'), -50);
  assert.equal(parsePrice('$1,234.56'), 123456);
});

test('parsePrice tolerates a trailing single-letter flag merged onto the price ("2.74N")', () => {
  assert.equal(parsePrice('2.74N'), 274);
  assert.equal(parsePrice('17.32F'), 1732);
});

test('parsePrice rejects text with no digits, even with a trailing letter stripped', () => {
  assert.equal(parsePrice('mart.com'), null);
});

test('findPriceElementIndex finds the price when a trailing flag is its own element after it', () => {
  // Real-receipt shape: "BREAD 013764027050 F 6.42 N" — the price (6.42) is
  // second-to-last, not last; "N" sits to its right as a separate element.
  const row = {
    elements: [
      element('BREAD', 10, 0, 150),
      element('013764027050', 170, 0, 370),
      element('F', 550, 0, 25),
      element('6.42', 600, 0, 120, 20),
      element('N', 730, 0, 25, 20),
    ],
    box: { x: 10, y: 0, width: 745, height: 20 },
  };
  const priceColumn = { x: 720, tolerance: 10, elements: [] };

  const index = findPriceElementIndex(row, priceColumn);
  assert.equal(index, 3);
  assert.equal(row.elements[index].text, '6.42');
});

test('findPriceElementIndex ignores a coincidental position match that is not price-shaped text', () => {
  // Real-receipt false positive: unrelated header text ("survey.walmart.com")
  // happens to word-wrap so its last word's right edge lands inside the
  // price column tolerance, but it is not a price.
  const row = {
    elements: [element('survey', 100, 0, 200), element('mart.com', 310, 0, 259)],
    box: { x: 100, y: 0, width: 469, height: 20 },
  };
  const priceColumn = { x: 569, tolerance: 29, elements: [] };

  assert.equal(findPriceElementIndex(row, priceColumn), -1);
  assert.equal(rowMatchesPriceColumn(row, priceColumn), false);
});
