'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { validateManifest, resolveModule, MAX_SCHEMA_VERSION } = require('../lib/manifest');

function valid() {
  return {
    schemaVersion: 1,
    version: 'v1.0.0',
    modules: {
      A: { source: 'artifact', asset: 'A-v1.0.0.zip' },
      B: { source: 'url', url: 'https://x/B.zip', sha256: 'def' },
    },
  };
}

test('validateManifest accepts a well-formed manifest', () => {
  validateManifest(valid(), 'o/r', 'v1.0.0');
});

test('validateManifest rejects unknown schemaVersion', () => {
  const m = { ...valid(), schemaVersion: MAX_SCHEMA_VERSION + 1 };
  assert.throws(() => validateManifest(m, 'o/r', 'v1.0.0'), /schemaVersion/);
});

test('validateManifest rejects missing schemaVersion', () => {
  const m = valid();
  delete m.schemaVersion;
  assert.throws(() => validateManifest(m, 'o/r', 'v1.0.0'), /schemaVersion/);
});

test('validateManifest rejects version mismatch (hard fail)', () => {
  const m = { ...valid(), version: 'v0.9.0' };
  assert.throws(
    () => validateManifest(m, 'o/r', 'v1.0.0'),
    /manifest version mismatch/,
  );
});

test('validateManifest rejects missing modules', () => {
  const m = { schemaVersion: 1, version: 'v1.0.0' };
  assert.throws(() => validateManifest(m, 'o/r', 'v1.0.0'), /modules/);
});

test('validateManifest rejects url module without sha256', () => {
  const m = valid();
  delete m.modules.B.sha256;
  assert.throws(() => validateManifest(m, 'o/r', 'v1.0.0'), /sha256.*required.*url/i);
});

test('validateManifest rejects unknown source', () => {
  const m = valid();
  m.modules.A.source = 'magic';
  assert.throws(() => validateManifest(m, 'o/r', 'v1.0.0'), /source/);
});

test('resolveModule returns the module entry', () => {
  const m = valid();
  assert.deepStrictEqual(resolveModule(m, 'A', 'o/r', 'v1.0.0'), {
    source: 'artifact',
    asset: 'A-v1.0.0.zip',
  });
});

test('resolveModule throws with available list when missing', () => {
  const m = valid();
  assert.throws(
    () => resolveModule(m, 'C', 'o/r', 'v1.0.0'),
    /module 'C' not in manifest of o\/r@v1\.0\.0; available: A, B/,
  );
});
