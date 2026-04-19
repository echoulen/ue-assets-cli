'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const { downloadAsset } = require('./github');
const { downloadUrl, filenameFromUrl } = require('./http');
const { verifySha256 } = require('./sha256');
const { fetchManifest, resolveModule } = require('./manifest');
const { lockPathFor, getLocked, lockedMatches, writeLock } = require('./lockfile');
const { extractZip } = require('./extract');

const info = (msg) => console.log(chalk.cyan('[info]'), msg);
const done = (msg) => console.log(chalk.green('[done]'), msg);
const warn = (msg) => console.log(chalk.yellow('[warn]'), msg);
const fail = (msg) => console.error(chalk.red('[error]'), msg);

/**
 * Resolve a config path: append .json if no extension is present.
 */
function resolveConfigPath(configArg) {
  const p = path.extname(configArg) ? configArg : `${configArg}.json`;
  return path.resolve(p);
}

/**
 * Read the config file and return entries + optional dir.
 * plugins.json  → { "plugins": { ... }, "dir": "../../Plugins" }
 * content.json  → { "content": { ... } }
 *
 * @returns {{ entries: object, dir?: string }}
 */
function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const json = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Extract optional top-level "dir"
  const dir = json.dir;

  // The entries are under the first key that isn't "dir"
  const rootKey = Object.keys(json).find((k) => k !== 'dir');
  const entries = rootKey ? json[rootKey] : undefined;
  if (!entries || typeof entries !== 'object') {
    throw new Error(`No entries found in ${configPath}`);
  }
  return { entries, dir };
}

/**
 * Install a single entry (plugin or content).
 *
 * @param {string} name
 * @param {{ repo: string, version: string, asset?: string, module?: string, dest?: string, password?: string }} entry
 * @param {string} baseDir   Default base directory (e.g. absolute path to Plugins/)
 * @param {string} lockPath
 * @param {boolean} clean
 */
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

  // Resolve destination directory
  const destDir = dest
    ? path.resolve(path.dirname(lockPath), '..', dest)
    : path.join(baseDir, name);

  // Skip if already installed at this version (unless --clean)
  const locked = getLocked(lockPath, name);
  if (!clean && fs.existsSync(destDir) && lockedMatches(locked, version, moduleName)) {
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

/**
 * install command handler.
 * @param {{ config: string, dir: string, clean: boolean }} opts
 */
async function install(opts) {
  const configPath = resolveConfigPath(opts.config);
  const lockPath = lockPathFor(configPath);

  const { entries, dir: configDir } = readConfig(configPath);
  const baseDir = path.resolve(opts.dir || configDir || 'Plugins');
  const names = Object.keys(entries);

  console.log();
  console.log(chalk.cyan('╔══════════════════════════════════════╗'));
  console.log(chalk.cyan('║   UE5 Asset Installer                ║'));
  console.log(chalk.cyan('╚══════════════════════════════════════╝'));
  console.log();

  fs.mkdirSync(baseDir, { recursive: true });

  let failed = 0;
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    console.log();
    info(`[${i + 1}/${names.length}] ${name}`);
    try {
      await installOne(name, entries[name], baseDir, lockPath, opts.clean);
    } catch (err) {
      fail(err.message);
      failed++;
    }
  }

  console.log();
  console.log('────────────────────────────────────────');
  if (failed === 0) {
    done(`All ${names.length} asset(s) installed successfully.`);
  } else {
    warn(`${failed}/${names.length} asset(s) failed to install.`);
    process.exitCode = 1;
  }
  console.log();
}

module.exports = { install, installOne, readConfig, resolveConfigPath };
