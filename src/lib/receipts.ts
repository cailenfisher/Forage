import { supabase } from '@/lib/supabase';
import { uploadCaptureImage } from '@/lib/storage';
import type { HeaderInfo, LineItem, ParsedReceipt, ReconciliationResult } from '@/parse';
import { PARSER_VERSION } from '@/parse/version';

import type { OcrResult } from '@/parse/types';

async function getUnitOfMeasureIds(codes: string[]): Promise<Record<string, string>> {
  const uniqueCodes = [...new Set(codes)];
  if (uniqueCodes.length === 0) return {};

  const { data, error } = await supabase.from('unit_of_measure').select('id, code').in('code', uniqueCodes);
  if (error) throw error;

  return Object.fromEntries((data ?? []).map((row) => [row.code as string, row.id as string]));
}

function tripReconciliationStatus(status: ReconciliationResult['status']): 'balanced' | 'discrepancy' | 'pending' {
  if (status === 'match') return 'balanced';
  if (status === 'mismatch') return 'discrepancy';
  return 'pending';
}

// "3:45 PM", "3:45:00 PM", "15:45" — whatever shape zones.ts's TIME_PATTERN
// captured out of the header.
const TIME_PATTERN = /^(\d{1,2}):(\d{2})(?::\d{2})?\s?(AM|PM)?$/i;

// Best-effort local reconstruction of the printed date/time. Falls back to
// the capture time rather than guessing at a date that isn't there — the
// device doing the scanning is virtually always in the store's own timezone,
// so this skips a real tz conversion rather than fabricating one from a
// store row that only has a name, not a proven location.
function derivePurchasedAt(header: HeaderInfo, capturedAt: Date): string {
  if (!header.date) return capturedAt.toISOString();

  const dateParts = header.date.split(/[/-]/).map((part) => parseInt(part, 10));
  if (dateParts.length !== 3 || dateParts.some((part) => Number.isNaN(part))) {
    return capturedAt.toISOString();
  }

  const [month, day, yearRaw] = dateParts;
  const year = yearRaw < 100 ? yearRaw + 2000 : yearRaw;

  let hours = 12;
  let minutes = 0;
  const timeMatch = header.time ? TIME_PATTERN.exec(header.time.trim()) : null;
  if (timeMatch) {
    hours = parseInt(timeMatch[1], 10);
    minutes = parseInt(timeMatch[2], 10);
    const meridiem = timeMatch[3]?.toUpperCase();
    if (meridiem === 'PM' && hours < 12) hours += 12;
    if (meridiem === 'AM' && hours === 12) hours = 0;
  }

  const purchasedAt = new Date(year, month - 1, day, hours, minutes);
  return Number.isNaN(purchasedAt.getTime()) ? capturedAt.toISOString() : purchasedAt.toISOString();
}

// shopping_trip_line_item has no adjustments table of its own — coupons and
// discounts are netted into the extended price here. The individual
// adjustment rows aren't lost: they're still in the raw OCR JSON permanently
// via capture_artifact, just not queryable as their own rows yet. Exported so
// the review screen can display the exact number that will be persisted,
// rather than a second copy of this arithmetic that could drift from it.
export function lineItemExtendedPriceCent(item: LineItem): number {
  const adjustmentsTotal = item.adjustments.reduce((sum, adjustment) => sum + adjustment.price, 0);
  return item.price + adjustmentsTotal;
}

export type SaveReceiptTripParams = {
  householdId: string;
  userId: string;
  storeId: string;
  imageUri: string;
  ocrResult: OcrResult;
  parsed: ParsedReceipt;
};

export type SaveReceiptTripResult = {
  tripId: string;
  itemCount: number;
};

export async function saveReceiptTrip(params: SaveReceiptTripParams): Promise<SaveReceiptTripResult> {
  const { householdId, userId, storeId, imageUri, ocrResult, parsed } = params;
  const capturedAt = new Date();

  // Durable capture record first. Everything from here through
  // capture_artifact must land before we touch trip/line-item tables — the
  // raw OCR output is persisted permanently regardless of whether trip
  // creation below succeeds (see docs/specs/01-capture-pipeline.md).
  const { data: capture, error: captureError } = await supabase
    .from('capture')
    .insert({
      household_id: householdId,
      created_by_user_account_id: userId,
      store_id: storeId,
      capture_type: 'receipt',
      processing_status: 'processing',
      captured_at: capturedAt.toISOString(),
    })
    .select('id')
    .single();
  if (captureError || !capture) throw captureError ?? new Error('Failed to create capture');
  const captureId = capture.id as string;

  const { storageBucket, storageKey, byteSize, contentHash } = await uploadCaptureImage({
    bucket: 'receipt-images',
    householdId,
    captureId,
    uri: imageUri,
  });

  const { error: imageError } = await supabase.from('capture_image').insert({
    capture_id: captureId,
    household_id: householdId,
    storage_bucket: storageBucket,
    storage_key: storageKey,
    content_hash: contentHash,
    byte_size: byteSize,
    variant: 'original',
    sequence: 0,
  });
  if (imageError) throw imageError;

  const { error: artifactError } = await supabase.from('capture_artifact').insert({
    capture_id: captureId,
    household_id: householdId,
    raw_output: ocrResult,
    parser_version: PARSER_VERSION,
    parsed_at: capturedAt.toISOString(),
  });
  if (artifactError) throw artifactError;

  // Best-effort from here down. If this throws, the capture and its raw
  // artifact above are already safely stored — replay is a supported
  // operation, even though this first pass has no retry UI for it yet.
  try {
    const unitCodes = parsed.items
      .map((item) => item.unit)
      .filter((unit): unit is string => Boolean(unit));
    const unitIds = await getUnitOfMeasureIds(unitCodes);

    const { data: trip, error: tripError } = await supabase
      .from('shopping_trip')
      .insert({
        household_id: householdId,
        store_id: storeId,
        capture_id: captureId,
        purchased_at: derivePurchasedAt(parsed.header, capturedAt),
        subtotal_cent: parsed.reconciliation.printedSubtotal,
        reconciliation_status: tripReconciliationStatus(parsed.reconciliation.status),
        needs_review: parsed.reconciliation.status !== 'match',
      })
      .select('id')
      .single();
    if (tripError || !trip) throw tripError ?? new Error('Failed to create shopping trip');
    const tripId = trip.id as string;

    if (parsed.items.length > 0) {
      const lineItemRows = parsed.items.map((item, index) => ({
        household_id: householdId,
        shopping_trip_id: tripId,
        printed_text: item.description || null,
        sequence: index,
        quantity: item.unit ? null : (item.quantity ?? null),
        weight: item.unit ? (item.quantity ?? null) : null,
        unit_of_measure_id: item.unit ? (unitIds[item.unit] ?? null) : null,
        unit_price_cent: item.unitPrice ?? null,
        extended_price_cent: lineItemExtendedPriceCent(item),
      }));

      const { error: lineItemError } = await supabase.from('shopping_trip_line_item').insert(lineItemRows);
      if (lineItemError) throw lineItemError;
    }

    await supabase.from('capture').update({ processing_status: 'parsed' }).eq('id', captureId);

    return { tripId, itemCount: parsed.items.length };
  } catch (err) {
    await supabase.from('capture').update({ processing_status: 'failed' }).eq('id', captureId);
    throw err;
  }
}
