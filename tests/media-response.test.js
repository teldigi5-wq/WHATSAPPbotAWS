'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readBoundedImageResponse, MAX_IMAGE_BYTES } = require('../security/media-response');

const payload = bytes => new Uint8Array(bytes).fill(42);
const res = (data, type='image/png', headers={}) => new Response(data, {
  status: 200,
  headers: { 'content-type': type, ...headers }
});

test('accepts a normal image payload', async () => {
  const result = await readBoundedImageResponse(res(payload(2100)));
  assert.equal(result.length, 2100);
  assert.equal(result[0], 42);
});

test('rejects declared oversized provider responses before reading image body', async () => {
  await assert.rejects(
    readBoundedImageResponse(res(payload(2100),'image/png',{'content-length':String(MAX_IMAGE_BYTES+1)})),
    /size limit/
  );
});

test('rejects streamed oversized response without unbounded allocation', async () => {
  let received = 0;
  const data = new ReadableStream({
    pull(controller) {
      controller.enqueue(payload(1024 * 1024));
      received++;
    }
  });
  await assert.rejects(readBoundedImageResponse(res(data,'image/webp')), /size limit/);
  assert.ok(received < 30, 'stream should stop when the byte budget is exceeded');
});

test('rejects HTML, SVG, and tiny non-image fallback responses', async () => {
  for (const type of ['text/html', 'image/svg+xml']) {
    await assert.rejects(readBoundedImageResponse(res(payload(2200),type)), /non-image/);
  }
  await assert.rejects(readBoundedImageResponse(res(payload(1000))), /unexpectedly small/);
});

test('rejects provider errors without buffering HTML error pages', async () => {
  const failed = new Response('provider temporarily unavailable', {
    status: 502, headers: {'content-type':'text/html'}
  });
  await assert.rejects(readBoundedImageResponse(failed), /request failed/);
});
