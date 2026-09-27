#!/usr/bin/env node
// Used by install.ps1: declares the task-flow marketplace with autoUpdate on, and
// enables the plugin, in a Claude Code settings.json - without touching anything
// else in the file.
//
//   node enable-autoupdate.js <settings.json> <marketplace> <plugin@marketplace> <source>
//
// <source> is a GitHub "owner/repo", a git URL, or an existing local directory.
// The documented shape is extraKnownMarketplaces.<name> = { source, autoUpdate }
// (code.claude.com/docs/en/plugin-marketplaces).

const fs = require('fs');
const path = require('path');

function sourceFor(value) {
  if (fs.existsSync(value) && fs.statSync(value).isDirectory()) {
    return { source: 'directory', path: path.resolve(value) };
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return { source: 'github', repo: value };
  return { source: 'git', url: value };
}

function enableAutoUpdate({ settingsPath, marketplace, plugin, source }) {
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    // Tolerate a BOM: PowerShell 5.1's Out-File -Encoding utf8 writes one.
    const text = fs.readFileSync(settingsPath, 'utf8').replace(/^﻿/, '');
    // A settings file that does not parse is left alone: overwriting it would
    // lose whatever the user had in it.
    settings = text.trim() ? JSON.parse(text) : {};
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${settingsPath} does not hold a JSON object`);
  }
  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};
  settings.extraKnownMarketplaces[marketplace] = { source: sourceFor(source), autoUpdate: true };
  settings.enabledPlugins = settings.enabledPlugins || {};
  settings.enabledPlugins[plugin] = true;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return settings;
}

module.exports = { enableAutoUpdate, sourceFor };

if (require.main === module) {
  const [settingsPath, marketplace, plugin, source] = process.argv.slice(2);
  if (!settingsPath || !marketplace || !plugin || !source) {
    process.stderr.write('usage: enable-autoupdate.js <settings.json> <marketplace> <plugin> <source>\n');
    process.exit(2);
  }
  try {
    enableAutoUpdate({ settingsPath, marketplace, plugin, source });
  } catch (error) {
    process.stderr.write(`enable-autoupdate: ${error.message}\n`);
    process.exit(1);
  }
}
