import { rowMatchesPriceColumn, rowText } from './rows.ts';
import type { HeaderInfo, PriceColumn, Row, Zones } from './types.ts';

const ANCHOR_KEYWORDS = ['SUBTOTAL', 'TAX', 'TOTAL', 'BALANCE', 'CHANGE'];

// Uppercased with everything but letters/digits stripped, so "SUB TOTAL",
// "Sub-Total:", and "SUBTOTAL" all normalize to the same "SUBTOTAL" — cheap
// tolerance for the spacing/punctuation noise OCR tends to introduce.
// Exported for reuse by reconcile.ts, which needs to find the specific
// SUBTOTAL row rather than just any anchor row.
export function normalize(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isAnchorRow(row: Row): boolean {
  const normalized = normalize(rowText(row));
  return ANCHOR_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

// Header ends at the first row with a price in the detected price column;
// footer starts at the first anchor row (SUBTOTAL/TAX/TOTAL/BALANCE/CHANGE)
// from that point on. Everything between is the body.
export function segmentZones(rows: Row[], priceColumn: PriceColumn | null): Zones {
  const firstPricedIndex = priceColumn
    ? rows.findIndex((row) => rowMatchesPriceColumn(row, priceColumn))
    : -1;
  const headerEnd = firstPricedIndex === -1 ? rows.length : firstPricedIndex;

  const anchorOffset = rows.slice(headerEnd).findIndex(isAnchorRow);
  const bodyEnd = anchorOffset === -1 ? rows.length : headerEnd + anchorOffset;

  return {
    header: rows.slice(0, headerEnd),
    body: rows.slice(headerEnd, bodyEnd),
    footer: rows.slice(bodyEnd),
  };
}

const DATE_PATTERN = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/;
const TIME_PATTERN = /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM)?\b/i;

// TODO: store name detection is a coin flip across receipt formats — this
// just takes the first header row's text. Good enough for a POC ("do not
// overinvest" per the spec); revisit if it's wrong often enough to matter.
export function extractHeaderInfo(headerRows: Row[]): HeaderInfo {
  let date: string | null = null;
  let time: string | null = null;

  for (const row of headerRows) {
    const text = rowText(row);
    date ??= DATE_PATTERN.exec(text)?.[0] ?? null;
    time ??= TIME_PATTERN.exec(text)?.[0] ?? null;
  }

  const storeName = headerRows.length > 0 ? rowText(headerRows[0]) : null;

  return { storeName, date, time };
}
