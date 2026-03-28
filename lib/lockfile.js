'use strict';

const fs = require('fs');

/**
 * Derive the lock file path from the config file path.
 * plugins.json → plugins-lock.json
 * content.json → content-lock.json
 * @param {string} configPath
 * @returns {string}
 */
function lockPathFor(configPath) {
  return configPath.replace(/\.json$/, '-lock.json');
}

/**
 * Read the locked version for a named entry.
 * @param {string} lockPath
 * @param {string} name
 * @returns {string|null}
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
 * Write (or update) a locked version for a named entry.
 * @param {string} lockPath
 * @param {string} name
 * @param {string} version
 */
function writeLock(lockPath, name, version) {
  let data = {};
  if (fs.existsSync(lockPath)) {
    try {
      data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {}
  }
  data[name] = version;
  fs.writeFileSync(lockPath, JSON.stringify(data, null, 2) + '\n');
}

module.exports = { lockPathFor, getLocked, writeLock };
