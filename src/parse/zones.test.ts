import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectPriceColumn, flattenElements, reconstructRows } from './rows.ts';
import type { OcrResult, Row } from './types.ts';
import { extractHeaderInfo, segmentZones } from './zones.ts';

function loadFixture(name: string): OcrResult {
  const path = join(import.meta.dirname, '..', '..', '__fixtures__', name);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function zonesForFixture() {
  const ocrResult = loadFixture('simple-receipt.json');
  const rows = reconstructRows(ocrResult);
  const priceColumn = detectPriceColumn(flattenElements(ocrResult));
  return segmentZones(rows, priceColumn);
}

function rowTexts(rows: Row[]): string[] {
  return rows.map((row) => row.elements.map((element) => element.text).join(' '));
}

test('segmentZones puts everything before the first priced row in the header', () => {
  const zones = zonesForFixture();
  assert.deepEqual(rowTexts(zones.header), ['TEST MART', '01/15/2024']);
});

test('segmentZones puts priced rows up to the first anchor row in the body', () => {
  const zones = zonesForFixture();
  assert.deepEqual(rowTexts(zones.body), ['APPLES 1.99', 'BREAD 2.50', 'MILK 3.25']);
});

test('segmentZones puts the anchor row onward in the footer', () => {
  const zones = zonesForFixture();
  assert.deepEqual(rowTexts(zones.footer), ['SUBTOTAL 7.74', 'TAX 0.50', 'TOTAL 8.24']);
});

test('segmentZones tolerates "SUB TOTAL" as two words', () => {
  const ocrResult: OcrResult = {
    text: '',
    blocks: [
      {
        text: '',
        box: { x: 0, y: 0, width: 100, height: 40 },
        lines: [
          {
            text: 'APPLES 1.99',
            box: { x: 10, y: 0, width: 100, height: 20 },
            elements: [
              { text: 'APPLES', box: { x: 10, y: 0, width: 60, height: 20 } },
              { text: '1.99', box: { x: 150, y: 0, width: 40, height: 20 } },
            ],
          },
          {
            text: 'SUB TOTAL 1.99',
            box: { x: 10, y: 30, width: 100, height: 20 },
            elements: [
              { text: 'SUB', box: { x: 10, y: 30, width: 40, height: 20 } },
              { text: 'TOTAL', box: { x: 55, y: 30, width: 50, height: 20 } },
              { text: '1.99', box: { x: 150, y: 30, width: 40, height: 20 } },
            ],
          },
        ],
      },
    ],
  };

  const rows = reconstructRows(ocrResult);
  const priceColumn = detectPriceColumn(flattenElements(ocrResult));
  const zones = segmentZones(rows, priceColumn);

  assert.deepEqual(rowTexts(zones.footer), ['SUB TOTAL 1.99']);
});

test('segmentZones does not treat coincidentally-aligned header text as a priced row', () => {
  // Real-receipt false positive: a survey blurb word-wraps such that its
  // last word's right edge happens to land inside the price column
  // tolerance, even though it is not a price. That must not truncate the
  // header down to nothing.
  const ocrResult: OcrResult = {
    text: '',
    blocks: [
      {
        text: '',
        box: { x: 0, y: 0, width: 600, height: 60 },
        lines: [
          {
            text: 'survey mart.com',
            box: { x: 100, y: 0, width: 469, height: 20 },
            elements: [
              { text: 'survey', box: { x: 100, y: 0, width: 200, height: 20 } },
              { text: 'mart.com', box: { x: 310, y: 0, width: 259, height: 20 } },
            ],
          },
          {
            text: 'APPLES 1.99',
            box: { x: 10, y: 30, width: 180, height: 20 },
            elements: [
              { text: 'APPLES', box: { x: 10, y: 30, width: 80, height: 20 } },
              { text: '1.99', box: { x: 529, y: 30, width: 40, height: 20 } },
            ],
          },
        ],
      },
    ],
  };

  const rows = reconstructRows(ocrResult);
  const priceColumn = detectPriceColumn(flattenElements(ocrResult));
  const zones = segmentZones(rows, priceColumn);

  assert.deepEqual(rowTexts(zones.header), ['survey mart.com']);
  assert.deepEqual(rowTexts(zones.body), ['APPLES 1.99']);
});

test('segmentZones treats every row as header when no price column is found', () => {
  const rows = reconstructRows(loadFixture('simple-receipt.json'));
  const zones = segmentZones(rows, null);

  assert.equal(zones.header.length, rows.length);
  assert.equal(zones.body.length, 0);
  assert.equal(zones.footer.length, 0);
});

test('extractHeaderInfo pulls the store name from the first header row and the date from any header row', () => {
  const zones = zonesForFixture();
  const info = extractHeaderInfo(zones.header);

  assert.equal(info.storeName, 'TEST MART');
  assert.equal(info.date, '01/15/2024');
});

test('extractHeaderInfo finds a time when one is present', () => {
  const headerRows: Row[] = [
    {
      elements: [{ text: '10:30', box: { x: 0, y: 0, width: 40, height: 20 } }],
      box: { x: 0, y: 0, width: 40, height: 20 },
    },
  ];

  assert.equal(extractHeaderInfo(headerRows).time, '10:30');
});

test('extractHeaderInfo returns nulls for an empty header', () => {
  assert.deepEqual(extractHeaderInfo([]), { storeName: null, date: null, time: null });
});
