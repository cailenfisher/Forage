import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractLineItems } from './lineItems.ts';
import { detectPriceColumn, flattenElements, reconstructRows } from './rows.ts';
import type { OcrResult, PriceColumn, Row } from './types.ts';
import { segmentZones } from './zones.ts';

function loadFixture(name: string): OcrResult {
  const path = join(import.meta.dirname, '..', '..', '__fixtures__', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function lineItemsForFixture() {
  const ocrResult = loadFixture('receipt-with-modifiers.json');
  const rows = reconstructRows(ocrResult);
  const priceColumn = detectPriceColumn(flattenElements(ocrResult));
  const zones = segmentZones(rows, priceColumn);
  return extractLineItems(zones.body, priceColumn);
}

test('extractLineItems produces one item per priced row plus one per modifier pair', () => {
  const items = lineItemsForFixture();
  assert.equal(items.length, 5);
  assert.deepEqual(
    items.map((item) => item.description),
    ['APPLES', 'BREAD', '', '', 'MILK']
  );
  assert.deepEqual(
    items.map((item) => item.price),
    [199, 250, 191, 698, 325]
  );
});

test('extractLineItems collapses a weighted item into one line item', () => {
  const weighted = lineItemsForFixture()[2];
  assert.equal(weighted.quantity, 0.96);
  assert.equal(weighted.unit, 'lb');
  assert.equal(weighted.unitPrice, 199);
  assert.equal(weighted.price, 191);
  assert.equal(weighted.rows.length, 2);
});

test('extractLineItems collapses a quantity multiplier into one line item', () => {
  const multiplier = lineItemsForFixture()[3];
  assert.equal(multiplier.quantity, 2);
  assert.equal(multiplier.unit, undefined);
  assert.equal(multiplier.unitPrice, 349);
  assert.equal(multiplier.price, 698);
  assert.equal(multiplier.rows.length, 2);
});

test('extractLineItems strips a single-character tax flag from the description', () => {
  const bread = lineItemsForFixture()[1];
  assert.equal(bread.description, 'BREAD');
  assert.equal(bread.taxFlag, 'F');
});

test('extractLineItems attaches a negative row as an adjustment to the preceding item', () => {
  const bread = lineItemsForFixture()[1];
  assert.equal(bread.adjustments.length, 1);
  assert.equal(bread.adjustments[0].description, 'COUPON');
  assert.equal(bread.adjustments[0].price, -50);
});

test('extractLineItems does not emit a standalone item for a negative row', () => {
  const items = lineItemsForFixture();
  assert.ok(items.every((item) => item.price >= 0));
});

test('extractLineItems returns items that reference their source rows and elements', () => {
  const apples = lineItemsForFixture()[0];
  assert.equal(apples.rows.length, 1);
  assert.equal(apples.elements.length, 2);
});

test('extractLineItems drops a negative row that has no preceding item', () => {
  const negativeRow: Row = {
    elements: [{ text: '-0.50', box: { x: 150, y: 0, width: 40, height: 20 } }],
    box: { x: 150, y: 0, width: 40, height: 20 },
  };
  const priceColumn: PriceColumn = { x: 190, tolerance: 10, elements: [] };

  assert.deepEqual(extractLineItems([negativeRow], priceColumn), []);
});

test('extractLineItems drops a modifier row with no following priced row', () => {
  const modifierRow: Row = {
    elements: [
      { text: '2', box: { x: 10, y: 0, width: 15, height: 20 } },
      { text: '@', box: { x: 30, y: 0, width: 15, height: 20 } },
      { text: '3.49', box: { x: 50, y: 0, width: 40, height: 20 } },
    ],
    box: { x: 10, y: 0, width: 80, height: 20 },
  };

  assert.deepEqual(extractLineItems([modifierRow], null), []);
});

test('extractLineItems returns an empty array for an empty body', () => {
  assert.deepEqual(extractLineItems([], null), []);
});

test('extractLineItems finds the price when a trailing flag sits after it as its own element, and pulls out the store item code', () => {
  // Real-receipt shape: "BREAD 013764027050 F 6.42 N" — a leading store item
  // code, a leading tax flag (F) before the price, and a trailing flag (N)
  // after it. Proves the price is found correctly (not mistaking "N" for
  // it) and that the 12-digit code is extracted rather than left glued to
  // the description (ADR 0004 — the canonical item database is keyed on it).
  const row: Row = {
    elements: [
      { text: 'BREAD', box: { x: 10, y: 0, width: 150, height: 20 } },
      { text: '013764027050', box: { x: 170, y: 0, width: 370, height: 20 } },
      { text: 'F', box: { x: 550, y: 0, width: 25, height: 20 } },
      { text: '6.42', box: { x: 600, y: 0, width: 120, height: 20 } },
      { text: 'N', box: { x: 730, y: 0, width: 25, height: 20 } },
    ],
    box: { x: 10, y: 0, width: 745, height: 20 },
  };
  const priceColumn: PriceColumn = { x: 720, tolerance: 10, elements: [] };

  const items = extractLineItems([row], priceColumn);
  assert.equal(items.length, 1);
  assert.equal(items[0].price, 642);
  assert.equal(items[0].taxFlag, 'F');
  assert.equal(items[0].storeItemCode, '013764027050');
  assert.equal(items[0].description, 'BREAD');
});
