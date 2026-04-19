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

const { fetchManifest, _resetCacheForTest } = require('../lib/manifest');

test('fetchManifest validates and caches per (repo, version)', async () => {
  _resetCacheForTest();
  let calls = 0;
  const fetcher = async (repo, version) => {
    calls++;
    return JSON.stringify({
      schemaVersion: 1,
      version,
      modules: { A: { source: 'artifact', asset: `A-${version}.zip` } },
    });
  };
  const a = await fetchManifest('o/r', 'v1', { fetcher });
  const b = await fetchManifest('o/r', 'v1', { fetcher });
  const c = await fetchManifest('o/r', 'v2', { fetcher });
  assert.strictEqual(a, b, 'same instance returned from cache');
  assert.notStrictEqual(a, c, 'different version is a separate cache entry');
  assert.strictEqual(calls, 2, 'one network call per (repo, version)');
});

test('fetchManifest surfaces validation errors', async () => {
  _resetCacheForTest();
  const fetcher = async () =>
    JSON.stringify({ schemaVersion: 99, version: 'v1', modules: {} });
  await assert.rejects(
    () => fetchManifest('o/r', 'v1', { fetcher }),
    /schemaVersion 99/,
  );
});

test('fetchManifest rejects malformed JSON', async () => {
  _resetCacheForTest();
  const fetcher = async () => 'not json';
  await assert.rejects(
    () => fetchManifest('o/r', 'v1', { fetcher }),
    /manifest of o\/r@v1 is not valid JSON/,
  );
});
