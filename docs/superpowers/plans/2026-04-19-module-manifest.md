# Module Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add manifest-resolver mode so a single GitHub Release can serve multiple sub-packages — some hosted as GitHub artifacts, some as external HTTP(S) URLs (e.g. R2/S3) — selected by a `module` field in the consumer config.

**Architecture:** Consumer config gains a `module` field; presence switches to manifest mode. The CLI fetches `manifest.json` from the GitHub Release identified by `repo`+`version`, validates `schemaVersion`/`version`, looks up the named module, then downloads either a GitHub artifact (existing path) or an HTTP URL (new `lib/http.js`) — verifying SHA-256 when present (mandatory for `url` source). Manifest is cached in-memory per `(repo, version)` within a single CLI run.

**Tech Stack:** Node.js >= 18 (built-in `fetch`, `node:test`, `node:crypto`), `@octokit/rest`, `adm-zip`, `chalk`, `commander`, `dotenv`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-04-19-module-manifest-design.md`

---

## File Structure

**New files:**
- `lib/sha256.js` — `verifySha256(filePath, expected)` — pure crypto helper.
- `lib/http.js` — `downloadUrl(url, destPath, displayName)` + `resolveUrl(template, version)` + `filenameFromUrl(url, fallback)`. Reads `HTTP_AUTH_TOKEN` env var.
- `lib/manifest.js` — `validateManifest(parsed, repo, version)` (pure), `resolveModule(manifest, name, repo, version)` (pure), `fetchManifest(repo, version, deps?)` with module-local Map cache.
- `test/sha256.test.js`, `test/http.test.js`, `test/manifest.test.js`, `test/lockfile.test.js`, `test/install-validation.test.js`.

**Modified files:**
- `lib/github.js` — add `fetchReleaseAssetText(repo, tag, assetName)` that returns the asset body as a string (for `manifest.json`).
- `lib/lockfile.js` — extend `writeLock` to accept either a string (legacy) or `{ version, module?, sha256? }`; add `lockedVersion(value)` helper. `getLocked` returns the raw stored value unchanged (back-compat).
- `lib/install.js` — branch on `entry.module` vs `entry.asset`; thread a `manifestCache` Map through `installAll` so multiple entries sharing a release fetch once.
- `lib/update.js` — for `module` entries, the existing flow already works (resolve latest tag → patch config version → call `installOne` which now re-fetches manifest at the new tag). Verify rollback path covers missing-module-on-new-release.
- `package.json` — add `"test": "node --test test/"` script.
- `README.md`, `CLAUDE.md` — document `module` field, manifest schema (link to spec), `HTTP_AUTH_TOKEN`.

**Why split this way:** sha256, http, and manifest each have a single responsibility and stay under ~120 lines, easy to unit-test in isolation. `install.js` orchestrates them — kept thin by pushing logic into the helpers.

---

## Task 0: Bootstrap test infrastructure

**Files:**
- Modify: `package.json`
- Create: `test/smoke.test.js`

- [ ] **Step 1: Add `test` script and create test directory**

Append a `scripts` block to `package.json` (between `engines` and `license` keep order; insert after `bin` if no scripts block exists):

```json
{
  "name": "ue-assets",
  "version": "0.1.0",
  "description": "CLI to install Unreal Engine plugins and content from GitHub Releases",
  "bin": {
    "ue-assets": "./cli.js"
  },
  "scripts": {
    "test": "node --test test/"
  },
  "files": [
    "cli.js",
    "lib/"
  ],
  "dependencies": {
    "@octokit/rest": "^21",
    "adm-zip": "^0.5",
    "chalk": "^4",
    "commander": "^12",
    "dotenv": "^16"
  },
  "engines": {
    "node": ">=18"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Write a smoke test**

Create `test/smoke.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

test('smoke: node:test runner is wired up', () => {
  assert.strictEqual(1 + 1, 2);
});
```

- [ ] **Step 3: Run the smoke test**

Run: `npm test`
Expected: `# tests 1`, `# pass 1`, exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json test/smoke.test.js
git commit -m "chore: bootstrap node:test runner"
```

---

## Task 1: SHA-256 verification helper

**Files:**
- Create: `lib/sha256.js`
- Create: `test/sha256.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/sha256.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { verifySha256 } = require('../lib/sha256');

const HELLO_SHA = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

function tmpFile(content) {
  const p = path.join(os.tmpdir(), `ue-assets-test-${process.pid}-${Date.now()}-${Math.random()}.bin`);
  fs.writeFileSync(p, content);
  return p;
}

test('verifySha256 resolves when hash matches', async () => {
  const f = tmpFile('hello');
  try {
    const actual = await verifySha256(f, HELLO_SHA);
    assert.strictEqual(actual, HELLO_SHA);
  } finally {
    fs.rmSync(f);
  }
});

test('verifySha256 is case-insensitive on the expected hex', async () => {
  const f = tmpFile('hello');
  try {
    await verifySha256(f, HELLO_SHA.toUpperCase());
  } finally {
    fs.rmSync(f);
  }
});

test('verifySha256 throws when hash does not match', async () => {
  const f = tmpFile('hello');
  try {
    await assert.rejects(
      () => verifySha256(f, 'deadbeef'),
      /sha256 mismatch/,
    );
  } finally {
    fs.rmSync(f);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: failures with `Cannot find module '../lib/sha256'`.

- [ ] **Step 3: Implement `lib/sha256.js`**

Create `lib/sha256.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Compute sha256 of a file and compare against expected hex (case-insensitive).
 * Returns the actual hash on match, throws on mismatch.
 */
async function verifySha256(filePath, expected) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const actual = hash.digest('hex');
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `sha256 mismatch for ${path.basename(filePath)}\n  expected: ${expected}\n  actual:   ${actual}`,
    );
  }
  return actual;
}

module.exports = { verifySha256 };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: smoke + 3 sha256 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/sha256.js test/sha256.test.js
git commit -m "feat(sha256): add verifySha256 helper"
```

---

## Task 2: Generic HTTP downloader

**Files:**
- Create: `lib/http.js`
- Create: `test/http.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/http.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: failures with `Cannot find module '../lib/http'`.

- [ ] **Step 3: Implement `lib/http.js`**

Create `lib/http.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AUTH_ENV = 'HTTP_AUTH_TOKEN';

function resolveUrl(urlTemplate, version) {
  return urlTemplate.replace(/\{version\}/g, version);
}

function filenameFromUrl(url, fallbackName) {
  try {
    const parsed = new URL(url);
    const base = path.basename(parsed.pathname);
    if (base && base !== '/' && base !== '.') return base;
  } catch {}
  return `${fallbackName}.zip`;
}

/**
 * Download an HTTP(S) URL to destPath, streaming to disk.
 * Attaches `Authorization: Bearer ${HTTP_AUTH_TOKEN}` when the env var is set.
 */
async function downloadUrl(url, destPath, displayName) {
  const token = process.env[AUTH_ENV];
  const headers = {
    'User-Agent': 'ue-assets-cli',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText} (${url})`);
  }

  const total = parseInt(response.headers.get('content-length') || '0', 10);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const out = fs.createWriteStream(destPath);
  const reader = response.body.getReader();
  let downloaded = 0;
  const showProgress = process.stdout.isTTY;

  if (showProgress) process.stdout.write(`  ↳ Downloading ${displayName}...`);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      downloaded += value.length;
      if (showProgress && total) {
        const pct = Math.round((downloaded / total) * 100);
        process.stdout.write(`\r  ↳ Downloading ${displayName}... ${pct}%`);
      }
    }
  } finally {
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (showProgress) process.stdout.write('\n');
  }
}

module.exports = { downloadUrl, resolveUrl, filenameFromUrl, AUTH_ENV };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all http tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/http.js test/http.test.js
git commit -m "feat(http): add streaming downloadUrl with HTTP_AUTH_TOKEN"
```

---

## Task 3: Manifest validation & module resolution (pure)

**Files:**
- Create: `lib/manifest.js`
- Create: `test/manifest.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/manifest.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: failures with `Cannot find module '../lib/manifest'`.

- [ ] **Step 3: Implement validation + resolveModule in `lib/manifest.js`**

Create `lib/manifest.js`:

```js
'use strict';

const MAX_SCHEMA_VERSION = 1;

function validateManifest(parsed, repo, version) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`manifest of ${repo}@${version} is not a JSON object`);
  }
  if (typeof parsed.schemaVersion !== 'number') {
    throw new Error(
      `manifest of ${repo}@${version} is missing 'schemaVersion'`,
    );
  }
  if (parsed.schemaVersion > MAX_SCHEMA_VERSION) {
    throw new Error(
      `manifest schemaVersion ${parsed.schemaVersion} not supported by this CLI (max: ${MAX_SCHEMA_VERSION})`,
    );
  }
  if (parsed.version !== version) {
    throw new Error(
      `manifest version mismatch: release ${version} contains manifest declaring ${parsed.version}`,
    );
  }
  if (!parsed.modules || typeof parsed.modules !== 'object') {
    throw new Error(`manifest of ${repo}@${version} is missing 'modules'`);
  }
  for (const [name, mod] of Object.entries(parsed.modules)) {
    if (!mod || typeof mod !== 'object') {
      throw new Error(`module '${name}' in ${repo}@${version} is not an object`);
    }
    if (mod.source === 'artifact') {
      if (typeof mod.asset !== 'string' || !mod.asset) {
        throw new Error(`module '${name}' (artifact) is missing 'asset'`);
      }
    } else if (mod.source === 'url') {
      if (typeof mod.url !== 'string' || !mod.url) {
        throw new Error(`module '${name}' (url) is missing 'url'`);
      }
      if (typeof mod.sha256 !== 'string' || !mod.sha256) {
        throw new Error(`module '${name}': sha256 is required for url source`);
      }
    } else {
      throw new Error(
        `module '${name}' has unknown source '${mod.source}' (expected 'artifact' or 'url')`,
      );
    }
  }
}

function resolveModule(manifest, name, repo, version) {
  const mod = manifest.modules[name];
  if (!mod) {
    const available = Object.keys(manifest.modules).join(', ') || '(none)';
    throw new Error(
      `module '${name}' not in manifest of ${repo}@${version}; available: ${available}`,
    );
  }
  return mod;
}

module.exports = { validateManifest, resolveModule, MAX_SCHEMA_VERSION };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all manifest tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/manifest.js test/manifest.test.js
git commit -m "feat(manifest): add schema validation and module resolution"
```

---

## Task 4: Manifest fetch with in-memory cache

**Files:**
- Modify: `lib/github.js`
- Modify: `lib/manifest.js`
- Modify: `test/manifest.test.js`

- [ ] **Step 1: Add the failing test for fetch + cache**

Append to `test/manifest.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: failures referencing `fetchManifest` not exported.

- [ ] **Step 3: Add `fetchReleaseAssetText` to `lib/github.js`**

Add the following function inside `lib/github.js` (above the existing `module.exports`) and include it in the export list:

```js
/**
 * Fetch a release asset's body as a UTF-8 string.
 * Used for small text assets like manifest.json.
 */
async function fetchReleaseAssetText(repo, tag, assetName) {
  const { owner, name } = splitRepo(repo);
  const octokit = getOctokit();

  const { data: release } = await octokit.repos.getReleaseByTag({ owner, repo: name, tag });
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    const available = release.assets.map((a) => a.name).join(', ') || '(none)';
    throw new Error(
      `Asset '${assetName}' not found in ${repo}@${tag}.\n  Available: ${available}`,
    );
  }

  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept: 'application/octet-stream',
    'User-Agent': 'ue-assets-cli',
    ...(token ? { Authorization: `token ${token}` } : {}),
  };
  const response = await fetch(asset.url, { headers, redirect: 'follow' });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${assetName} from ${repo}@${tag}: HTTP ${response.status} ${response.statusText}`,
    );
  }
  return await response.text();
}
```

Update the existing `module.exports` line:

```js
module.exports = { getLatestTag, listAssetNames, downloadAsset, fetchReleaseAssetText };
```

- [ ] **Step 4: Add `fetchManifest` + cache to `lib/manifest.js`**

Append to `lib/manifest.js` (above `module.exports`):

```js
const { fetchReleaseAssetText } = require('./github');

const MANIFEST_ASSET = 'manifest.json';
const _cache = new Map(); // key: `${repo}@${version}` → manifest

async function fetchManifest(repo, version, deps = {}) {
  const key = `${repo}@${version}`;
  if (_cache.has(key)) return _cache.get(key);

  const fetcher = deps.fetcher || ((r, v) => fetchReleaseAssetText(r, v, MANIFEST_ASSET));
  let raw;
  try {
    raw = await fetcher(repo, version);
  } catch (err) {
    if (/not found/i.test(err.message)) {
      throw new Error(
        `manifest.json not found in ${repo}@${version} (module mode requires it)`,
      );
    }
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest of ${repo}@${version} is not valid JSON: ${err.message}`);
  }
  validateManifest(parsed, repo, version);
  _cache.set(key, parsed);
  return parsed;
}

function _resetCacheForTest() {
  _cache.clear();
}
```

Update `module.exports` to:

```js
module.exports = { validateManifest, resolveModule, fetchManifest, MAX_SCHEMA_VERSION, _resetCacheForTest };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all manifest + fetch tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/github.js lib/manifest.js test/manifest.test.js
git commit -m "feat(manifest): add fetchManifest with per-run cache"
```

---

## Task 5: Lockfile dual-shape support

**Files:**
- Modify: `lib/lockfile.js`
- Create: `test/lockfile.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/lockfile.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: failure — `lockedVersion` is not exported.

- [ ] **Step 3: Update `lib/lockfile.js`**

Replace the contents of `lib/lockfile.js` with:

```js
'use strict';

const fs = require('node:fs');

function lockPathFor(configPath) {
  return configPath.replace(/\.json$/, '-lock.json');
}

/**
 * Read the locked record for a named entry.
 * Returns either a string (legacy) or an object like { version, module?, sha256? }.
 */
function getLocked(lockPath, name) {
  if (!fs.existsSync(lockPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return data[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract the version string from a locked record (handles legacy bare-string
 * and {version, ...} object forms).
 */
function lockedVersion(locked) {
  if (locked == null) return null;
  if (typeof locked === 'string') return locked;
  return locked.version ?? null;
}

/**
 * Write a locked entry.
 * Pass a string for legacy version-only form, or an object for module mode.
 */
function writeLock(lockPath, name, value) {
  let data = {};
  if (fs.existsSync(lockPath)) {
    try {
      data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {}
  }
  data[name] = value;
  fs.writeFileSync(lockPath, JSON.stringify(data, null, 2) + '\n');
}

module.exports = { lockPathFor, getLocked, lockedVersion, writeLock };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all lockfile tests pass; existing modules still load (smoke + sha256 + http + manifest).

- [ ] **Step 5: Commit**

```bash
git add lib/lockfile.js test/lockfile.test.js
git commit -m "feat(lockfile): support {version, module, sha256} objects with back-compat"
```

---

## Task 6: Entry validation in install.js

**Files:**
- Modify: `lib/install.js`
- Create: `test/install-validation.test.js`

- [ ] **Step 1: Write the failing tests for entry validation**

Create `test/install-validation.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: tests fail because current `installOne` does not perform these validations.

- [ ] **Step 3: Add validation block at the top of `installOne` in `lib/install.js`**

Find the existing `installOne` definition (around line 58) and replace its destructuring + the lines up to (but not including) the `// Resolve destination directory` comment with:

```js
async function installOne(name, entry, baseDir, lockPath, clean) {
  const { repo, version, asset: assetTemplate, module: moduleName, dest, password } = entry;

  if (!version) throw new Error(`${name}: 'version' is required`);
  if (moduleName && assetTemplate) {
    throw new Error(`${name}: 'module' and 'asset' are mutually exclusive`);
  }
  if (!moduleName && !assetTemplate) {
    throw new Error(`${name}: must specify either 'module' or 'asset'`);
  }
  if (!repo) throw new Error(`${name}: 'repo' is required`);

```

(Leave the rest of the function — destination resolution, lock check, download, extract — unchanged for this task. Task 7 wires module mode into the body.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: validation tests pass; all prior tests still pass.

- [ ] **Step 5: Commit**

```bash
git add lib/install.js test/install-validation.test.js
git commit -m "feat(install): validate module/asset entry shape"
```

---

## Task 7: Wire manifest mode into install flow

**Files:**
- Modify: `lib/install.js`

This task does not add new unit tests — `installOne`'s integration with disk + network is exercised end-to-end in Task 9 (manual verification). All pure pieces (sha256, manifest validation, http) are already covered.

- [ ] **Step 1: Update imports in `lib/install.js`**

Replace the existing import block at the top of `lib/install.js`:

```js
const { downloadAsset } = require('./github');
const { lockPathFor, getLocked, writeLock } = require('./lockfile');
const { extractZip } = require('./extract');
```

with:

```js
const { downloadAsset } = require('./github');
const { downloadUrl, resolveUrl, filenameFromUrl } = require('./http');
const { verifySha256 } = require('./sha256');
const { fetchManifest, resolveModule } = require('./manifest');
const { lockPathFor, getLocked, lockedVersion, writeLock } = require('./lockfile');
const { extractZip } = require('./extract');
```

- [ ] **Step 2: Replace the body of `installOne` after the validation block**

Replace everything from `// Resolve destination directory` to the end of the `installOne` function with:

```js
  // Resolve destination directory
  const destDir = dest
    ? path.resolve(path.dirname(lockPath), '..', dest)
    : path.join(baseDir, name);

  // Skip if already installed at this version (unless --clean)
  const locked = getLocked(lockPath, name);
  if (!clean && fs.existsSync(destDir) && lockedVersion(locked) === version) {
    done(`${name}@${version} — already installed (skipped)`);
    return;
  }

  info(`Installing ${name}@${version}`);

  const tmpDir = path.join(os.tmpdir(), `ue-assets-${process.pid}`);
  let zipPath;
  let lockValue;

  try {
    if (moduleName) {
      const manifest = await fetchManifest(repo, version);
      const mod = resolveModule(manifest, moduleName, repo, version);

      if (mod.source === 'artifact') {
        zipPath = path.join(tmpDir, mod.asset);
        await downloadAsset(repo, version, mod.asset, zipPath);
        if (mod.sha256) {
          info('  ↳ Verifying sha256...');
          await verifySha256(zipPath, mod.sha256);
        }
      } else {
        // source === 'url' (validateManifest guarantees this)
        const fileName = filenameFromUrl(mod.url, name);
        zipPath = path.join(tmpDir, fileName);
        await downloadUrl(mod.url, zipPath, fileName);
        info('  ↳ Verifying sha256...');
        await verifySha256(zipPath, mod.sha256);
      }
      lockValue = { version, module: moduleName };
      if (mod.sha256) lockValue.sha256 = mod.sha256;
    } else {
      const assetName = assetTemplate.replace(/\{version\}/g, version);
      zipPath = path.join(tmpDir, assetName);
      await downloadAsset(repo, version, assetName, zipPath);
      lockValue = version;
    }

    // Remove old installation
    if (fs.existsSync(destDir)) {
      info(`  Removing old ${name}...`);
      fs.rmSync(destDir, { recursive: true, force: true });
    }

    const structure = extractZip(zipPath, name, destDir, password);
    info(`  ↳ Detected structure: ${structure}`);

    writeLock(lockPath, name, lockValue);
    const relDest = dest || path.relative(path.dirname(lockPath), destDir);
    done(`${name}@${version} — installed to ${relDest}`);
  } finally {
    if (zipPath && fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}
```

(Note: the `resolveUrl` import is unused for now; keep it — `lib/http.js` exports it for the `{version}`-in-`url` substitution scenario, which manifests don't need because the publisher pre-substitutes when generating the manifest. Remove the unused import for hygiene.)

- [ ] **Step 3: Remove the unused `resolveUrl` import**

In the import block for `lib/install.js` adjusted in Step 1, change:

```js
const { downloadUrl, resolveUrl, filenameFromUrl } = require('./http');
```

to:

```js
const { downloadUrl, filenameFromUrl } = require('./http');
```

- [ ] **Step 4: Run all tests to verify nothing broke**

Run: `npm test`
Expected: all previously passing tests still pass (smoke, sha256, http, manifest, lockfile, install-validation).

- [ ] **Step 5: Commit**

```bash
git add lib/install.js
git commit -m "feat(install): resolve module entries via manifest and verify sha256"
```

---

## Task 8: Update command compatibility check

**Files:**
- Modify: `lib/update.js`

The existing `update` flow already does the right thing for module entries: `getLatestTag` finds the new release tag, `patchConfigVersion` rewrites the version in the consumer config, then `installOne(clean=true)` runs and (because the entry has `module`) re-fetches the manifest at the new tag. If the new release lacks the requested module, `installOne` throws → `update.js` catches → rolls the version back. No new code path needed.

The one gotcha: the existing `update` code calls `listAssetNames(repo, latestTag)` and verifies the named asset exists. For module entries there is no `entry.asset` to check — this verification block must be skipped.

- [ ] **Step 1: Inspect the current asset-existence check**

Open `lib/update.js`. Around lines 70–87 there is a block:

```js
// Verify the expected asset exists in the new release
const assetName = entry.asset.replace(/\{version\}/g, latestTag);
let availableAssets;
try {
  availableAssets = await listAssetNames(entry.repo, latestTag);
} catch (err) {
  warn(`  Could not list assets for ${entry.repo}@${latestTag} — ${err.message}`);
  failed++;
  continue;
}

if (!availableAssets.includes(assetName)) {
  warn(`  Asset '${assetName}' not found in ${latestTag} — skipping`);
  warn(`  Available: ${availableAssets.join(', ') || '(none)'}`);
  failed++;
  continue;
}
```

This block dereferences `entry.asset` which is absent on module-mode entries.

- [ ] **Step 2: Skip the asset-existence check when the entry is module-mode**

Wrap the entire block above with `if (entry.asset) { ... }`. The corrected block:

```js
// Verify the expected asset exists in the new release (artifact mode only).
// Module-mode entries defer this validation to installOne's manifest lookup.
if (entry.asset) {
  const assetName = entry.asset.replace(/\{version\}/g, latestTag);
  let availableAssets;
  try {
    availableAssets = await listAssetNames(entry.repo, latestTag);
  } catch (err) {
    warn(`  Could not list assets for ${entry.repo}@${latestTag} — ${err.message}`);
    failed++;
    continue;
  }

  if (!availableAssets.includes(assetName)) {
    warn(`  Asset '${assetName}' not found in ${latestTag} — skipping`);
    warn(`  Available: ${availableAssets.join(', ') || '(none)'}`);
    failed++;
    continue;
  }
}
```

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: all tests still pass (no test changes).

- [ ] **Step 4: Commit**

```bash
git add lib/update.js
git commit -m "fix(update): skip asset-existence check for module-mode entries"
```

---

## Task 9: End-to-end manual verification

**Files:** none (manual smoke).

This task verifies the full install path against a real (or mock) GitHub release. The CLI has no integration test harness; the engineer runs the commands and confirms.

- [ ] **Step 1: Create a temporary fixture directory**

```bash
mkdir -p /tmp/ue-assets-e2e && cd /tmp/ue-assets-e2e
```

- [ ] **Step 2: Decide on a fixture release**

Two options:

**Option A — use an existing real release** with a published `manifest.json` (preferred if you maintain one). Skip to Step 3.

**Option B — publish a one-off test release** to a throwaway repo:

```bash
# In a scratch repo
echo "test content" > A-v0.0.1.zip   # (use a real zip if you want extraction to succeed)
cat > manifest.json <<'EOF'
{
  "schemaVersion": 1,
  "version": "v0.0.1",
  "modules": {
    "A": { "source": "artifact", "asset": "A-v0.0.1.zip" }
  }
}
EOF
gh release create v0.0.1 manifest.json A-v0.0.1.zip --repo <you>/ue-assets-e2e
```

- [ ] **Step 3: Write a consumer config**

In `/tmp/ue-assets-e2e/plugins.json`:

```json
{
  "dir": "./Out",
  "plugins": {
    "TestModule": {
      "repo": "<owner>/<repo>",
      "version": "v0.0.1",
      "module": "A"
    }
  }
}
```

- [ ] **Step 4: Run install**

```bash
GITHUB_TOKEN=<token> node /Users/carlos/work/ue-assets-cli/cli.js install --config plugins.json
```

Expected: `[done] TestModule@v0.0.1 — installed to ./Out/TestModule`. Lock file `plugins-lock.json` contains:

```json
{ "TestModule": { "version": "v0.0.1", "module": "A" } }
```

- [ ] **Step 5: Run install again — should skip**

```bash
node /Users/carlos/work/ue-assets-cli/cli.js install --config plugins.json
```

Expected: `[done] TestModule@v0.0.1 — already installed (skipped)`.

- [ ] **Step 6: Test missing-module error**

Edit `plugins.json` to set `"module": "DoesNotExist"`. Re-run install.

Expected: `[error] TestModule: module 'DoesNotExist' not in manifest of <owner>/<repo>@v0.0.1; available: A`. Process exit code 1.

- [ ] **Step 7: Test back-compat (artifact mode unchanged)**

Edit `plugins.json` to remove `module` and add `"asset": "A-v0.0.1.zip"`. Delete `Out/` and the lock file. Re-run install.

Expected: same successful install behavior as before this feature; lock file value is the bare string `"v0.0.1"`.

- [ ] **Step 8: Document any deviations**

If any step output differs from expectations, file the discrepancy as a follow-up issue or fix in a new commit before declaring done.

- [ ] **Step 9: Commit a NEWS / CHANGELOG entry if desired** (optional)

Project does not currently maintain a CHANGELOG; skip unless one exists.

---

## Task 10: Documentation updates

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add `module` mode + manifest reference to README**

Open `README.md`. Replace the line:

```
Requires Node.js >= 18 and a `GITHUB_TOKEN` with `contents:read` scope.
```

with:

```
Requires Node.js >= 18 and a `GITHUB_TOKEN` with `contents:read` scope. For
manifest entries whose `source` is `url` and points to a private bucket, set
`HTTP_AUTH_TOKEN` — sent as `Authorization: Bearer <token>`.
```

After the existing "## Config format" code block and bullet list, insert:

```markdown
### Module mode (multi-pack releases)

For a release that publishes a `manifest.json` listing multiple sub-packages,
reference them by name with `module`:

```json
{
  "dir": "Content/Brushify",
  "content": {
    "Brushify_AlphaBrushes": {
      "repo": "echoulen/Brushify",
      "version": "v1.0.0",
      "module": "AlphaBrushes"
    }
  }
}
```

`module` is mutually exclusive with `asset`. The CLI fetches `manifest.json`
from the release once per `(repo, version)` and resolves the module to either
a GitHub artifact or an external URL transparently. See
[`docs/superpowers/specs/2026-04-19-module-manifest-design.md`](docs/superpowers/specs/2026-04-19-module-manifest-design.md)
for the manifest schema.
```

- [ ] **Step 2: Update `CLAUDE.md` architecture section**

Open `CLAUDE.md`. Replace the architecture block:

```
cli.js              # Commander CLI entry point; loads .env, routes to handlers
lib/
  install.js        # installOne() + installAll(); reads config, checks lockfile, downloads+extracts
  update.js         # fetchLatest() + updateAll(); updates config JSON in-place, calls installOne(clean=true)
  github.js         # Lazy Octokit init; getLatestTag(), listAssetNames(), downloadAsset()
  extract.js        # ZIP extraction; auto-detects 3 structural patterns (Plugins/name/*, name/*, flat)
  lockfile.js       # lockPathFor(), getLocked(), writeLock() — derives lock path from config path
```

with:

```
cli.js              # Commander CLI entry point; loads .env, routes to handlers
lib/
  install.js        # installOne() + installAll(); branches on module/asset, threads manifest cache
  update.js         # updates config JSON in-place, skips asset existence check for module entries
  github.js         # Lazy Octokit init; getLatestTag(), listAssetNames(), downloadAsset(), fetchReleaseAssetText()
  http.js           # Generic HTTP(S) downloader with HTTP_AUTH_TOKEN bearer auth
  sha256.js         # verifySha256() for downloaded ZIPs
  manifest.js       # fetchManifest() w/ in-memory cache, validateManifest(), resolveModule()
  extract.js        # ZIP extraction; auto-detects 3 structural patterns (Plugins/name/*, name/*, flat)
  lockfile.js       # lockPathFor(), getLocked(), lockedVersion(), writeLock() — entry value is string OR { version, module?, sha256? }
```

Then replace the "Data flow for `install`" list:

```
**Data flow for `install`:**
1. Read config JSON (root key can be `"plugins"` or `"content"`)
2. For each entry, check lock file — skip if version already installed
3. Download asset ZIP to `/tmp/ue-assets-{pid}/`
4. Extract to `--dir` using smart structure detection
5. Write lock file entry
```

with:

```
**Data flow for `install`:**
1. Read config JSON (root key can be `"plugins"` or `"content"`)
2. For each entry, check lock file — skip if version already installed
3. Branch on entry shape:
   - `asset` → download named GitHub release artifact (existing path)
   - `module` → fetch (and cache) `manifest.json`, resolve module, download from artifact or URL, verify sha256
4. Extract to `--dir` using smart structure detection
5. Write lock file entry — bare version string (artifact) or `{version, module, sha256?}` (module)
```

Add a final bullet under "Config Format" bullets:

```
- `module` (per entry) switches to manifest-resolver mode; mutually exclusive with `asset`. See `docs/superpowers/specs/2026-04-19-module-manifest-design.md` for the manifest schema.
```

Add a new line under Commands or near `GITHUB_TOKEN` mention:

```
`HTTP_AUTH_TOKEN` is read from `.env` and sent as `Authorization: Bearer <token>` for `source: "url"` modules in manifests; unset for public buckets.
```

- [ ] **Step 3: Verify tests still pass and docs render**

Run: `npm test`
Expected: all tests still pass.

Visually skim README.md and CLAUDE.md in your editor or `cat` them.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document module mode and manifest schema"
```

---

## Self-Review

**1. Spec coverage** — every section of `docs/superpowers/specs/2026-04-19-module-manifest-design.md` maps to a task:

| Spec section | Task(s) |
|---|---|
| Manifest Schema (schemaVersion, version, modules) | Task 3 (validation), Task 4 (fetch + cache) |
| Module Entry Fields (artifact/url, sha256 mandatory for url) | Task 3 |
| Consumer Config (`module` field, mutual exclusion) | Task 6 (validation), Task 7 (resolution) |
| Install Flow steps 1–7 | Task 4 (1–2), Task 7 (3–7) |
| Environment Variables (GITHUB_TOKEN unchanged, HTTP_AUTH_TOKEN new) | Task 2 |
| Lock File (extended shape, skip purely on version+module match) | Task 5, Task 7 |
| Backward Compatibility (asset still works, lockfile reader handles old shape) | Task 5, Task 6, Task 7 |
| Implementation Impact (lib/manifest.js, lib/http.js, lib/sha256.js) | Tasks 1, 2, 3, 4 |
| Update flow (re-fetch manifest at new tag, rollback on missing module) | Task 8 |
| Non-Goals (no `manifest gen` command, no presigned URLs, etc.) | N/A — no implementation needed |

**2. Placeholder scan** — no TBD, no "implement later", every code-touching step contains the actual code. Manual-verification task (9) lists exact commands and expected output.

**3. Type / name consistency** — exported names check:
- `verifySha256` — defined Task 1, used Task 7
- `downloadUrl`, `filenameFromUrl`, `AUTH_ENV` — defined Task 2, used Task 7 (downloadUrl, filenameFromUrl) and Task 2 tests (AUTH_ENV)
- `validateManifest`, `resolveModule`, `fetchManifest`, `MAX_SCHEMA_VERSION`, `_resetCacheForTest` — defined Tasks 3 & 4, used Tasks 4 & 7
- `lockedVersion` — defined Task 5, used Task 7
- `fetchReleaseAssetText` — defined Task 4, used Task 4
- Consumer config field names: `repo`, `version`, `module`, `asset`, `dest` — consistent across spec, README, install.js, tests
- Manifest fields: `schemaVersion`, `version`, `modules`, `source`, `asset`, `url`, `sha256` — consistent

No mismatches found.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-19-module-manifest.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
