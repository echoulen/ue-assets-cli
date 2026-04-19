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

const { fetchReleaseAssetText } = require('./github');

const MANIFEST_ASSET = 'manifest.json';
const _cache = new Map();

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

module.exports = { validateManifest, resolveModule, fetchManifest, MAX_SCHEMA_VERSION, _resetCacheForTest };
