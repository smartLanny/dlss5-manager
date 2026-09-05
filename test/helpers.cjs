'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Engine } = require('../src/core/engine.cjs');
const { importPackage } = require('../src/core/packages.cjs');
function pe(seed = 1, dll = true, x64 = true) {
  const b = Buffer.alloc(1024); b.write('MZ'); b.writeUInt32LE(128, 60); b.writeUInt32LE(0x4550, 128); b.writeUInt16LE(x64 ? 0x8664 : 0x14c, 132); b.writeUInt16LE(1, 134); b.writeUInt16LE(240, 148); b.writeUInt16LE(dll ? 0x2022 : 0x22, 150); b.writeUInt16LE(x64 ? 0x20b : 0x10b, 152); const s = 392; b.write('.text', s); b.writeUInt32LE(512, s + 8); b.writeUInt32LE(0x1000, s + 12); b.writeUInt32LE(512, s + 16); b.writeUInt32LE(512, s + 20); b.fill(seed, 512); return b;
}
async function temp(t) {
  const parent = path.resolve('test-results', 'unit'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'case-')));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
const cleanEnvironment = async () => ({ verified: true, running: [], antiCheat: [] });
const cleanScan = async g => ({ blockers: [], files: [], exe: { valid: true, arch: 'x64', apis: ['DX12'] }, targetRoot: path.dirname(g.exe), scanRoot: g.scanRoot, antiCheat: [], environment: await cleanEnvironment(), warnings: [], scannedAt: new Date().toISOString() });
async function setup(t, deps = {}) {
  const root = await temp(t), gameRoot = path.join(root, 'game'), sourceRoot = path.join(root, 'source');
  await fs.mkdir(gameRoot); await fs.mkdir(sourceRoot);
  const exe = path.join(gameRoot, 'Game.exe'); await fs.writeFile(exe, pe(9, false));
  const dependencies = { scan: cleanScan, environment: cleanEnvironment, locks: async () => {}, ...deps };
  const engine = await new Engine(path.join(root, 'manager'), dependencies).init();
  const game = { id: crypto.randomUUID(), name: '测试游戏', scanRoot: gameRoot, exe, api: 'DX12', kind: 'offline', environmentConfirmed: true, candidates: [], installed: null };
  engine.state.games.push(game); await engine.save();
  const add = async (version, seed = 1, name = 'nr.addon64') => {
    const file = path.join(sourceRoot, name); await fs.writeFile(file, pe(seed));
    const pkg = await importPackage(file, { version, api: 'DX12', acceptLocal: true, expectedHash: '' }, path.join(engine.root, 'packages'));
    engine.state.packages.push(pkg); await engine.save(); return pkg;
  };
  return { root, gameRoot, sourceRoot, engine, game, add, dependencies };
}
const consent = { confirm: true, compatibility: true, adoptNames: ['nr.addon64', 'nvngx_dlssnr.dll'] };
module.exports = { pe, temp, setup, cleanScan, cleanEnvironment, consent };
