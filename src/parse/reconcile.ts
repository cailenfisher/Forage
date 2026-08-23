import { parsePrice, rowText } from './rows.ts';
import type { LineItem, ReconciliationDiagnostic, ReconciliationResult, Row } from './types.ts';
import { normalize } from './zones.ts';

function sumLineItems(items: LineItem[]): number {
  return items.reduce((sum, item) => {
    const adjustmentsTotal = item.adjustments.reduce((s, adjustment) => s + adjustment.price, 0);
    return sum + item.price + adjustmentsTotal;
  }, 0);
}

// The footer can contain several anchor rows (SUBTOTAL, TAX, TOTAL, ...);
// reconciliation specifically needs the SUBTOTAL one.
function extractPrintedSubtotal(footer: Row[]): number | null {
  const subtotalRow = footer.find((row) => normalize(rowText(row)).includes('SUBTOTAL'));
  if (!subtotalRow) return null;

  const priceElement = subtotalRow.elements.at(-1);
  return priceElement ? parsePrice(priceElement.text) : null;
}

// If printedSubtotal, shifted a decimal point in either direction, equals
// parsedSum, the receipt's subtotal likely lost a decimal point to thermal
// smear. Returns the factor parsedSum is off by (10 or 0.1, 100 or 0.01).
// All-integer comparison — no rounding needed, unlike the float-dollar
// version this replaced, because integer cents can't accumulate float noise.
function decimalShiftFactor(parsedSum: number, printedSubtotal: number): number | null {
  for (const factor of [10, 100]) {
    if (parsedSum === printedSubtotal * factor) return factor;
    if (printedSubtotal === parsedSum * factor) return 1 / factor;
  }
  return null;
}

function diagnoseMismatch(
  delta: number,
  items: LineItem[],
  parsedSum: number,
  printedSubtotal: number
): ReconciliationDiagnostic[] {
  const diagnostics: ReconciliationDiagnostic[] = [];

  const droppedOrDuplicated = items.find((item) => Math.abs(delta) === item.price);
  if (droppedOrDuplicated) {
    diagnostics.push({ type: 'dropped_or_duplicated_item', item: droppedOrDuplicated });
  }

  const factor = decimalShiftFactor(parsedSum, printedSubtotal);
  if (factor !== null) {
    diagnostics.push({ type: 'decimal_shift', factor });
  }

  return diagnostics;
}

export function reconcile(items: LineItem[], footer: Row[]): ReconciliationResult {
  const parsedSum = sumLineItems(items);
  const printedSubtotal = extractPrintedSubtotal(footer);

  if (printedSubtotal === null) {
    return { parsedSum, printedSubtotal: null, delta: null, status: 'no_subtotal_found', diagnostics: [] };
  }

  const delta = parsedSum - printedSubtotal;
  if (delta === 0) {
    return { parsedSum, printedSubtotal, delta, status: 'match', diagnostics: [] };
  }

  return {
    parsedSum,
    printedSubtotal,
    delta,
    status: 'mismatch',
    diagnostics: diagnoseMismatch(delta, items, parsedSum, printedSubtotal),
  };
}
