import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseReceipt } from './index.ts';
import type { OcrResult } from './types.ts';

function loadFixture(name: string): OcrResult {
  const path = join(import.meta.dirname, '..', '..', '__fixtures__', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

test('parseReceipt runs the full pipeline end to end on a simple receipt', () => {
  const receipt = parseReceipt(loadFixture('simple-receipt.json'));

  assert.equal(receipt.header.storeName, 'TEST MART');
  assert.equal(receipt.header.date, '01/15/2024');
  assert.equal(receipt.items.length, 3);
  assert.equal(receipt.reconciliation.status, 'match');
});

test('parseReceipt handles modifiers (weighted items, multipliers, adjustments, tax flags)', () => {
  const receipt = parseReceipt(loadFixture('receipt-with-modifiers.json'));

  assert.equal(receipt.items.length, 5);
  assert.equal(receipt.items[1].taxFlag, 'F');
  assert.equal(receipt.items[1].adjustments.length, 1);
  assert.equal(receipt.reconciliation.status, 'match');
});

test('parseReceipt returns no_subtotal_found for an OCR result with no rows at all', () => {
  const receipt = parseReceipt({ text: '', blocks: [] });

  assert.deepEqual(receipt.items, []);
  assert.equal(receipt.reconciliation.status, 'no_subtotal_found');
});

test('parseReceipt on a real captured Walmart receipt finds the subtotal and the parseable items', () => {
  // Real device capture with messy real-world formatting: barcodes between
  // description and price, and tax flags that sometimes trail the price as
  // their own element. Two of five items (a weighted item, and one where
  // OCR merged "2.74" and "N" into a single token) aren't recovered — known,
  // documented gaps, not this test's job to fix. This test exists to lock
  // in the 3 that do work (now including the extracted store item code) and
  // catch regressions on the trailing-flag fix. Prices are integer cents.
  const receipt = parseReceipt(loadFixture('real-walmart-receipt.json'));

  assert.equal(receipt.reconciliation.printedSubtotal, 1732);
  assert.deepEqual(
    receipt.items.map((item) => [item.description, item.storeItemCode, item.price, item.taxFlag]),
    [
      ['BREAD', '013764027050', 642, 'F'],
      ['GV NS SW 8Z', '078742127430', 167, 'F'],
      ['GV RST BEEF', '078742040970', 478, 'F'],
    ]
  );
  assert.equal(receipt.reconciliation.parsedSum, 1287);
  assert.equal(receipt.reconciliation.status, 'mismatch');
});
