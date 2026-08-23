import { decimalTextToCents, findPriceElementIndex, parsePrice, rowText } from './rows.ts';
import type { LineItem, OcrElement, PriceColumn, Row } from './types.ts';

// "1.23 lb @ $1.99/lb" — optional leading description, quantity, unit,
// literal @, optional currency symbol, unit price, optional trailing /unit.
const WEIGHTED_ITEM_PATTERN =
  /^(.*?)\s*(\d+(?:\.\d+)?)\s*(lb|kg|oz)\.?\s*@\s*\$?(\d+(?:\.\d+)?)\s*\/?\s*(?:lb|kg|oz)?\.?$/i;

// "2 @ 3.49" — optional leading description, quantity, literal @, unit price.
const QUANTITY_MULTIPLIER_PATTERN = /^(.*?)\s*(\d+(?:\.\d+)?)\s*@\s*\$?(\d+(?:\.\d+)?)$/;

type PendingModifier = {
  description: string;
  quantity: number;
  unit?: string;
  unitPrice: number;
};

function matchModifierRow(row: Row): PendingModifier | null {
  const text = rowText(row);

  const weighted = WEIGHTED_ITEM_PATTERN.exec(text);
  if (weighted) {
    return {
      description: weighted[1].trim(),
      quantity: parseFloat(weighted[2]),
      unit: weighted[3].toLowerCase(),
      unitPrice: decimalTextToCents(weighted[4]),
    };
  }

  const multiplier = QUANTITY_MULTIPLIER_PATTERN.exec(text);
  if (multiplier) {
    return {
      description: multiplier[1].trim(),
      quantity: parseFloat(multiplier[2]),
      unitPrice: decimalTextToCents(multiplier[3]),
    };
  }

  return null;
}

// A store SKU/UPC printed inline between the item name and its price/flags
// (e.g. "BREAD 013764027050 F 6.42") — pulled out as its own element rather
// than left inside the free-text description. ADR 0004: the canonical item
// database is keyed on this field, so leaving it embedded in `description`
// would make matching depend on regex-scraping prose instead of reading a
// field. 10–14 digits covers UPC-A/EAN-13/GTIN-14; this is a single-fixture
// heuristic (see docs/decisions/deferred.md) and hasn't been checked against
// a receipt where some other multi-digit number lands in the body zone.
const STORE_ITEM_CODE_PATTERN = /^\d{10,14}$/;

function extractStoreItemCode(elements: OcrElement[]): {
  elements: OcrElement[];
  storeItemCode?: string;
} {
  const codeIndex = elements.findIndex((element) => STORE_ITEM_CODE_PATTERN.test(element.text.trim()));
  if (codeIndex === -1) return { elements };
  return {
    elements: [...elements.slice(0, codeIndex), ...elements.slice(codeIndex + 1)],
    storeItemCode: elements[codeIndex].text.trim(),
  };
}

// A single-character element sitting between the description and the price
// (e.g. "F", "N", "T") is a tax flag, not part of the description.
function splitDescriptionAndTaxFlag(descriptionElements: OcrElement[]): {
  description: string;
  taxFlag?: string;
} {
  const last = descriptionElements.at(-1);
  if (last && last.text.trim().length === 1) {
    return {
      description: descriptionElements
        .slice(0, -1)
        .map((element) => element.text)
        .join(' '),
      taxFlag: last.text.trim(),
    };
  }
  return { description: descriptionElements.map((element) => element.text).join(' ') };
}

// TODO: assumes a weighted/multiplier detail row carries its own leading
// description text (possibly empty) rather than the description living on a
// separate row above it — the spec's example (`1.23 lb @ $1.99/lb`) shows no
// description, so a receipt that prints the item name on its own line above
// the weight detail will come through here with an empty description. Also
// note: unlike the standalone-price branch below, a modifier row's
// description is never checked for an embedded store_item_code — it's
// regex-captured text, not a per-element list, and this path is already a
// known gap for real receipts (see the TODO above).
export function extractLineItems(body: Row[], priceColumn: PriceColumn | null): LineItem[] {
  const items: LineItem[] = [];
  let index = 0;

  while (index < body.length) {
    const row = body[index];

    const modifier = matchModifierRow(row);
    if (modifier) {
      const nextRow = body[index + 1];
      const nextPriceIndex = nextRow && priceColumn ? findPriceElementIndex(nextRow, priceColumn) : -1;
      const nextPrice = nextRow && nextPriceIndex !== -1 ? parsePrice(nextRow.elements[nextPriceIndex].text) : null;

      if (nextPrice !== null) {
        items.push({
          description: modifier.description,
          price: nextPrice,
          quantity: modifier.quantity,
          unit: modifier.unit,
          unitPrice: modifier.unitPrice,
          adjustments: [],
          rows: [row, nextRow],
          elements: [...row.elements, ...nextRow.elements],
        });
        index += 2;
        continue;
      }

      // No priced row followed the modifier row — nothing to attach it to.
      index += 1;
      continue;
    }

    const priceIndex = priceColumn ? findPriceElementIndex(row, priceColumn) : -1;
    if (priceIndex !== -1) {
      const price = parsePrice(row.elements[priceIndex].text);

      if (price !== null && price < 0) {
        const previousItem = items.at(-1);
        if (previousItem) {
          previousItem.adjustments.push({
            description: splitDescriptionAndTaxFlag(row.elements.slice(0, priceIndex)).description,
            price,
            row,
          });
        }
        index += 1;
        continue;
      }

      if (price !== null) {
        const { elements: withoutCode, storeItemCode } = extractStoreItemCode(row.elements.slice(0, priceIndex));
        const { description, taxFlag } = splitDescriptionAndTaxFlag(withoutCode);
        items.push({
          description,
          storeItemCode,
          price,
          taxFlag,
          adjustments: [],
          rows: [row],
          elements: row.elements,
        });
        index += 1;
        continue;
      }
    }

    // No price and no recognized modifier pattern — nothing to do with this
    // row at this stage.
    index += 1;
  }

  return items;
}
