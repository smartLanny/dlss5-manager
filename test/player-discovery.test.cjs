'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pe } = require('./helpers.cjs');
const { classifyGpuName, profileForFamily } = require('../src/core/gpu.cjs');
const { manifestExecutables, manualScanRoot } = require('../src/core/discovery.cjs');
const { detectGame } = require('../src/core/detection.cjs');
const { posterUrls, heroUrls } = require('../src/core/artwork.cjs');
const { artworkInfo } = require('../src/core/artwork.cjs');
const { RUNTIME_PROFILES } = require('../src/core/runtime.cjs');

test('GPU families select one fixed runtime profile and never guess unknown hardware', () => {
  assert.equal(classifyGpuName('NVIDIA GeForce RTX 5090'), 'RTX50');
  assert.equal(classifyGpuName('NVIDIA GeForce RTX 4080 Laptop GPU'), 'RTX40');
  assert.equal(classifyGpuName('NVIDIA GeForce RTX 3060 Ti'), 'RTX30');
  assert.equal(classifyGpuName('NVIDIA GeForce GTX 1080'), null);
  assert.equal(profileForFamily('RTX50'), 'rtx50');
  assert.equal(profileForFamily('RTX40'), 'rtx40');
  assert.equal(profileForFamily('RTX30'), 'rtx20-30');
  assert.equal(profileForFamily('unknown'), null);
  assert.equal(RUNTIME_PROFILES.rtx40.experimental, true);
  assert.equal(RUNTIME_PROFILES['rtx20-30'].experimental, true);
});

test('Steam launch hints discard helper programs and common Unreal roots become the game root', () => {
  assert.deepEqual(manifestExecutables({ launch: 'steam.exe', nested: { exe: 'bin/x64/Game.exe' }, helper: 'REDlauncher.exe' }), ['Game.exe']);
  assert.match(manualScanRoot('C:\\Games\\Sample\\Binaries\\Win64\\Sample-Win64-Shipping.exe'), /C:\\Games\\Sample$/);
  assert.match(manualScanRoot('C:\\Games\\Sample\\bin\\x64\\Sample.exe'), /C:\\Games\\Sample$/);
});

test('known DX12 layouts select the real game EXE even when binaries contain optional renderer strings', async t => {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'exe-discovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, folder, relative] of [['Cyberpunk 2077', 'Cyberpunk2077', 'bin/x64/Cyberpunk2077.exe'], ['Black Myth: Wukong', 'BlackMythWukong', 'b1/Binaries/Win64/b1-Win64-Shipping.exe'], ['Hogwarts Legacy', 'HogwartsLegacy', 'Phoenix/Binaries/Win64/HogwartsLegacy.exe']]) {
    const gameRoot = path.join(root, folder); const file = path.join(gameRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const bytes = pe(1, false); Buffer.from('D3D12CreateDevice').copy(bytes, 550); Buffer.from('D3D11CreateDevice').copy(bytes, 650); await fs.writeFile(file, bytes);
    const game = { id: '11111111-1111-4111-8111-111111111111', name, scanRoot: gameRoot, exe: '', api: '', launchExecutables: [], candidates: [] };
    await detectGame(game, path.join(root, 'manager'));
    assert.equal(game.api, 'DX12'); assert.equal(path.relative(gameRoot, game.exe).replace(/\\/g, '/'), relative);
  }
});

test('Steam artwork URLs are public, appid-bound portrait and hero variants', () => {
  assert.match(posterUrls('999999')[0], /library_600x900_2x\.jpg$/);
  assert.match(posterUrls('999999')[posterUrls('999999').length - 1], /header\.jpg$/);
  assert.match(heroUrls('999999')[0], /library_hero\.jpg$/);
  assert.match(heroUrls('999999')[heroUrls('999999').length - 1], /header\.jpg$/);
  assert.deepEqual(posterUrls('not-an-appid'), []);
});

test('existing Steam records enrich from the common 2x local cache and then reuse Manager cache', async t => {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'test-results', 'artwork-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const steamRoot = path.join(root, 'Steam'), local = path.join(steamRoot, 'appcache', 'librarycache');
  await fs.mkdir(local, { recursive: true });
  await fs.writeFile(path.join(local, '1091500_library_600x900_2x.jpg'), Buffer.from('steam-poster-2x'));
  const nativeImage = { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 600, height: 900 }), resize: () => ({ toJPEG: () => Buffer.from('normalized-poster') }) }) };
  const game = { id: '11111111-1111-4111-8111-111111111111', name: 'Cyberpunk 2077', steamId: '1091500', steamRoot };
  const first = await artworkInfo(game, path.join(root, 'userdata', 'manager-data'), nativeImage, false, 'portrait');
  assert.equal(first.source, 'steam-cache');
  assert.equal(first.cached, false);
  const second = await artworkInfo(game, path.join(root, 'userdata', 'manager-data'), nativeImage, false, 'portrait');
  assert.equal(second.cached, true);
  assert.deepEqual(second.bytes, Buffer.from('normalized-poster'));
});
