'use strict';
const { timingSafeEqual } = require('node:crypto');

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8'), b = Buffer.from(right, 'utf8');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function createSetupGuard(env = process.env) {
  const username = env.BOT_SETUP_USER || '';
  const password = env.BOT_SETUP_PASSWORD || '';
  return function requireSetupAdmin(req, res, next) {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    if (username.length < 4 || password.length < 20) {
      return res.status(503).send('Bot administration is not configured.');
    }
    const header = req.headers.authorization || '';
    let credentials = '';
    if (header.startsWith('Basic ') && header.length < 1024) {
      try { credentials = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch (_) {}
    }
    const pivot = credentials.indexOf(':');
    const suppliedUser = pivot >= 0 ? credentials.slice(0, pivot) : '';
    const suppliedPassword = pivot >= 0 ? credentials.slice(pivot + 1) : '';
    if (!safeEqual(suppliedUser, username) || !safeEqual(suppliedPassword, password)) {
      res.set('WWW-Authenticate', 'Basic realm="Bot administration", charset="UTF-8"');
      return res.status(401).send('Administrator authentication required.');
    }
    next();
  };
}

function createPairLimiter({ maxAttempts = 3, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  let startedAt = 0, attempts = 0;
  return function limitPairing(req, res, next) {
    const current = now();
    if (!startedAt || current - startedAt >= windowMs) {
      startedAt = current; attempts = 0;
    }
    if (attempts >= maxAttempts) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((startedAt + windowMs - current) / 1000))));
      return res.status(429).json({ error: 'Pairing temporarily limited. Try again later.' });
    }
    attempts += 1;
    next();
  };
}

module.exports = { safeEqual, createSetupGuard, createPairLimiter };
