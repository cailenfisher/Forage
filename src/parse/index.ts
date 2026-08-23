import { extractLineItems } from './lineItems.ts';
import { reconcile } from './reconcile.ts';
import { detectPriceColumn, flattenElements, reconstructRows } from './rows.ts';
import type { OcrResult, ParsedReceipt } from './types.ts';
import { extractHeaderInfo, segmentZones } from './zones.ts';

export * from './types.ts';
export * from './rows.ts';

// The whole parser in one call: (ocrResult) => ParsedReceipt. Pure, no
// React/Expo/native imports anywhere in parse/*.ts — callable from a Node
// test runner with a JSON fixture and no device present.
export function parseReceipt(ocrResult: OcrResult): ParsedReceipt {
  const elements = flattenElements(ocrResult);
  const rows = reconstructRows(ocrResult);
  const priceColumn = detectPriceColumn(elements);
  const zones = segmentZones(rows, priceColumn);
  const items = extractLineItems(zones.body, priceColumn);

  return {
    header: extractHeaderInfo(zones.header),
    items,
    reconciliation: reconcile(items, zones.footer),
  };
}
