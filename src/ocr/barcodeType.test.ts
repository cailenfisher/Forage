import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeBarcodeType } from './barcodeType.ts';

test('normalizeBarcodeType maps the raw ML Kit QR format constant to "qr"', () => {
  // The exact value pulled from a real capture_artifact row:
  // {"data": "w-mt.co/q/300ctBZ0VD4J3-ZDQBP", "type": 256} — this is
  // scanFromURLAsync's actual runtime shape on Android, not the string its
  // own .d.ts claims. This test is the regression guard for that mismatch.
  assert.equal(normalizeBarcodeType(256), 'qr');
});

test('normalizeBarcodeType maps every other known ML Kit format constant', () => {
  assert.equal(normalizeBarcodeType(0x0001), 'code128');
  assert.equal(normalizeBarcodeType(0x0002), 'code39');
  assert.equal(normalizeBarcodeType(0x0004), 'code93');
  assert.equal(normalizeBarcodeType(0x0008), 'codabar');
  assert.equal(normalizeBarcodeType(0x0010), 'datamatrix');
  assert.equal(normalizeBarcodeType(0x0020), 'ean13');
  assert.equal(normalizeBarcodeType(0x0040), 'ean8');
  assert.equal(normalizeBarcodeType(0x0080), 'itf14');
  assert.equal(normalizeBarcodeType(0x0200), 'upc_a');
  assert.equal(normalizeBarcodeType(0x0400), 'upc_e');
  assert.equal(normalizeBarcodeType(0x0800), 'pdf417');
  assert.equal(normalizeBarcodeType(0x1000), 'aztec');
});

test('normalizeBarcodeType passes an already-string type through unchanged', () => {
  // The live CameraView path (ExpoCameraView.kt) does its own int->string
  // mapping before this ever runs, so a genuine string must not be
  // stringified again or mangled.
  assert.equal(normalizeBarcodeType('qr'), 'qr');
});

test('normalizeBarcodeType falls back to String() for an unrecognized numeric format rather than guessing a name', () => {
  assert.equal(normalizeBarcodeType(999999), '999999');
});
