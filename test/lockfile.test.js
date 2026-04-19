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
