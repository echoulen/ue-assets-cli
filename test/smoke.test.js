'use strict';

const test = require('node:test');
const assert = require('node:assert');

test('smoke: node:test runner is wired up', () => {
  assert.strictEqual(1 + 1, 2);
});
