'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');

// resolveToken() caches, so each case runs in a fresh process.
function resolveIn(env) {
  return execFileSync(
    process.execPath,
    ['-e', "process.stdout.write(String(require('./lib/github').resolveToken()))"],
    { cwd: __dirname + '/..', encoding: 'utf8', env: { ...process.env, ...env } },
  );
}

test('GITHUB_TOKEN wins over the gh CLI', () => {
  assert.strictEqual(resolveIn({ GITHUB_TOKEN: 'from-env' }), 'from-env');
});

test('falls back to gh auth token when GITHUB_TOKEN is unset', () => {
  // Shadow the real `gh` with a stub earlier on PATH.
  const dir = require('fs').mkdtempSync(require('os').tmpdir() + '/gh-stub-');
  require('fs').writeFileSync(`${dir}/gh`, '#!/bin/sh\necho from-gh\n', { mode: 0o755 });
  assert.strictEqual(
    resolveIn({ GITHUB_TOKEN: '', PATH: `${dir}:${process.env.PATH}` }),
    'from-gh',
  );
});

test('resolves to undefined when gh is unavailable', () => {
  const dir = require('fs').mkdtempSync(require('os').tmpdir() + '/gh-none-');
  assert.strictEqual(resolveIn({ GITHUB_TOKEN: '', PATH: dir }), 'undefined');
});
