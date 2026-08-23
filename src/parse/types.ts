// Shapes that cross the OCR -> parser boundary. This file has no imports from
// expo-* or react-native: the parser (parse/*.ts) must stay a pure function of
// (ocrResult: OcrResult) => ParsedReceipt, callable from a Node test runner.

export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OcrElement = {
  text: string;
  box: BoundingBox;
};

export type OcrLine = {
  text: string;
  box: BoundingBox;
  elements: OcrElement[];
};

export type OcrBlock = {
  text: string;
  box: BoundingBox;
  lines: OcrLine[];
};

export type OcrResult = {
  text: string;
  blocks: OcrBlock[];
};

// A visual row of the receipt, reconstructed from element geometry — not
// from the OCR engine's own line/block grouping (see rows.ts).
export type Row = {
  elements: OcrElement[];
  box: BoundingBox;
};

// The detected right-aligned price column (see rows.ts). `x` is the
// cluster's mean right edge; `tolerance` is how far a row's rightmost
// element may sit from `x` and still count as being in the column.
export type PriceColumn = {
  x: number;
  tolerance: number;
  elements: OcrElement[];
};

// A coupon/discount/deposit row attached to the line item it modifies,
// rather than standing alone as its own item. `price` is integer cents
// (negative for a discount) — see the note on LineItem.price.
export type LineItemAdjustment = {
  description: string;
  price: number;
  row: Row;
};

export type LineItem = {
  description: string;
  // Store SKU/UPC printed inline in the row (e.g. "013764027050"), pulled
  // out of `description` rather than left embedded in it. The canonical
  // item database is keyed on this field — see ADR 0004 — so it has to be a
  // field, not prose to scrape later.
  storeItemCode?: string;
  // Integer cents, never a float dollar amount — money is integer minor
  // units everywhere in this project. Same for `unitPrice` below and for
  // `LineItemAdjustment.price` and `ReconciliationResult`'s sums.
  price: number;
  quantity?: number;
  unit?: string;
  unitPrice?: number;
  taxFlag?: string;
  adjustments: LineItemAdjustment[];
  // Source rows/elements this item was built from, so the debug overlay can
  // highlight exactly what produced it.
  rows: Row[];
  elements: OcrElement[];
};

export type ReconciliationDiagnostic =
  | { type: 'dropped_or_duplicated_item'; item: LineItem }
  | { type: 'decimal_shift'; factor: number };

export type ReconciliationResult = {
  // All three amounts are integer cents.
  parsedSum: number;
  printedSubtotal: number | null;
  delta: number | null;
  status: 'match' | 'mismatch' | 'no_subtotal_found';
  diagnostics: ReconciliationDiagnostic[];
};

export type Zones = {
  header: Row[];
  body: Row[];
  footer: Row[];
};

export type HeaderInfo = {
  storeName: string | null;
  date: string | null;
  time: string | null;
};

export type ParsedReceipt = {
  header: HeaderInfo;
  items: LineItem[];
  reconciliation: ReconciliationResult;
};
