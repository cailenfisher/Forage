import { supabase } from '@/lib/supabase';
import { uploadCaptureImage } from '@/lib/storage';
import { BARCODE_SCAN_VERSION, type BarcodeScanGuess } from '@/ocr/scanBarcode';
import { SHELF_TAG_EXTRACTOR_VERSION, type ShelfTagFooterGuess } from '@/parse/shelfTag';
import type { ShelfTagTemplateMatch } from '@/parse/shelfTagTemplates';
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
  // The "FAC <n> CAP <n> [<fragment>]" footer read off the tag, if any (see
  // ShelfTagFooterGuess) — feeds tag_identifier.tag_format below, never
  // store_item_code.
  tagFooter: ShelfTagFooterGuess | null;
  // ADR 0018's generalized replacement for the old Walmart-only inline
  // upc_fragment special case — whichever footer/identity token the
  // matched template extracted, keyed by what it means ('upc_fragment' for
  // Walmart's confirmed UPC-A tail, 'unknown' for Aldi's 6-digit code).
  // Feeds tag_identifier below, same never-a-lookup-key posture.
  identifierCandidate: { key: string; value: string } | null;
  // Which shelf_tag_template_version (if any) extraction matched against —
  // resolved to a real row id and attached to the observation below so
  // "every observation ever parsed as Walmart ESL" is a join away. Null
  // when nothing matched confidently (ADR 0018's "never gate" rule).
  templateMatch: ShelfTagTemplateMatch | null;
  // Every barcode decoded from the capture photo (see scanBarcode.ts),
  // regardless of type — written verbatim to its own capture_artifact row
  // when non-empty, so raw decode output is retained permanently under ADR
  // 0002 even if only the QR type ends up feeding tag_identifier below.
  barcodeResults: BarcodeScanGuess[];
  // The path segment of a decoded QR payload (see qrPathSegment) — feeds
  // tag_identifier.qr_token below. Passed separately from barcodeResults
  // because extracting "the" QR token from possibly-several decoded
  // barcodes is a UI-layer judgment call, not this function's job.
  qrToken: string | null;
};

// Proposal in docs/decisions/deferred.md ("tag identifier storage"): a
// tag-printed code is real signal for match verification and candidate
// narrowing, but never sufficient for a match on its own, and never a store
// item code (see ADR 0004 and the storeItemCode incident writeup in
// deferred.md — a UPC fragment used as an exact-match key silently
// mis-attaches price_observation rows on any collision). Deliberately
// excludes FAC/CAP/corner-badge/date, which are per-capture facts already
// retained permanently in capture_artifact, not chain-scoped facts that
// belong on retailer_product.
function buildTagIdentifier(
  tagFooter: ShelfTagFooterGuess | null,
  identifierCandidate: { key: string; value: string } | null,
  qrToken: string | null
): Record<string, string> | null {
  const identifier: Record<string, string> = {};
  if (tagFooter) identifier.tag_format = tagFooter.format;
  if (identifierCandidate) identifier[identifierCandidate.key] = identifierCandidate.value;
  if (qrToken) identifier.qr_token = qrToken;
  return Object.keys(identifier).length > 0 ? identifier : null;
}

// ADR 0018: resolve a (slug, version) pair from the pure parser's
// templateMatch into the real shelf_tag_template_version row id, so
// price_observation can carry an exact, replayable reference rather than a
// string the app happens to have chosen this build. Best-effort — a lookup
// miss (e.g. a version this app build doesn't recognize yet) never blocks
// the save; it just means the observation is recorded without a template
// reference, same as any tag that didn't match a template at all.
// Two plain, unambiguous lookups rather than one query with an embedded-
// resource filter — both tables are small, seeded reference data (five rows
// total as of ADR 0018), so the extra round trip costs nothing worth
// avoiding at the price of relying on PostgREST join-filter syntax that
// hasn't been verified against this project's actual behavior.
async function resolveShelfTagTemplateVersionId(match: ShelfTagTemplateMatch | null): Promise<string | null> {
  if (!match) return null;
  const { data: template, error: templateError } = await supabase
    .from('shelf_tag_template')
    .select('id')
    .eq('slug', match.slug)
    .is('deleted_at', null)
    .maybeSingle();
  if (templateError || !template) return null;

  const { data: version, error: versionError } = await supabase
    .from('shelf_tag_template_version')
    .select('id')
    .eq('shelf_tag_template_id', (template as { id: string }).id)
    .eq('version', match.version)
    .is('deleted_at', null)
    .is('superseded_at', null)
    .maybeSingle();
  if (versionError || !version) return null;
  return (version as { id: string }).id;
}

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
    tagFooter,
    identifierCandidate,
    templateMatch,
    barcodeResults,
    qrToken,
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

  // A second, independent artifact row for the barcode scan — same "one row
  // per parser run" model as the OCR artifact above (ADR 0002), not a
  // variant of it: different raw_output shape, different parser_version
  // lineage. Only written when something actually decoded; an empty result
  // isn't worth a permanent row on every single capture. Durable alongside
  // the OCR artifact, ahead of the best-effort block below, because this is
  // raw sensor data, not a resolution outcome.
  if (barcodeResults.length > 0) {
    const { error: barcodeArtifactError } = await supabase.from('capture_artifact').insert({
      capture_id: captureId,
      household_id: householdId,
      raw_output: { barcodes: barcodeResults },
      parser_version: BARCODE_SCAN_VERSION,
      parsed_at: capturedAt.toISOString(),
    });
    if (barcodeArtifactError) throw barcodeArtifactError;
  }

  // Best-effort from here down. If this throws, the capture and its raw
  // artifact above are already safely stored — replay is a supported
  // operation, even though this first pass has no retry UI for it yet.
  try {
    const trimmedCode = storeItemCode?.trim() || null;
    const trimmedDescription = description?.trim() || null;

    const [existing, shelfTagTemplateVersionId] = await Promise.all([
      trimmedCode ? findRetailerProductByStoreItemCode(retailerId, trimmedCode) : Promise.resolve(null),
      resolveShelfTagTemplateVersionId(templateMatch),
    ]);

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
          p_tag_identifier: buildTagIdentifier(tagFooter, identifierCandidate, qrToken),
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
        p_shelf_tag_template_version_id: shelfTagTemplateVersionId,
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
