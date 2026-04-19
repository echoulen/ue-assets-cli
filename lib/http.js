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
  let writeError = null;
  out.on('error', (err) => { writeError = err; });

  const reader = response.body.getReader();
  let downloaded = 0;
  const showProgress = process.stdout.isTTY;

  if (showProgress) process.stdout.write(`  ↳ Downloading ${displayName}...`);
  try {
    while (true) {
      if (writeError) throw writeError;
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
    try { await reader.cancel(); } catch {}
    await new Promise((resolve) => out.end(resolve));
    if (showProgress) process.stdout.write('\n');
  }
  if (writeError) throw writeError;
}

module.exports = { downloadUrl, resolveUrl, filenameFromUrl, AUTH_ENV };
