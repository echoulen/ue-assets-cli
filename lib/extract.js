'use strict';

const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

/**
 * Extract a GitHub Release zip into destDir.
 *
 * Handles three structures found in UE5 asset zips:
 *   1. Plugins/{name}/...   → standard UE5 plugin zip
 *   2. {name}/...           → direct plugin/content folder
 *   3. flat                 → files at zip root
 *
 * @param {string} zipPath    Absolute path to the .zip file
 * @param {string} name       Entry name (plugin or content key)
 * @param {string} destDir    Absolute path to the install destination
 * @param {string} [password] Optional password for encrypted ZIPs
 * @returns {string}          Structure type detected: 'ue5', 'direct', or 'flat'
 */
function extractZip(zipPath, name, destDir, password) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  const ue5Prefix = `Plugins/${name}/`;
  const directPrefix = `${name}/`;

  const hasUe5 = entries.some((e) => e.entryName.startsWith(ue5Prefix));
  const hasDirect = entries.some((e) => e.entryName.startsWith(directPrefix));

  fs.mkdirSync(destDir, { recursive: true });

  if (hasUe5) {
    writeEntries(entries, ue5Prefix, destDir, password);
    return 'ue5';
  } else if (hasDirect) {
    writeEntries(entries, directPrefix, destDir, password);
    return 'direct';
  } else {
    zip.extractAllTo(destDir, true, false, password);
    return 'flat';
  }
}

function writeEntries(entries, prefix, destDir, password) {
  for (const entry of entries) {
    if (!entry.entryName.startsWith(prefix) || entry.isDirectory) continue;
    const relPath = entry.entryName.slice(prefix.length);
    const outPath = path.join(destDir, relPath);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, entry.getData(password));
  }
}

module.exports = { extractZip };
