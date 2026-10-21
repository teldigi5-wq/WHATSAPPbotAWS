'use strict';

// Image providers are external services: never buffer an unlimited response
// before checking the content type and response size.
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPE = /^image\/(?:png|jpeg|webp|gif|avif)(?:\s*;|$)/i;

async function readBoundedImageResponse(response, maxBytes = MAX_IMAGE_BYTES) {
  if (!response || !response.ok) throw new Error('Image provider request failed');
  const type = response.headers?.get?.('content-type') || '';
  if (!IMAGE_TYPE.test(type)) throw new Error('Image provider returned a non-image response');
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > maxBytes) throw new Error('Image provider output exceeds size limit');
  if (!response.body?.getReader) throw new Error('Image provider returned no readable stream');

  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('Image provider output exceeds size limit');
      parts.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch (_) {}
    reader.releaseLock();
  }
  if (total < 2000) throw new Error('Image provider output is unexpectedly small');
  return Buffer.concat(parts, total);
}

module.exports = { readBoundedImageResponse, MAX_IMAGE_BYTES };
