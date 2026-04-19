'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeLock, getLocked, lockedVersion, lockPathFor } = require('../lib/lockfile');

function tmpLock() {
  return path.join(os.tmpdir(), `ue-lock-${process.pid}-${Date.now()}-${Math.random()}.json`);
}

test('lockPathFor swaps .json for -lock.json', () => {
  assert.strictEqual(lockPathFor('/x/plugins.json'), '/x/plugins-lock.json');
});

test('writeLock + getLocked round-trips a bare string (legacy)', () => {
  const lp = tmpLock();
  try {
    writeLock(lp, 'A', 'v1.0.0');
    assert.strictEqual(getLocked(lp, 'A'), 'v1.0.0');
  } finally {
    if (fs.existsSync(lp)) fs.rmSync(lp);
  }
});

test('writeLock + getLocked round-trips an object form', () => {
  const lp = tmpLock();
  try {
    writeLock(lp, 'B', { version: 'v1.0.0', module: 'Meshes', sha256: 'abc' });
    assert.deepStrictEqual(getLocked(lp, 'B'), {
      version: 'v1.0.0',
      module: 'Meshes',
      sha256: 'abc',
    });
  } finally {
    if (fs.existsSync(lp)) fs.rmSync(lp);
  }
});

test('lockedVersion handles both shapes and null', () => {
  assert.strictEqual(lockedVersion(null), null);
  assert.strictEqual(lockedVersion('v1.0.0'), 'v1.0.0');
  assert.strictEqual(lockedVersion({ version: 'v1.0.0' }), 'v1.0.0');
  assert.strictEqual(lockedVersion({}), null);
});

test('writeLock preserves other entries when updating one', () => {
  const lp = tmpLock();
  try {
    writeLock(lp, 'A', 'v1');
    writeLock(lp, 'B', { version: 'v2', module: 'M' });
    writeLock(lp, 'A', 'v1.1');
    assert.strictEqual(getLocked(lp, 'A'), 'v1.1');
    assert.deepStrictEqual(getLocked(lp, 'B'), { version: 'v2', module: 'M' });
  } finally {
    if (fs.existsSync(lp)) fs.rmSync(lp);
  }
});

const { lockedMatches } = require('../lib/lockfile');

test('lockedMatches: legacy string lock matches version, no module required', () => {
  assert.strictEqual(lockedMatches('v1', 'v1', undefined), true);
  assert.strictEqual(lockedMatches('v1', 'v2', undefined), false);
});

test('lockedMatches: object lock requires both version and module', () => {
  const lock = { version: 'v1', module: 'M' };
  assert.strictEqual(lockedMatches(lock, 'v1', 'M'), true);
  assert.strictEqual(lockedMatches(lock, 'v1', 'N'), false, 'different module → no match');
  assert.strictEqual(lockedMatches(lock, 'v2', 'M'), false, 'different version → no match');
});

test('lockedMatches: module entry against legacy string lock → no match', () => {
  // Switching from artifact mode to module mode: should re-install
  assert.strictEqual(lockedMatches('v1', 'v1', 'M'), false);
});

test('lockedMatches: artifact entry against object lock → match if version matches', () => {
  // Switching from module mode to artifact mode: object lock with same version is OK
  // (caller will overwrite the lock entry on success)
  const lock = { version: 'v1', module: 'M' };
  assert.strictEqual(lockedMatches(lock, 'v1', undefined), true);
});

test('lockedMatches: null lock → no match', () => {
  assert.strictEqual(lockedMatches(null, 'v1', undefined), false);
  assert.strictEqual(lockedMatches(null, 'v1', 'M'), false);
});
