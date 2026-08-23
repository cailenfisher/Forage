// Pure logic, no expo-*/react-native imports — same discipline as
// src/parse/*.ts, so this stays callable from a plain Node test runner
// (scanBarcode.ts wraps this with the actual expo-camera call, which can't
// run outside the app).

// expo-camera's live CameraView reports `type` as a string (e.g. "qr") —
// ExpoCameraView.kt maps it via BarcodeType.mapFormatToString before
// sending it to JS. scanFromURLAsync does NOT do that mapping:
// BarCodeScannerResultSerializer.kt writes `putInt("type", result.type)`,
// the raw ML Kit Barcode.FORMAT_* constant. expo-camera's own .d.ts
// declares `type: string` for both, which is simply wrong for this
// function — confirmed by reading that serializer, and independently by a
// real capture_artifact row that recorded `{"data": "w-mt.co/q/...",
// "type": 256}` (0x0100 is ML Kit's FORMAT_QR_CODE). Comparing that against
// the string "qr" is always false, which is why a QR that plainly decoded
// (it's right there in the raw data) still read as "no QR detected" — the
// scan was never broken; this normalization was missing. Table reverses
// expo-camera's own BarcodeType.mapToBarcode() (CameraRecords.kt).
const ML_KIT_FORMAT_TO_BARCODE_TYPE: Record<number, string> = {
  0x0001: 'code128',
  0x0002: 'code39',
  0x0004: 'code93',
  0x0008: 'codabar',
  0x0010: 'datamatrix',
  0x0020: 'ean13',
  0x0040: 'ean8',
  0x0080: 'itf14',
  0x0100: 'qr',
  0x0200: 'upc_a',
  0x0400: 'upc_e',
  0x0800: 'pdf417',
  0x1000: 'aztec',
};

// Takes `unknown`, not the declared `string` — see the comment above for
// why the declared type can't be trusted here.
export function normalizeBarcodeType(type: unknown): string {
  if (typeof type === 'number') return ML_KIT_FORMAT_TO_BARCODE_TYPE[type] ?? String(type);
  return String(type);
}
