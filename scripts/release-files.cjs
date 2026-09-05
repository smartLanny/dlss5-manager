'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { listPackage } = require('@electron/asar');
const { digestFile, leaf } = require('../src/core/safety.cjs');
const { readZip } = require('../src/core/packages.cjs');

const normalize = value => String(value || '').toLowerCase().replace(/-r(?=\d)/g, 'r');
async function main() {
  const offline = process.argv.includes('--offline');
  const packed = path.join('dist', 'win-unpacked', 'resources', 'app.asar');
  const entries = listPackage(packed).map(x => x.replace(/\\/g, '/'));
  for (const required of ['/src/main.cjs', '/src/preload.cjs', '/src/core/engine.cjs', '/src/ui/index.html', '/NOTICE.md', '/LICENSE']) if (!entries.includes(required)) throw new Error(`Missing required application file: ${required}`);
  for (const entry of entries) if (/\.(dll|exe|addon64|addon32|pdb|key|pem|dlss5pkg)$/i.test(entry) || /^\/(test|scripts|docs|node_modules)(\/|$)/.test(entry)) throw new Error(`Forbidden payload in app archive: ${entry}`);
  const distFiles = (await fs.readdir('dist')).filter(x => /-(Setup|Portable|Offline-Full-Portable)\.exe$/i.test(x));
  if (!distFiles.some(x => /-Setup\.exe$/i.test(x)) || !distFiles.some(x => /-Portable\.exe$/i.test(x))) throw new Error('Both setup and portable EXEs must exist.');
  if (offline && !distFiles.some(x => /-Offline-Full-Portable\.exe$/i.test(x))) throw new Error('Offline full portable EXE is missing.');
  const assets = [];
  for (const name of distFiles) { const file = path.join('dist', name); assets.push({ name, bytes: (await fs.stat(file)).size, sha256: await digestFile(file) }); }
  const componentDir = path.join('dist', 'win-unpacked', 'resources', 'components');
  const catalog = JSON.parse(await fs.readFile(path.join(componentDir, 'catalog.json'), 'utf8'));
  if (catalog.schema !== 2 || !Array.isArray(catalog.packages) || !catalog.runtimeProfiles || !catalog.reshade) throw new Error('Invalid bundled catalog.');
  const expected = new Set(['catalog.json']), components = [], bundledVersions = new Set();
  for (const item of catalog.packages) {
    const name = leaf(item.file); expected.add(name);
    const file = path.join(componentDir, name); if (await digestFile(file) !== item.sha256) throw new Error(`Bundled component does not match publisher inventory: ${name}`);
    const zip = readZip(await fs.readFile(file), { maxEntries: 64, minEntries: 1 }); const record = zip.get('manifest.json'); if (!record) throw new Error(`Component manifest missing: ${name}`);
    const manifest = JSON.parse(record.bytes.toString('utf8')).manifest; if (!manifest || !manifest.files?.some(f => f.role === 'addon')) throw new Error(`Addon missing from bundled component: ${name}`);
    bundledVersions.add(normalize(item.version || manifest.version)); components.push({ file: name, version: item.version || manifest.version, language: item.language || 'zh-CN', sha256: item.sha256, bytes: (await fs.stat(file)).size });
  }
  if (!offline) for (const required of ['0.3.3.4', '0.4.1r2', '0.4.3r3']) if (!bundledVersions.has(required)) throw new Error(`Public release must bundle the real ${required} addon; build stopped.`);
  if ((await fs.readdir(componentDir)).some(n => !expected.has(n))) throw new Error('Unexpected external component payload.');
  const runtimeModes = Object.fromEntries(Object.entries(catalog.runtimeProfiles).map(([k, v]) => [k, v.mode || (v.bundleFile ? 'bundled' : 'online')]));
  const inventory = { manager: '装机宅 DLSS5 安装器', version: require('../package.json').version, target: 'Windows x64', channel: 'prerelease', packageMode: catalog.packageMode || 'online', addonBundled: catalog.packages.length > 0, bundledVersions: [...bundledVersions], components, runtimeModes, reshade: catalog.reshade, authenticode: 'not-configured', builtFrom: process.env.GITHUB_SHA || 'local-build', applicationFiles: entries, assets, validation: { archiveBoundary: 'passed', sourceAndCoreTests: 'required-by-workflow', windowsUiPlayerPath: 'required-by-workflow', realGameCompatibility: '待验证', actualGpuRendering: '待验证' } };
  await fs.writeFile('dist/RELEASE-CONTENTS.json', JSON.stringify(inventory, null, 2));
  await fs.writeFile('dist/COMPONENTS.json', JSON.stringify({ schema: 2, mode: inventory.packageMode, packages: components, runtimeProfiles: Object.fromEntries(Object.entries(catalog.runtimeProfiles).map(([k, v]) => [k, { id: v.id, version: v.version, mode: runtimeModes[k], archiveSha256: v.archiveSha256, bundleSha256: v.bundleSha256 || null, experimental: !!v.experimental }])), reshade: { version: catalog.reshade.version, mode: catalog.reshade.mode } }, null, 2));
  await fs.writeFile('dist/SHA256SUMS.txt', assets.map(x => `${x.sha256}  ${x.name}`).join('\n') + '\n');
  console.log(JSON.stringify({ archiveBoundary: 'passed', addonBundled: catalog.packages.length > 0, bundledVersions: [...bundledVersions], files: entries.length, assets }, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
