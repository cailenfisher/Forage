import { scanFromURLAsync, type BarcodeType } from 'expo-camera';

// Bumped whenever the decode/parsing logic in this file changes
// meaningfully (not the expo-camera package version) — same convention as
// SHELF_TAG_EXTRACTOR_VERSION, so a capture_artifact row produced by this
// file can be told apart from one produced by a different version of this
// same logic on replay. See docs/decisions/deferred.md.
export const BARCODE_SCAN_VERSION = '0.1.0';

export type BarcodeScanGuess = {
  type: string;
  data: string;
};

// Decodes barcodes from a static image file (Camera.scanFromURLAsync) — not
// a live camera feed, and not the same engine as the OCR text recognizer in
// recognize.ts. Best-effort: a shelf tag photo with no QR, or one too
// small/blurry to read, is a normal outcome (per docs/decisions/deferred.md,
// decode difficulty for these tags varies sharply and hasn't been verified
// against a real device yet), so failures resolve to an empty array rather
// than throwing and interrupting capture.
export async function scanBarcodes(uri: string, barcodeTypes?: BarcodeType[]): Promise<BarcodeScanGuess[]> {
  try {
    const results = await scanFromURLAsync(uri, barcodeTypes);
    return results.map((result) => ({ type: result.type, data: result.data }));
  } catch {
    return [];
  }
}

// "w-mt.co/q/300ctBZ0VD4J3-ZDQBP" -> "300ctBZ0VD4J3-ZDQBP". The decoded QR
// payload is kept as a path segment only, never the full URL/domain, and
// treated as an opaque per-item token — an earlier hypothesis that part of
// the token encoded the store was killed once a fourth tag was sampled; see
// docs/decisions/deferred.md. Nothing about the token's internal structure
// is assumed here.
export function qrPathSegment(data: string): string | null {
  const trimmed = data.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  const segment = trimmed.split('/').pop();
  return segment && segment.length > 0 ? segment : null;
}
