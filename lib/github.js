'use strict';

const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

let _octokit = null;

function getOctokit() {
  if (!_octokit) {
    _octokit = new Octokit({ auth: process.env.GITHUB_TOKEN || undefined });
  }
  return _octokit;
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
  const { data } = await getOctokit().repos.getLatestRelease({ owner, repo: name });
  return data.tag_name;
}

/**
 * List asset names for a specific release tag.
 * @param {string} repo  "owner/name"
 * @param {string} tag
 * @returns {Promise<string[]>}
 */
async function listAssetNames(repo, tag) {
  const { owner, name } = splitRepo(repo);
  const { data } = await getOctokit().repos.getReleaseByTag({ owner, repo: name, tag });
  return data.assets.map((a) => a.name);
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
  const token = process.env.GITHUB_TOKEN;
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

module.exports = { getLatestTag, listAssetNames, downloadAsset, fetchReleaseAssetText };
