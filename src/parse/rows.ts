import type { BoundingBox, OcrElement, OcrResult, PriceColumn, Row } from './types.ts';

// The OCR engine's own block/line grouping is not trustworthy for row
// layout (a "line" can span multiple printed rows, or a row can be split
// across blocks). Row reconstruction below works from element geometry
// only, so flattening throws that grouping away.
export function flattenElements(ocrResult: OcrResult): OcrElement[] {
  return ocrResult.blocks.flatMap((block) => block.lines.flatMap((line) => line.elements));
}

export function medianElementHeight(elements: OcrElement[]): number {
  if (elements.length === 0) return 0;
  const heights = [...elements.map((element) => element.box.height)].sort((a, b) => a - b);
  const mid = Math.floor(heights.length / 2);
  return heights.length % 2 === 0 ? (heights[mid - 1] + heights[mid]) / 2 : heights[mid];
}

function yCenter(box: BoundingBox): number {
  return box.y + box.height / 2;
}

function verticalOverlap(a: BoundingBox, b: BoundingBox): number {
  const overlapTop = Math.max(a.y, b.y);
  const overlapBottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, overlapBottom - overlapTop);
}

function unionBox(elements: OcrElement[]): BoundingBox {
  const left = Math.min(...elements.map((element) => element.box.x));
  const top = Math.min(...elements.map((element) => element.box.y));
  const right = Math.max(...elements.map((element) => element.box.x + element.box.width));
  const bottom = Math.max(...elements.map((element) => element.box.y + element.box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function reconstructRows(ocrResult: OcrResult): Row[] {
  const elements = flattenElements(ocrResult);
  if (elements.length === 0) return [];

  const overlapThreshold = medianElementHeight(elements) * 0.5;
  const sorted = [...elements].sort((a, b) => yCenter(a.box) - yCenter(b.box));

  // Greedy sweep: an element joins the row currently being built if it
  // overlaps that row's running union box by more than the threshold —
  // checking against the row's full extent (not just the last element
  // added) so a row doesn't drift as it accumulates members.
  const rowGroups: OcrElement[][] = [];
  for (const element of sorted) {
    const currentRow = rowGroups.at(-1);
    if (currentRow && verticalOverlap(unionBox(currentRow), element.box) > overlapThreshold) {
      currentRow.push(element);
    } else {
      rowGroups.push([element]);
    }
  }

  return rowGroups.map((rowElements) => {
    const sortedByX = [...rowElements].sort((a, b) => a.box.x - b.box.x);
    return { elements: sortedByX, box: unionBox(sortedByX) };
  });
}

// Optional currency symbol, digits (with optional thousands separators),
// a decimal point, and exactly two trailing digits.
const CURRENCY_PATTERN = /^\$?\d[\d,]*\.\d{2}$/;

export function findCurrencyElements(elements: OcrElement[]): OcrElement[] {
  return elements.filter((element) => CURRENCY_PATTERN.test(element.text.trim()));
}

function rightEdge(element: OcrElement): number {
  return element.box.x + element.box.width;
}

export function detectPriceColumn(elements: OcrElement[]): PriceColumn | null {
  const currencyElements = findCurrencyElements(elements);
  if (currencyElements.length === 0) return null;

  const tolerance = medianElementHeight(elements) * 0.5;
  const sorted = [...currencyElements].sort((a, b) => rightEdge(a) - rightEdge(b));

  // Same greedy-sweep technique as row grouping, clustering right edges
  // instead of vertical spans: an element joins the current cluster if its
  // right edge falls within `tolerance` of that cluster's running mean.
  const clusters: OcrElement[][] = [];
  for (const element of sorted) {
    const currentCluster = clusters.at(-1);
    const clusterMean = currentCluster
      ? currentCluster.reduce((sum, e) => sum + rightEdge(e), 0) / currentCluster.length
      : null;
    if (currentCluster && clusterMean !== null && Math.abs(rightEdge(element) - clusterMean) <= tolerance) {
      currentCluster.push(element);
    } else {
      clusters.push([element]);
    }
  }

  // Receipts right-align prices, so the price column is the largest
  // cluster, not just any cluster — a stray currency-shaped element off to
  // one side (e.g. a per-unit price like "$1.99/lb" earlier in the row)
  // should lose to the tight cluster of actual line-item prices.
  const dominantCluster = clusters.reduce((largest, cluster) =>
    cluster.length > largest.length ? cluster : largest
  );

  const x = dominantCluster.reduce((sum, element) => sum + rightEdge(element), 0) / dominantCluster.length;

  return { x, tolerance, elements: dominantCluster };
}

// Scans a row from the right (prices are right-aligned) for the first
// element that both sits in the price column AND parses as a price. Not
// necessarily the row's last element: a trailing annotation like a
// single-character tax flag can be its own element to the right of the
// actual price (e.g. "BREAD 013764027050 F 6.42 N"). Requiring the text to
// also parse as a price (not just the position to match) guards against a
// coincidental alignment — e.g. unrelated header text that happens to wrap
// so its last word's right edge lands near the price column.
export function findPriceElementIndex(row: Row, priceColumn: PriceColumn): number {
  for (let i = row.elements.length - 1; i >= 0; i--) {
    const element = row.elements[i];
    const inColumn = Math.abs(rightEdge(element) - priceColumn.x) <= priceColumn.tolerance;
    if (inColumn && parsePrice(element.text) !== null) {
      return i;
    }
  }
  return -1;
}

export function rowMatchesPriceColumn(row: Row, priceColumn: PriceColumn): boolean {
  return findPriceElementIndex(row, priceColumn) !== -1;
}

export function rowText(row: Row): string {
  return row.elements.map((element) => element.text).join(' ');
}

// Optional leading minus (for discounts/coupons), optional currency symbol,
// digits, decimal point, exactly two trailing digits.
const PRICE_PATTERN = /^-?\$?\d[\d,]*\.\d{2}$/;

// Converts an already-validated "-$1,234.56"-shaped string into integer
// cents by reading the whole and fractional parts directly, rather than
// `parseFloat(text) * 100` — money is integer minor units everywhere in
// this project, and going through a float intermediate is exactly the kind
// of silent precision loss that rule exists to rule out.
function toSignedCents(priceText: string): number {
  const sign = priceText.startsWith('-') ? -1 : 1;
  const [wholePart, centsPart] = priceText.replace(/[-$,]/g, '').split('.');
  return sign * (parseInt(wholePart, 10) * 100 + parseInt(centsPart, 10));
}

// Same conversion, but for a bare decimal string with no sign and no
// currency symbol (e.g. a per-unit price captured out of "$1.99/lb") and
// tolerant of a fractional part that isn't exactly two digits. A third
// fractional digit, if one ever shows up, is truncated rather than
// rounded — real receipts print unit prices to the cent.
export function decimalTextToCents(decimalText: string): number {
  const [wholePart, fractionPart = ''] = decimalText.split('.');
  const cents = (fractionPart + '00').slice(0, 2);
  return parseInt(wholePart || '0', 10) * 100 + parseInt(cents, 10);
}

export function parsePrice(text: string): number | null {
  const trimmed = text.trim();
  if (PRICE_PATTERN.test(trimmed)) {
    return toSignedCents(trimmed);
  }

  // Tolerate a trailing single-letter flag OCR sometimes merges onto the
  // price with no space (e.g. "2.74N" for a $2.74 item flagged N).
  const withoutTrailingLetter = trimmed.replace(/[A-Za-z]$/, '');
  if (withoutTrailingLetter !== trimmed && PRICE_PATTERN.test(withoutTrailingLetter)) {
    return toSignedCents(withoutTrailingLetter);
  }

  return null;
}
