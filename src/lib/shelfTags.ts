import { supabase } from '@/lib/supabase';
import { uploadCaptureImage } from '@/lib/storage';
import { SHELF_TAG_EXTRACTOR_VERSION } from '@/parse/shelfTag';
import type { OcrResult } from '@/parse/types';

export type UnitOfMeasureOption = {
  id: string;
  code: string;
  label: string;
};

export async function listUnitsOfMeasure(): Promise<UnitOfMeasureOption[]> {
  const { data, error } = await supabase
    .from('unit_of_measure')
    .select('id, code, label')
    .order('label', { ascending: true });
  if (error) throw error;
  return (data ?? []) as UnitOfMeasureOption[];
}

// Retailer-scoped, exact match — store_item_code is only unique per
// retailer (ADR 0004), so a code has to be looked up alongside a retailer,
// never on its own.
export async function findRetailerProductByStoreItemCode(
  retailerId: string,
  storeItemCode: string
): Promise<{ id: string; receiptDescription: string | null } | null> {
  const { data, error } = await supabase
    .from('retailer_product')
    .select('id, receipt_description')
    .eq('retailer_id', retailerId)
    .eq('store_item_code', storeItemCode)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? { id: data.id as string, receiptDescription: data.receipt_description as string | null } : null;
}

export type SaveShelfTagObservationParams = {
  householdId: string;
  userId: string;
  storeId: string;
  retailerId: string;
  imageUri: string;
  ocrResult: OcrResult;
  description: string | null;
  storeItemCode: string | null;
  priceCent: number;
  priceKind: 'regular' | 'sale' | 'clearance';
  sizeQuantity: number | null;
  unitOfMeasureId: string | null;
};

export type SaveShelfTagObservationResult = {
  captureId: string;
  priceObservationId: string;
  retailerProductId: string;
  matchedExistingRetailerProduct: boolean;
};

export async function saveShelfTagObservation(
  params: SaveShelfTagObservationParams
): Promise<SaveShelfTagObservationResult> {
  const {
    householdId,
    userId,
    storeId,
    retailerId,
    imageUri,
    ocrResult,
    description,
    storeItemCode,
    priceCent,
    priceKind,
    sizeQuantity,
    unitOfMeasureId,
  } = params;
  const capturedAt = new Date();

  // Durable capture record first, same ordering as the receipt flow: capture
  // -> image -> artifact must all land before anything downstream is
  // attempted, because the raw OCR output is persisted permanently
  // regardless of whether resolution/observation below succeeds.
  const { data: capture, error: captureError } = await supabase
    .from('capture')
    .insert({
      household_id: householdId,
      created_by_user_account_id: userId,
      store_id: storeId,
      capture_type: 'shelf_tag',
      processing_status: 'processing',
      captured_at: capturedAt.toISOString(),
    })
    .select('id')
    .single();
  if (captureError || !capture) throw captureError ?? new Error('Failed to create capture');
  const captureId = capture.id as string;

  const { storageBucket, storageKey, byteSize, contentHash } = await uploadCaptureImage({
    bucket: 'shelf-tag-images',
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
    parser_version: SHELF_TAG_EXTRACTOR_VERSION,
    parsed_at: capturedAt.toISOString(),
  });
  if (artifactError) throw artifactError;

  // Best-effort from here down. If this throws, the capture and its raw
  // artifact above are already safely stored — replay is a supported
  // operation, even though this first pass has no retry UI for it yet.
  try {
    const trimmedCode = storeItemCode?.trim() || null;
    const trimmedDescription = description?.trim() || null;

    const existing = trimmedCode ? await findRetailerProductByStoreItemCode(retailerId, trimmedCode) : null;

    let retailerProductId: string;
    let matchedExistingRetailerProduct: boolean;

    if (existing) {
      retailerProductId = existing.id;
      matchedExistingRetailerProduct = true;
    } else {
      const { data: retailerProduct, error: retailerProductError } = await supabase
        .rpc('create_provisional_retailer_product', {
          p_retailer_id: retailerId,
          p_store_item_code: trimmedCode,
          p_product_id: null,
          p_receipt_description: trimmedDescription,
          p_department: null,
        })
        .single();
      if (retailerProductError || !retailerProduct) {
        throw retailerProductError ?? new Error('Failed to create retailer product');
      }
      retailerProductId = (retailerProduct as { id: string }).id;
      matchedExistingRetailerProduct = false;

      // The printed text on the tag is worth recording as an alias even
      // though the retailer_product row above already carries it as
      // receipt_description — the alias table is what future matching
      // reads from. Only done on the create path: matching an existing
      // retailer_product already means this phrasing (or one close enough
      // to have hit the store_item_code) is not new information.
      if (trimmedDescription) {
        const { error: aliasError } = await supabase.rpc('create_provisional_product_alias', {
          p_retailer_product_id: retailerProductId,
          p_printed_text: trimmedDescription,
          p_confidence: null,
        });
        if (aliasError) throw aliasError;
      }
    }

    const { data: observation, error: observationError } = await supabase
      .rpc('record_price_observation', {
        p_retailer_product_id: retailerProductId,
        p_store_id: storeId,
        p_observation_source: 'shelf_tag',
        p_price_cent: priceCent,
        p_observed_at: capturedAt.toISOString(),
        p_size_quantity: sizeQuantity,
        p_unit_of_measure_id: unitOfMeasureId,
        p_price_kind: priceKind,
        p_field_confidence: {},
        p_capture_id: captureId,
      })
      .single();
    if (observationError || !observation) throw observationError ?? new Error('Failed to record price observation');

    await supabase.from('capture').update({ processing_status: 'parsed' }).eq('id', captureId);

    return {
      captureId,
      priceObservationId: (observation as { id: string }).id,
      retailerProductId,
      matchedExistingRetailerProduct,
    };
  } catch (err) {
    await supabase.from('capture').update({ processing_status: 'failed' }).eq('id', captureId);
    throw err;
  }
}
