'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { digestFile } = require('../src/core/safety.cjs');
async function main() {
  const { listPackage } = await import('@electron/asar');
  const packed = path.join('dist', 'win-unpacked', 'resources', 'app.asar');
  const entries = listPackage(packed).map(x => x.replace(/\\/g, '/'));
  for (const required of ['/src/main.cjs', '/src/preload.cjs', '/src/core/engine.cjs', '/src/ui/index.html', '/NOTICE.md', '/LICENSE']) {
    if (!entries.includes(required)) throw new Error(`Missing required application file: ${required}`);
  }
  for (const entry of entries) {
    if (/\.(dll|exe|addon64|addon32|pdb|key|pem|dlss5pkg)$/i.test(entry) || /^\/(test|scripts|docs|node_modules)(\/|$)/.test(entry)) throw new Error(`Forbidden payload in app archive: ${entry}`);
  }
  const files = (await fs.readdir('dist')).filter(x => /-(Setup|Portable)\.exe$/.test(x));
  if (files.length !== 2) throw new Error('Both setup and portable EXEs must exist.');
  const assets = [];
  for (const name of files) { const file = path.join('dist', name); assets.push({ name, bytes: (await fs.stat(file)).size, sha256: await digestFile(file) }); }
  const inventory = { manager: '装机宅 DLSS5 安装器', version: require('../package.json').version, target: 'Windows x64', channel: 'prerelease', addonBundled: false, nrRuntimeBundled: false, authenticode: 'not-configured', publisherKeys: Object.keys(require('../config/trusted-keys.json')), builtFrom: process.env.GITHUB_SHA || 'local-build', applicationFiles: entries, assets, validation: { archiveBoundary: 'passed', sourceAndCoreTests: 'required-by-workflow', windowsUiSyntheticInstallRollback: 'required-by-workflow', realGameCompatibility: '待验证' } };
  await fs.writeFile('dist/RELEASE-CONTENTS.json', JSON.stringify(inventory, null, 2));
  await fs.writeFile('dist/SHA256SUMS.txt', assets.map(x => `${x.sha256}  ${x.name}`).join('\n') + '\n');
  console.log(JSON.stringify({ archiveBoundary: 'passed', addonBundled: false, files: entries.length, assets }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
