import { isSupported, recognizeText } from 'expo-mlkit-ocr';
import type { RecognitionResult, TextBlock, TextElement, TextLine } from 'expo-mlkit-ocr';

import { BoundingBox, OcrBlock, OcrElement, OcrLine, OcrResult } from '@/parse/types';

function toBox(boundingBox: { x: number; y: number; width: number; height: number }): BoundingBox {
  return {
    x: boundingBox.x,
    y: boundingBox.y,
    width: boundingBox.width,
    height: boundingBox.height,
  };
}

function normalizeElement(element: TextElement): OcrElement {
  return { text: element.text, box: toBox(element.boundingBox) };
}

function normalizeLine(line: TextLine): OcrLine {
  return {
    text: line.text,
    box: toBox(line.boundingBox),
    elements: line.elements.map(normalizeElement),
  };
}

function normalizeBlock(block: TextBlock): OcrBlock {
  return {
    text: block.text,
    box: toBox(block.boundingBox),
    lines: block.lines.map(normalizeLine),
  };
}

// expo-mlkit-ocr's raw result uses `boundingBox`; the rest of this app works
// with the `box` shape defined in parse/types.ts so the parser never has to
// know which OCR library produced its input.
export function normalizeRecognitionResult(result: RecognitionResult): OcrResult {
  return {
    text: result.text,
    blocks: result.blocks.map(normalizeBlock),
  };
}

export function isOcrSupported(): boolean {
  return isSupported();
}

export async function runOcr(uri: string): Promise<OcrResult> {
  const result = await recognizeText(uri);
  return normalizeRecognitionResult(result);
}
