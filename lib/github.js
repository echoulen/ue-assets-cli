'use strict';

const { Octokit } = require('@octokit/rest');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let _octokit = null;
let _token;

/**
 * Resolve a GitHub token: GITHUB_TOKEN wins, otherwise fall back to the
 * logged-in `gh` CLI. Result is cached so `gh` runs at most once.
 * Never written back to the environment — that would hijack `gh`'s own
 * account switching in child processes.
 * @returns {string|undefined}
 */
function resolveToken() {
  if (_token === undefined) {
    _token = process.env.GITHUB_TOKEN || '';
    if (!_token) {
      try {
        _token = execFileSync('gh', ['auth', 'token'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        _token = '';
      }
    }
  }
  return _token || undefined;
}

function getOctokit() {
  if (!_octokit) {
    _octokit = new Octokit({ auth: resolveToken() });
  }
  return _octokit;
}

/**
 * Add an auth hint to 404s, which is what GitHub returns for a private repo
 * you cannot see.
 */
function withAuthHint(err, repo) {
  if (err.status === 404 && !resolveToken()) {
    err.message = `${err.message} — '${repo}' may be private; set GITHUB_TOKEN or run 'gh auth login'`;
  }
  return err;
}

function splitRepo(repo) {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Invalid repo format: '${repo}' — expected 'owner/name'`);
  return { owner, name };
}

/**
 * Get the latest release tag for a repo.
 * @param {string} repo  "owner/name"
 * @returns {Promise<string>}
 */
async function getLatestTag(repo) {
  const { owner, name } = splitRepo(repo);
  try {
    const { data } = await getOctokit().repos.getLatestRelease({ owner, repo: name });
    return data.tag_name;
  } catch (err) {
    throw withAuthHint(err, repo);
  }
}

/**
 * List asset names for a specific release tag.
 * @param {string} repo  "owner/name"
 * @param {string} tag
 * @returns {Promise<string[]>}
 */
async function listAssetNames(repo, tag) {
  const { owner, name } = splitRepo(repo);
  try {
    const { data } = await getOctokit().repos.getReleaseByTag({ owner, repo: name, tag });
    return data.assets.map((a) => a.name);
  } catch (err) {
    throw withAuthHint(err, repo);
  }
}

/**
 * Download a specific release asset to destPath.
 * Uses Node 18+ built-in fetch — handles auth redirect for private repos.
 * @param {string} repo  "owner/name"
 * @param {string} tag
 * @param {string} assetName
 * @param {string} destPath  Absolute path to write the zip file
 */
async function downloadAsset(repo, tag, assetName, destPath) {
  const { owner, name } = splitRepo(repo);
  const octokit = getOctokit();

  // Resolve asset ID
  const { data: release } = await octokit.repos.getReleaseByTag({ owner, repo: name, tag });
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    const available = release.assets.map((a) => a.name).join(', ') || '(none)';
    throw new Error(
      `Asset '${assetName}' not found in ${repo}@${tag}.\n  Available: ${available}`
    );
  }

  // Download via GitHub API asset URL (handles private repo auth)
  const token = resolveToken();
  const headers = {
    Accept: 'application/octet-stream',
    'User-Agent': 'ue-assets-cli',
    ...(token ? { Authorization: `token ${token}` } : {}),
  };

  const response = await fetch(asset.url, { headers, redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }

  const total = parseInt(response.headers.get('content-length') || '0', 10);
  const reader = response.body.getReader();
  const chunks = [];
  let downloaded = 0;

  process.stdout.write(`  ↳ Downloading ${assetName}...`);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.length;
    if (total) {
      const pct = Math.round((downloaded / total) * 100);
      process.stdout.write(`\r  ↳ Downloading ${assetName}... ${pct}%`);
    }
  }
  process.stdout.write('\n');

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.concat(chunks));
}

/**
 * Fetch a release asset's body as a UTF-8 string.
 * Used for small text assets like manifest.json.
 * @param {string} repo  "owner/name"
 * @param {string} tag
 * @param {string} assetName
 * @returns {Promise<string>}
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

  const token = resolveToken();
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

module.exports = { resolveToken, getLatestTag, listAssetNames, downloadAsset, fetchReleaseAssetText };
