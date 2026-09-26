'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pe, temp, setup } = require('./helpers.cjs');
const { scanGame } = require('../src/core/scanner.cjs');
const {
  loadCatalog, requirePin, matchRuntime, assertRuntimeMatches, packability, assertPackable,
  describeRuntime, packageRuntimePin, runtimeScanFields
} = require('../src/core/nr-runtime.cjs');
const { MAX_FILE } = require('../src/core/packages.cjs');
const HASH_4050 = '24f2d48e83ee636c8efc05056bbed61daf91bc35e490198485929ebd0d824dd2';
const HASH_2030 = '6dac1b40f0c87af84a8177b18c741e84fb0c914f204c9d87d95916b665ba3af8';
const HASH_4050_CANDIDATE = 'f95feb54137ea11979f9b4ec4f00afd84b5c98a5624d3388fbf6a87714a39fcc';
const HASH_2030_ZIP = '21ac9102fd98e147693925f76f773f5390a1003e782a8dfe210c8e737954e3fc';
function clone() { return structuredClone(require('../config/nr-runtimes.json')); }
function pack(args) {
  return spawnSync(process.execPath, ['scripts/pack-addon.cjs', ...args], { encoding: 'utf8', cwd: path.resolve('.') });
}

test('shipped catalog pins 2030 and 4050 as guest local unverified runtimes', () => {
  const catalog = loadCatalog();
  assert.equal(catalog.selection.mode, 'explicit');
  assert.equal(catalog.selection.autoDetectGpuFamily, false);
  assert.match(catalog.disclaimer, /guest/i);
  assert.match(catalog.disclaimer, /not official nvidia/i);
  assert.equal(JSON.stringify(catalog).includes('http'), false);
  const byId = Object.fromEntries(catalog.candidates.map(p => [p.id, p]));
  assert.equal(byId['4050'].file.size, 165840496);
  assert.equal(byId['4050'].file.sha256, HASH_4050);
  assert.equal(byId['4050'].gpuFamily, '40-50');
  assert.equal(byId['4050'].defaultForFamily, true);
  assert.equal(byId['4050'].origin, 'guest');
  assert.equal(byId['4050'].verification, 'unverified');
  assert.equal(byId['4050'].channel, 'local');
  assert.equal(byId['4050'].license.redistribution, 'not-declared');
  assert.equal(byId['2030'].file.size, 309671536);
  assert.equal(byId['2030'].file.sha256, HASH_2030);
  assert.equal(byId['2030'].gpuFamily, '20-30');
  assert.equal(byId['2030'].transport.sha256, HASH_2030_ZIP);
  assert.equal(byId['4050-candidate'].file.sha256, HASH_4050_CANDIDATE);
  assert.equal(byId['4050-candidate'].role, 'parked');
  assert.equal(byId['4050-candidate'].defaultForFamily, false);
  assert.ok(byId['2030'].file.size > MAX_FILE);
  assert.equal(packability(byId['4050']).packableInV1, true);
  assert.equal(packability(byId['2030']).packableInV1, false);
  assert.throws(() => assertPackable(byId['2030']), e => e.code === 'RUNTIME_TOO_LARGE');
  assert.match(describeRuntime(byId['4050-candidate']), /非默认/);
  assert.match(describeRuntime(byId['4050']), /非 NVIDIA 官方/);
  assert.doesNotMatch(describeRuntime(byId['4050']), /官方 NVIDIA 运行库/);
});

test('explicit runtime-id checks sha256 and refuses unknown or mismatched files', () => {
  const pin = requirePin('4050');
  assert.equal(matchRuntime({ sha256: HASH_4050, size: 165840496 }).id, '4050');
  assert.equal(matchRuntime({ sha256: HASH_2030 }).id, '2030');
  assert.equal(matchRuntime({ sha256: '0'.repeat(64) }), null);
  assert.throws(() => requirePin('missing'), e => e.code === 'RUNTIME_UNKNOWN');
  assert.throws(() => matchRuntime({ sha256: HASH_4050, size: 1 }), e => e.code === 'RUNTIME_MISMATCH');
  assert.throws(() => assertRuntimeMatches({ path: 'nvngx_dlssnr.dll', sha256: HASH_4050, size: 1 }, pin), e => e.code === 'RUNTIME_MISMATCH');
  assert.throws(() => assertRuntimeMatches({ path: 'other.dll', sha256: HASH_4050, size: 165840496 }, pin), e => e.code === 'RUNTIME_MISMATCH');
  assert.equal(packageRuntimePin({ files: [{ role: 'nr-runtime', sha256: HASH_2030, size: 309671536 }] }).id, '2030');
  assert.equal(packageRuntimePin({ files: [{ role: 'addon', sha256: HASH_4050 }] }), null);
  const fields = runtimeScanFields(requirePin('4050-candidate'));
  assert.equal(fields.ownership, 'known-third-party');
  assert.equal(fields.runtimePin.verification, 'unverified');
  assert.equal(fields.runtimePin.packableInV1, true);
  assert.match(fields.source, /4050 候选/);
});

for (const [name, mutate] of [
  ['nvidia claim', c => { c.disclaimer = 'Official NVIDIA runtime catalog'; }],
  ['download url', c => { c.candidates[0].notes = 'See https://example.invalid/runtime.dll'; }],
  ['parked default', c => { c.candidates.find(x => x.id === '4050-candidate').defaultForFamily = true; }],
  ['redistribution allowed', c => { c.candidates[0].license.redistribution = 'allowed'; }],
  ['auto gpu pick', c => { c.selection.autoDetectGpuFamily = true; }]
]) test(`catalog rejects ${name}`, () => {
  const c = clone(); mutate(c); assert.throws(() => loadCatalog(c), e => e.code === 'RUNTIME_CATALOG');
});

test('scan recognizes only hash-matched guest runtimes and does not invent NVIDIA origin', async t => {
  const { game, gameRoot, engine } = await setup(t);
  await fs.writeFile(path.join(gameRoot, 'nvngx_dlssnr.dll'), pe(3));
  const report = await scanGame(game, engine.root);
  const file = report.files.find(f => f.name === 'nvngx_dlssnr.dll');
  assert.equal(file.componentId, 'nr-runtime');
  assert.equal(file.runtimePin, undefined);
  assert.equal(file.source, '来源待确认');
  assert.doesNotMatch(JSON.stringify(file), /NVIDIA/);
});

test('pack:addon --runtime-id verifies pins and does not require a real guest DLL', async t => {
  const root = await temp(t);
  const addon = path.join(root, 'nr.addon64');
  const runtime = path.join(root, 'nvngx_dlssnr.dll');
  const out = path.join(root, 'out.dlss5pkg');
  await fs.writeFile(addon, pe(1));
  await fs.writeFile(runtime, pe(2));
  const mismatch = pack(['--addon', addon, '--runtime', runtime, '--runtime-id', '4050', '--version', '0.4.2beta', '--api', 'DX12', '--out', out]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /不一致|RUNTIME_MISMATCH/);
  const missing = pack(['--addon', addon, '--runtime-id', '4050', '--version', '0.4.2beta', '--api', 'DX12', '--out', out]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /必须同时提供/);
  const unknown = pack(['--addon', addon, '--runtime', runtime, '--runtime-id', '9999', '--version', '0.4.2beta', '--api', 'DX12', '--out', out]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /未登记/);
  const unlabeled = pack(['--addon', addon, '--runtime', runtime, '--version', '0.4.2beta', '--api', 'DX12', '--out', out]);
  assert.equal(unlabeled.status, 0, unlabeled.stderr);
  assert.equal(unlabeled.stdout.includes('NVIDIA 官方'), false);
});
