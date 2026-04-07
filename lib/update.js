'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { getLatestTag, listAssetNames } = require('./github');
const { lockPathFor } = require('./lockfile');
const { install, installOne, readConfig, resolveConfigPath } = require('./install');

const info = (msg) => console.log(chalk.cyan('[info]'), msg);
const done = (msg) => console.log(chalk.green('[done]'), msg);
const warn = (msg) => console.log(chalk.yellow('[warn]'), msg);
const fail = (msg) => console.error(chalk.red('[error]'), msg);

/**
 * update command handler.
 * @param {string|undefined} targetName  Specific entry to update, or undefined for all
 * @param {{ config: string, dir: string }} opts
 */
async function update(targetName, opts) {
  const configPath = resolveConfigPath(opts.config);
  const lockPath = lockPathFor(configPath);

  const { entries, dir: configDir } = readConfig(configPath);
  const baseDir = path.resolve(opts.dir || configDir || 'Plugins');

  let names;
  if (targetName) {
    if (!entries[targetName]) {
      fail(`'${targetName}' not found in ${opts.config}`);
      fail(`  Available: ${Object.keys(entries).join(', ')}`);
      process.exit(1);
    }
    names = [targetName];
  } else {
    names = Object.keys(entries);
  }

  console.log();
  console.log(chalk.cyan('╔══════════════════════════════════════╗'));
  console.log(chalk.cyan('║   UE5 Asset Updater                  ║'));
  console.log(chalk.cyan('╚══════════════════════════════════════╝'));
  console.log();

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const entry = entries[name];
    console.log();
    info(`[${i + 1}/${names.length}] Checking ${name} (current: ${entry.version})`);

    // Fetch latest tag
    let latestTag;
    try {
      latestTag = await getLatestTag(entry.repo);
    } catch (err) {
      warn(`  Could not fetch latest release for ${entry.repo} — ${err.message}`);
      failed++;
      continue;
    }

    if (latestTag === entry.version) {
      done(`  ${name}@${entry.version} — already up to date`);
      continue;
    }

    info(`  ${name}: ${entry.version} → ${chalk.yellow(latestTag)}`);

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

    // Patch version in config file
    const prevVersion = entry.version;
    patchConfigVersion(configPath, name, latestTag);
    entry.version = latestTag;

    try {
      await installOne(name, entry, baseDir, lockPath, true);
      updated++;
    } catch (err) {
      fail(`  Failed to install ${name}@${latestTag}: ${err.message}`);
      // Rollback config
      patchConfigVersion(configPath, name, prevVersion);
      entry.version = prevVersion;
      warn(`  Rolled back ${opts.config}: ${name} → ${prevVersion}`);
      failed++;
    }
  }

  console.log();
  console.log('────────────────────────────────────────');
  if (updated > 0) done(`${updated} asset(s) updated.`);
  else info('No assets needed updating.');
  if (failed > 0) {
    warn(`${failed} asset(s) failed to update.`);
    process.exitCode = 1;
  }
  console.log();
}

/**
 * Update the version field for a named entry in the config file.
 * Operates on the raw JSON to preserve formatting.
 */
function patchConfigVersion(configPath, name, newVersion) {
  const json = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const rootKey = Object.keys(json)[0];
  json[rootKey][name].version = newVersion;
  fs.writeFileSync(configPath, JSON.stringify(json, null, 2) + '\n');
}

module.exports = { update };
