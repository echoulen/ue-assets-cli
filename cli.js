#!/usr/bin/env node
'use strict';

// Load .env from cwd (project root) before anything else
require('dotenv').config();

const { program } = require('commander');
const { install } = require('./lib/install');
const { update } = require('./lib/update');

program
  .name('ue-assets')
  .description('Install Unreal Engine plugins and content from GitHub Releases')
  .version(require('./package.json').version);

program
  .command('install')
  .description('Install all assets listed in the config file')
  .option('--config <file>', 'Path to config JSON (plugins.json or content.json)', 'plugins.json')
  .option('--dir <directory>', 'Default base install directory', 'Plugins')
  .option('--clean', 'Remove and reinstall all assets', false)
  .action(async (opts) => {
    try {
      await install(opts);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

program
  .command('update')
  .description('Update assets to their latest GitHub Release versions')
  .argument('[name]', 'Update only this specific asset')
  .option('--config <file>', 'Path to config JSON (plugins.json or content.json)', 'plugins.json')
  .option('--dir <directory>', 'Default base install directory', 'Plugins')
  .action(async (name, opts) => {
    try {
      await update(name, opts);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
