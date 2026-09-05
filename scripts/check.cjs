'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
const sources = ['src', 'scripts', 'test'].flatMap(walk);
for (const file of sources.filter(f => /\.(cjs|js)$/.test(f))) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
const forbidden = sources.filter(f => /\.(dll|addon64|addon32|pdb|exe|pem|key)$/i.test(f));
if (forbidden.length) throw new Error('Source tree contains forbidden binary or secret files.');
const config = require('../package.json');
if (!config.build.files.includes('NOTICE.md') || !config.build.files.includes('LICENSE')) throw new Error('Release notices missing.');
if (JSON.stringify(config.build.files).includes('test')) throw new Error('Tests must not ship in the application.');
console.log(`Syntax and release-boundary checks passed (${sources.length} source files).`);
