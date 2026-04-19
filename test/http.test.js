'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveUrl, filenameFromUrl, downloadUrl, AUTH_ENV } = require('../lib/http');

test('resolveUrl substitutes {version}', () => {
  assert.strictEqual(
    resolveUrl('https://x/y-{version}.zip', '1.2.3'),
    'https://x/y-1.2.3.zip',
  );
});

test('resolveUrl substitutes multiple occurrences', () => {
  assert.strictEqual(
    resolveUrl('https://x/{version}/y-{version}.zip', '9'),
    'https://x/9/y-9.zip',
  );
});

test('filenameFromUrl uses URL basename', () => {
  assert.strictEqual(filenameFromUrl('https://x/dir/foo.zip', 'fb'), 'foo.zip');
});

test('filenameFromUrl strips query string', () => {
  assert.strictEqual(
    filenameFromUrl('https://x/dir/foo.zip?token=abc', 'fb'),
    'foo.zip',
  );
});

test('filenameFromUrl falls back when path has no basename', () => {
  assert.strictEqual(filenameFromUrl('https://x/', 'fallback'), 'fallback.zip');
});

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        const result = await fn(`http://127.0.0.1:${port}`);
        server.close(() => resolve(result));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

test('downloadUrl writes the response body to disk', async () => {
  const dest = path.join(os.tmpdir(), `ue-http-${process.pid}-${Date.now()}.bin`);
  try {
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('payload-bytes');
      },
      (base) => downloadUrl(`${base}/file.zip`, dest, 'file.zip'),
    );
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'payload-bytes');
  } finally {
    if (fs.existsSync(dest)) fs.rmSync(dest);
  }
});

test('downloadUrl sends Authorization header when HTTP_AUTH_TOKEN is set', async () => {
  const dest = path.join(os.tmpdir(), `ue-http-auth-${process.pid}-${Date.now()}.bin`);
  let seenAuth = null;
  const prev = process.env[AUTH_ENV];
  process.env[AUTH_ENV] = 'sekret';
  try {
    await withServer(
      (req, res) => {
        seenAuth = req.headers['authorization'] || null;
        res.writeHead(200);
        res.end('ok');
      },
      (base) => downloadUrl(`${base}/x`, dest, 'x'),
    );
    assert.strictEqual(seenAuth, 'Bearer sekret');
  } finally {
    if (prev === undefined) delete process.env[AUTH_ENV];
    else process.env[AUTH_ENV] = prev;
    if (fs.existsSync(dest)) fs.rmSync(dest);
  }
});

test('downloadUrl omits Authorization header when env var is unset', async () => {
  const dest = path.join(os.tmpdir(), `ue-http-noauth-${process.pid}-${Date.now()}.bin`);
  let seenAuth = 'unset';
  const prev = process.env[AUTH_ENV];
  delete process.env[AUTH_ENV];
  try {
    await withServer(
      (req, res) => {
        seenAuth = req.headers['authorization'] ?? null;
        res.writeHead(200);
        res.end('ok');
      },
      (base) => downloadUrl(`${base}/x`, dest, 'x'),
    );
    assert.strictEqual(seenAuth, null);
  } finally {
    if (prev !== undefined) process.env[AUTH_ENV] = prev;
    if (fs.existsSync(dest)) fs.rmSync(dest);
  }
});

test('downloadUrl rejects on non-2xx', async () => {
  const dest = path.join(os.tmpdir(), `ue-http-fail-${process.pid}-${Date.now()}.bin`);
  try {
    await withServer(
      (req, res) => {
        res.writeHead(404);
        res.end('nope');
      },
      async (base) => {
        await assert.rejects(
          () => downloadUrl(`${base}/missing`, dest, 'missing'),
          /HTTP 404/,
        );
      },
    );
  } finally {
    if (fs.existsSync(dest)) fs.rmSync(dest);
  }
});

test('downloadUrl rejects when destination cannot be written', async () => {
  const dir = path.join(os.tmpdir(), `ue-noperm-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o500); // r-x only, no write
  const dest = path.join(dir, 'file.zip');
  try {
    await withServer(
      (req, res) => {
        res.writeHead(200);
        res.end('payload');
      },
      async (base) => {
        await assert.rejects(
          () => downloadUrl(`${base}/file.zip`, dest, 'file.zip'),
          /EACCES|permission/i,
        );
      },
    );
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
