'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

function verifySha256(filePath, expected) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      const actual = hash.digest('hex');
      if (actual.toLowerCase() !== String(expected).toLowerCase()) {
        reject(new Error(`sha256 mismatch: expected ${expected}, got ${actual}`));
      } else {
        resolve();
      }
    });
  });
}

module.exports = { verifySha256 };
