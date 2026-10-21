'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSetupGuard, createPairLimiter, safeEqual } = require('../security/setup-access');

function response() {
  const result = { headers: {}, statusCode: 200, body: null };
  result.set = (k, v) => { result.headers[k] = v; return result; };
  result.status = n => { result.statusCode = n; return result; };
  result.send = x => { result.body = x; return result; };
  result.json = x => { result.body = x; return result; };
  return result;
}
function request(authorization = '') { return { headers: { authorization } }; }
test('administration denies missing credentials and misconfiguration', () => {
  const noConfig = createSetupGuard({});
  let called = false, r = response();
  noConfig(request(), r, () => { called = true; });
  assert.equal(r.statusCode, 503); assert.equal(called, false);
  const guard = createSetupGuard({ BOT_SETUP_USER: 'owner', BOT_SETUP_PASSWORD: 'A-long-private-example-password-123' });
  r = response(); guard(request(), r, () => { called = true; });
  assert.equal(r.statusCode, 401); assert.equal(called, false);
});
test('administration accepts exact Basic credentials only', () => {
  const guard = createSetupGuard({ BOT_SETUP_USER: 'owner', BOT_SETUP_PASSWORD: 'A-long-private-example-password-123' });
  let called = false, r = response();
  guard(request('Basic ' + Buffer.from('owner:wrong-password').toString('base64')), r, () => { called = true; });
  assert.equal(r.statusCode, 401); assert.equal(called, false);
  r = response();
  guard(request('Basic ' + Buffer.from('owner:A-long-private-example-password-123').toString('base64')), r, () => { called = true; });
  assert.equal(r.statusCode, 200); assert.equal(called, true);
});
test('pairing permits three attempts then returns 429 until reset', () => {
  let clock = 1000, attempts = 0;
  const limit = createPairLimiter({ now: () => clock });
  for (let i = 0; i < 3; i++) limit(request(), response(), () => attempts++);
  const denied = response(); limit(request(), denied, () => attempts++);
  assert.equal(attempts, 3); assert.equal(denied.statusCode, 429);
  assert.ok(Number(denied.headers['Retry-After']) > 0);
  clock += 900001; limit(request(), response(), () => attempts++);
  assert.equal(attempts, 4);
});
test('credential comparator rejects empties', () => {
  assert.equal(safeEqual('', ''), false);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
});
