import * as Crypto from 'expo-crypto';

import { supabase } from '@/lib/supabase';

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Plain string encode so the bytes never have to cross into a native module as
// an ArrayBuffer — see the comment at the digestStringAsync call below.
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    result += BASE64_CHARS[b0 >> 2];
    result += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    result += b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    result += b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f];
  }
  return result;
}

export type UploadCaptureImageParams = {
  bucket: string;
  householdId: string;
  captureId: string;
  uri: string;
};

export type UploadCaptureImageResult = {
  storageBucket: string;
  storageKey: string;
  byteSize: number;
  contentHash: string;
};

// Shared by every capture type (receipt, shelf tag, ...) — only the bucket
// differs, per docs/specs/01-capture-pipeline.md's "split buckets by capture
// type" rule. Always stores a bucket + key, never a URL.
export async function uploadCaptureImage(params: UploadCaptureImageParams): Promise<UploadCaptureImageResult> {
  const { bucket, householdId, captureId, uri } = params;
  const extension = uri.split('.').pop()?.toLowerCase() || 'jpg';
  const storageKey = `${householdId}/${captureId}.${extension}`;
  const arrayBuffer = await fetch(uri).then((response) => response.arrayBuffer());
  // Crypto.digest() needs a JSI-attached ArrayBuffer to hand to the native Kotlin side.
  // The ArrayBuffer fetch() hands back for a local file:// URI on Android isn't one, and
  // the digest call throws "no ArrayBuffer attached". digestStringAsync only ever crosses
  // the bridge as a plain string, so hash the base64 encoding instead of the raw bytes.
  const contentHash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, bufferToBase64(arrayBuffer));

  const { error } = await supabase.storage
    .from(bucket)
    .upload(storageKey, arrayBuffer, { contentType: extension === 'jpg' ? 'image/jpeg' : `image/${extension}` });
  if (error) throw error;

  return { storageBucket: bucket, storageKey, byteSize: arrayBuffer.byteLength, contentHash };
}
