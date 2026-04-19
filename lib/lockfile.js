'use strict';

const fs = require('node:fs');

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
 * Read the locked record for a named entry.
 * Returns either a string (legacy) or an object like { version, module?, sha256? }.
 * @param {string} lockPath
 * @param {string} name
 * @returns {string|object|null}
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
 * @param {string|object|null} locked
 * @returns {string|null}
 */
function lockedVersion(locked) {
  if (locked == null) return null;
  if (typeof locked === 'string') return locked;
  return locked.version ?? null;
}

/**
 * Check whether a stored lock entry matches the requested version + optional module.
 *
 * For artifact-mode entries (no moduleName), only the version must match — works
 * with both legacy bare-string locks and object-form locks.
 *
 * For module-mode entries, the lock must be the object form with both version
 * and module matching. A legacy string lock against a module-mode entry returns
 * false so the install proceeds (and overwrites the lock with the object form).
 *
 * @param {string|object|null} locked
 * @param {string} version
 * @param {string|undefined} moduleName
 * @returns {boolean}
 */
function lockedMatches(locked, version, moduleName) {
  if (locked == null) return false;
  if (lockedVersion(locked) !== version) return false;
  if (!moduleName) return true;
  if (typeof locked !== 'object') return false;
  return locked.module === moduleName;
}

/**
 * Write (or update) a locked entry.
 * Pass a string for legacy version-only form, or an object for module mode.
 * @param {string} lockPath
 * @param {string} name
 * @param {string|object} value
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

module.exports = { lockPathFor, getLocked, lockedVersion, lockedMatches, writeLock };
