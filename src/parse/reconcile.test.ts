import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractLineItems } from './lineItems.ts';
import { reconcile } from './reconcile.ts';
import { detectPriceColumn, flattenElements, reconstructRows } from './rows.ts';
import type { LineItem, OcrResult, Row } from './types.ts';
import { segmentZones } from './zones.ts';

function loadFixture(name: string): OcrResult {
  const path = join(import.meta.dirname, '..', '..', '__fixtures__', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function reconcileFixture(name: string) {
  const ocrResult = loadFixture(name);
  const rows = reconstructRows(ocrResult);
  const priceColumn = detectPriceColumn(flattenElements(ocrResult));
  const zones = segmentZones(rows, priceColumn);
  const items = extractLineItems(zones.body, priceColumn);
  return reconcile(items, zones.footer);
}

// `price` here is integer cents, matching the parser's contract.
function lineItem(description: string, price: number): LineItem {
  return { description, price, adjustments: [], rows: [], elements: [] };
}

function footerWithRow(keyword: string, price: number): Row[] {
  return [
    {
      elements: [
        { text: keyword, box: { x: 10, y: 0, width: 90, height: 20 } },
        { text: price.toFixed(2), box: { x: 150, y: 0, width: 40, height: 20 } },
      ],
      box: { x: 10, y: 0, width: 180, height: 20 },
    },
  ];
}

test('reconcile returns match when the parsed sum equals the printed subtotal', () => {
  const result = reconcileFixture('simple-receipt.json');
  assert.equal(result.status, 'match');
  assert.equal(result.parsedSum, 774);
  assert.equal(result.printedSubtotal, 774);
  assert.equal(result.delta, 0);
  assert.deepEqual(result.diagnostics, []);
});

test('reconcile folds adjustments (coupons) into the parsed sum', () => {
  const result = reconcileFixture('receipt-with-modifiers.json');
  assert.equal(result.status, 'match');
  assert.equal(result.parsedSum, 1613);
});

test('reconcile returns no_subtotal_found when the footer has no SUBTOTAL row', () => {
  const result = reconcile([lineItem('WIDGET', 500)], []);
  assert.equal(result.status, 'no_subtotal_found');
  assert.equal(result.printedSubtotal, null);
  assert.equal(result.delta, null);
});

test('reconcile does not treat a TOTAL row as the subtotal', () => {
  const result = reconcile([lineItem('WIDGET', 500)], footerWithRow('TOTAL', 8.24));
  assert.equal(result.status, 'no_subtotal_found');
});

test('reconcile flags a dropped-or-duplicated item when the delta matches one item price', () => {
  const items = [lineItem('APPLES', 199), lineItem('BREAD', 250)];
  // parsedSum = 449, printed = 250, delta = 199 — exactly APPLES's price.
  const result = reconcile(items, footerWithRow('SUBTOTAL', 2.5));

  assert.equal(result.status, 'mismatch');
  assert.equal(result.delta, 199);
  assert.equal(result.diagnostics.length, 1);
  const [diagnostic] = result.diagnostics;
  assert.equal(diagnostic.type, 'dropped_or_duplicated_item');
  assert.equal(diagnostic.type === 'dropped_or_duplicated_item' && diagnostic.item.description, 'APPLES');
});

test('reconcile flags a decimal shift when the subtotal is off by a factor of 10', () => {
  const items = [lineItem('WIDGET', 1730)];
  const result = reconcile(items, footerWithRow('SUBTOTAL', 1.73));

  assert.equal(result.status, 'mismatch');
  assert.equal(result.diagnostics.length, 1);
  const [diagnostic] = result.diagnostics;
  assert.equal(diagnostic.type, 'decimal_shift');
  assert.equal(diagnostic.type === 'decimal_shift' && diagnostic.factor, 10);
});

test('reconcile flags a decimal shift when the subtotal is off by a factor of 100', () => {
  const items = [lineItem('WIDGET', 17300)];
  const result = reconcile(items, footerWithRow('SUBTOTAL', 1.73));

  assert.equal(result.status, 'mismatch');
  const [diagnostic] = result.diagnostics;
  assert.equal(diagnostic.type, 'decimal_shift');
  assert.equal(diagnostic.type === 'decimal_shift' && diagnostic.factor, 100);
});

test('reconcile reports the delta plainly when no diagnostic pattern matches', () => {
  const items = [lineItem('WIDGET', 1000)];
  const result = reconcile(items, footerWithRow('SUBTOTAL', 9));

  assert.equal(result.status, 'mismatch');
  assert.equal(result.delta, 100);
  assert.deepEqual(result.diagnostics, []);
});
