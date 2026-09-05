'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { component } = require('./next-helpers.cjs');
const { pe, temp } = require('./helpers.cjs');
const { validateComponent, installManifest, componentForPackage, componentBlockers, compareVersions, changeKind } = require('../src/core/components.cjs');
const { importPackage, writeZip, canonical, validateManifest } = require('../src/core/packages.cjs');
const { loaderStatus } = require('../src/core/loader.cjs');
const pkg = c => ({ componentManifest: c, manifest: installManifest(c) });
const report = () => ({ files: [], componentEvidence: [] });
test('v2 declares identity, channel, exact sizes and independent recovery protocol', () => {
  const c = component(); assert.equal(validateComponent(c), c); assert.equal(componentForPackage(pkg(c)), c);
  assert.equal(installManifest(c).files[0].size, 1024);
});
for (const [name, modify] of [
  ['schema version', c => c.schemaVersion = 3], ['component identity', c => c.componentId = 'reshade'],
  ['unknown constraint', c => c.allowUnknownFiles = true], ['manager bounds', c => c.managerMaxVersion = '0.1.0'],
  ['rollback protocol', c => c.rollbackProtocol = 'execute-script'], ['missing dependency array', c => delete c.dependencies],
  ['unknown API', c => c.supportedApis = ['DX9']], ['duplicate API', c => c.supportedApis = ['DX12', 'DX12']],
  ['architecture', c => c.architectures = ['x86']], ['missing license', c => delete c.license],
  ['unknown channel', c => c.channel = 'trusted'], ['proxy path', c => c.files[0].path = 'dxgi.dll'],
  ['negative size', c => c.files[0].size = -1], ['too large file', c => c.files[0].size = 2 ** 30],
  ['network credentials', c => c.source.url = 'https://user:password@example.org/'],
  ['unknown dependency', c => c.dependencies = [{ componentId: 'unknown', capabilities: [] }]],
  ['duplicated dependency', c => c.dependencies = [{ componentId: 'reshade', capabilities: [] }, { componentId: 'reshade', capabilities: [] }]],
  ['ambiguous conflict', c => c.conflicts = [{ componentId: 'dxvk', fileName: 'dxgi.dll' }]],
  ['traversal conflict', c => c.conflicts = [{ fileName: '../file.dll' }]]
]) test(`invalid ${name} fails closed`, () => { const c = component(); modify(c); assert.throws(() => validateComponent(c)); });
test('version comparisons support legacy NR spellings and prerelease ordering', () => {
  for (const [a, b, expected] of [['0.3.3.4', '0.3.8beta', -1], ['0.4.2beta', '0.4.2', -1], ['0.2.0-beta.10', '0.2.0-beta.2', 1], ['0.2.0', '0.2.0-beta.1', 1], ['0.4.2beta', '0.4.2-beta', 0], ['0.3.3.4', '0.3.3', 1]]) assert.equal(compareVersions(a, b), expected);
  assert.equal(compareVersions('1.invalid', '0.2'), null);
  assert.equal(changeKind('0.4.2beta', '0.3.3.4', false), 'downgrade');
  assert.equal(changeKind('0.4.2beta', '0.4.2beta', false), 'rebuild');
});
test('package source=official is metadata, not a trusted dependency or publisher', () => {
  const good = component(); good.source = { kind: 'official', url: 'https://example.org/plugin' };
  good.dependencies = [{ componentId: 'reshade', minVersion: '6.8.0', capabilities: ['addon-support'] }];
  const r = report(); assert.equal(componentBlockers(pkg(good), r, '0.2.0-beta.1').length, 1);
  r.componentEvidence = [{ componentId: 'reshade', version: '6.8.0', capabilities: ['addon-support'], verified: false }];
  assert.equal(componentBlockers(pkg(good), r, '0.2.0-beta.1').length, 1);
  r.componentEvidence[0].verified = true; assert.equal(componentBlockers(pkg(good), r, '0.2.0-beta.1').length, 0);
  r.componentEvidence[0].capabilities = []; assert.equal(componentBlockers(pkg(good), r, '0.2.0-beta.1').length, 1);
});
test('manager bounds and file or component conflicts are checked independently', () => {
  const c = component(); c.managerMaxVersion = '0.2.0-beta.3';
  c.conflicts = [{ fileName: 'dxgi.dll' }, { componentId: 'dxvk' }];
  const r = report(); r.files = [{ name: 'dxgi.dll', componentId: 'dxvk' }];
  assert.equal(componentBlockers(pkg(c), r, '0.3.0').length, 3);
  assert.equal(componentBlockers(pkg(c), report(), '0.1.0').length, 1);
});
test('component identity and installation view must agree', () => {
  const p = pkg(component()); p.manifest.files[0].sha256 = 'a'.repeat(64);
  assert.throws(() => componentForPackage(p), e => e.code === 'COMPONENT_MISMATCH');
});
test('legacy schema cannot silently swallow v2 constraints', () => {
  const m = installManifest(component()); m.dependencies = [];
  assert.throws(() => validateManifest(m), e => e.code === 'MANIFEST_INVALID');
});
test('signed v2 verifies original manifest; size lies are rejected before cache writes', async t => {
  const root = await temp(t), file = path.join(root, 'package.zip'), c = component();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const keys = { test: publicKey.export({ type: 'spki', format: 'pem' }) };
  const write = async (value, signature) => fs.writeFile(file, writeZip([['manifest.json', Buffer.from(JSON.stringify({ manifest: value, keyId: 'test', signature }))], ['nr.addon64', pe(1)]]));
  const sig = crypto.sign(null, Buffer.from(canonical(c)), privateKey).toString('base64');
  await write(c, sig); const p = await importPackage(file, {}, path.join(root, 'cache'), keys);
  assert.equal(p.trust, 'publisher-verified'); assert.equal(p.componentManifest.schemaVersion, 2);
  assert.equal(componentForPackage(p).componentId, 'nr-before-sr');
  c.channel = 'stable'; await write(c, sig);
  await assert.rejects(importPackage(file, {}, path.join(root, 'cache'), keys), e => e.code === 'SIGNATURE_INVALID');
  c.files[0].size++; const newSig = crypto.sign(null, Buffer.from(canonical(c)), privateKey).toString('base64');
  await write(c, newSig); await assert.rejects(importPackage(file, {}, path.join(root, 'cache'), keys), e => e.code === 'PAYLOAD_INVALID');
});
test('ReShade product strings do not establish full addon capability', () => {
  const root = path.resolve('fixture'), files = [{ path: path.join(root, 'dxgi.dll'), name: 'dxgi.dll', proxy: true, arch: 'x64', source: 'ReShade', sha256: 'a'.repeat(64), version: '6.8.0' }];
  assert.equal(loaderStatus(files, root).addonSupport, 'unknown');
  const metadata = [{ sha256: files[0].sha256, architecture: 'x64', componentId: 'reshade', version: '6.8.0', flavor: 'full-addon' }];
  assert.equal(loaderStatus(files, root, metadata).addonSupport, 'yes');
  metadata[0].flavor = 'standard'; assert.equal(loaderStatus(files, root, metadata).addonSupport, 'no');
  assert.equal(loaderStatus([...files, { ...files[0], name: 'd3d11.dll', path: path.join(root, 'd3d11.dll') }], root, metadata).addonSupport, 'unknown');
  assert.equal(loaderStatus([], root).state, 'absent');
});
