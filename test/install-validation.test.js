'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installOne } = require('../lib/install');

function tmpLock() {
  return path.join(os.tmpdir(), `ue-iv-${process.pid}-${Date.now()}-${Math.random()}.json`);
}

test('installOne rejects entries missing version', async () => {
  await assert.rejects(
    () => installOne('X', { repo: 'o/r', asset: 'X.zip' }, '/tmp', tmpLock(), false),
    /version.*required/i,
  );
});

test('installOne rejects entries with both module and asset', async () => {
  await assert.rejects(
    () => installOne(
      'X',
      { repo: 'o/r', version: 'v1', module: 'M', asset: 'X.zip' },
      '/tmp', tmpLock(), false,
    ),
    /mutually exclusive/i,
  );
});

test('installOne rejects entries with neither module nor asset', async () => {
  await assert.rejects(
    () => installOne('X', { repo: 'o/r', version: 'v1' }, '/tmp', tmpLock(), false),
    /must specify either 'module' or 'asset'/,
  );
});
