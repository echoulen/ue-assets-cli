'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { verifySha256 } = require('../lib/sha256');

// 'hello' (no newline) -> known sha256
const HELLO_SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

function writeTmp(contents) {
  const p = path.join(os.tmpdir(), `ue-assets-sha-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, contents);
  return p;
}

test('verifySha256: matches expected hash', async () => {
  const p = writeTmp('hello');
  await verifySha256(p, HELLO_SHA);
  fs.unlinkSync(p);
});

test('verifySha256: comparison is case-insensitive', async () => {
  const p = writeTmp('hello');
  await verifySha256(p, HELLO_SHA.toUpperCase());
  fs.unlinkSync(p);
});

test('verifySha256: throws on mismatch', async () => {
  const p = writeTmp('hello');
  await assert.rejects(
    () => verifySha256(p, 'a'.repeat(64)),
    /sha256 mismatch/i
  );
  fs.unlinkSync(p);
});
