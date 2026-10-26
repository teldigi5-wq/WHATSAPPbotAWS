'use strict';

// Pairing accepts only a tiny, uncompressed JSON body. Disabling inflation
// prevents encoded request bodies from reaching any decompression stream.
function createPairBodyParser() {
  return require('express').json({ limit: '1kb', inflate: false });
}

module.exports = { createPairBodyParser };
