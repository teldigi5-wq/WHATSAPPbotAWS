'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { gzipSync } = require('node:zlib');
const express = require('express');
const { createPairBodyParser } = require('../security/pair-body-parser');
const { createSetupGuard } = require('../security/setup-access');

const user = 'owner';
const password = 'A-long-private-example-password-123';
const auth = 'Basic ' + Buffer.from(user + ':' + password).toString('base64');

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/pair', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('pairing JSON middleware keeps authentication and rejects encoded/oversized bodies', async () => {
  const app = express();
  app.post('/pair', createSetupGuard({ BOT_SETUP_USER: user, BOT_SETUP_PASSWORD: password }),
    createPairBodyParser(), (req, res) => res.json({ phone: req.body.phone }));
  // Error handling is intentionally generic; no untrusted request text is returned.
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'Invalid request body' }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const legitimate = Buffer.from(JSON.stringify({ phone: '94712345678' }));
    assert.equal((await post(port, legitimate)).status, 401, 'pairing authentication precedes parsing');
    const accepted = await post(port, legitimate, { Authorization: auth });
    assert.equal(accepted.status, 200);
    assert.deepEqual(JSON.parse(accepted.body), { phone: '94712345678' });

    const gzip = gzipSync(legitimate);
    assert.equal((await post(port, gzip, { Authorization: auth, 'Content-Encoding': 'gzip' })).status, 415);
    const trailing = Buffer.concat([gzip, Buffer.from([0xff, 0x00, 0xff])]);
    assert.equal((await post(port, trailing, { Authorization: auth, 'Content-Encoding': 'gzip' })).status, 415);
    const huge = Buffer.from(JSON.stringify({ phone: '9'.repeat(2048) }));
    assert.equal((await post(port, huge, { Authorization: auth })).status, 413);
    assert.equal((await post(port, legitimate, { Authorization: auth })).status, 200,
      'malformed bodies do not prevent subsequent authorized requests');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
