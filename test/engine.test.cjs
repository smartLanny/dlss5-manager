'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Engine, allowedFile } = require('../src/core/engine.cjs');
const { sha256, atomicJson } = require('../src/core/safety.cjs');
const { setup, pe, consent } = require('./helpers.cjs');
const { component } = require('./next-helpers.cjs');
const { importPackage, writeZip } = require('../src/core/packages.cjs');
const code = expected => e => e.code === expected;

test('install, update, rollback, uninstall restore exact original bytes', async t => {
  const { engine, game, gameRoot, add } = await setup(t);
  const target = path.join(gameRoot, 'nr.addon64'), original = pe(7);
  await fs.writeFile(target, original); await fs.writeFile(path.join(gameRoot, 'player-save.dat'), 'do-not-touch');
  const a = await add('0.3.3.4', 1), b = await add('0.4.2beta', 2);
  const p1 = await engine.preview(game.id, a.id); assert.equal(p1.changes[0].adopt, true);
  const r1 = await engine.apply(p1.id, consent); assert.deepEqual(await fs.readFile(target), pe(1));
  const p2 = await engine.preview(game.id, b.id); assert.equal(p2.changes[0].adopt, false);
  const r2 = await engine.apply(p2.id, consent); assert.equal(game.installed.version, '0.4.2beta');
  await assert.rejects(engine.recover(game.id, r1.transactionId), code('RECOVERY_ORDER'));
  await engine.recover(game.id, r2.transactionId); assert.deepEqual(await fs.readFile(target), pe(1));
  assert.equal(game.installed.version, '0.3.3.4');
  await engine.apply((await engine.preview(game.id, null, 'uninstall')).id, consent);
  assert.deepEqual(await fs.readFile(target), original); assert.equal(game.installed, null);
  assert.equal(await fs.readFile(path.join(gameRoot, 'player-save.dat'), 'utf8'), 'do-not-touch');
});
test('new installation uninstall only removes owned file', async t => {
  const { engine, game, gameRoot, add } = await setup(t); const pkg = await add('0.3.3.4');
  await fs.writeFile(path.join(gameRoot, 'other.txt'), 'keep');
  await engine.apply((await engine.preview(game.id, pkg.id)).id, consent);
  await engine.apply((await engine.preview(game.id, null, 'uninstall')).id, consent);
  await assert.rejects(fs.stat(path.join(gameRoot, 'nr.addon64')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(gameRoot, 'other.txt'), 'utf8'), 'keep');
});
test('publisher v2 fixed config survives install and uninstall transaction', async t => {
  const { engine, game, gameRoot, root } = await setup(t);
  const addon = pe(1), runtime = pe(2), bridge = pe(3), config = Buffer.alloc(64, 0x20);
  const c = component(addon, { version: '0.4.1-r2', files: [
    { path: 'nr.addon64', role: 'addon', sha256: sha256(addon), size: addon.length },
    { path: 'nvngx_dlssnr.dll', role: 'nr-runtime', sha256: sha256(runtime), size: runtime.length },
    { path: 'nrchain_nvngx.dll', role: 'nr-bridge', sha256: sha256(bridge), size: bridge.length },
    { path: 'nr_before_sr.ini', role: 'nr-config', sha256: sha256(config), size: config.length }
  ] });
  const source = path.join(root, 'publisher.dlss5pkg');
  await fs.writeFile(source, writeZip([
    ['manifest.json', Buffer.from(JSON.stringify({ manifest: c }))],
    ['nr.addon64', addon], ['nvngx_dlssnr.dll', runtime], ['nrchain_nvngx.dll', bridge], ['nr_before_sr.ini', config]
  ]));
  const pkg = await importPackage(source, { acceptLocal: true }, path.join(engine.root, 'packages'));
  engine.state.packages.push(pkg); await engine.save();
  const plan = await engine.preview(game.id, pkg.id); assert.deepEqual(plan.changes.map(x => x.name), ['nr.addon64', 'nvngx_dlssnr.dll', 'nrchain_nvngx.dll', 'nr_before_sr.ini']);
  await engine.apply(plan.id, consent);
  for (const [name, bytes] of [['nr.addon64', addon], ['nvngx_dlssnr.dll', runtime], ['nrchain_nvngx.dll', bridge], ['nr_before_sr.ini', config]]) assert.deepEqual(await fs.readFile(path.join(gameRoot, name)), bytes);
  await engine.apply((await engine.preview(game.id, null, 'uninstall')).id, consent);
  for (const name of ['nr.addon64', 'nvngx_dlssnr.dll', 'nrchain_nvngx.dll', 'nr_before_sr.ini']) await assert.rejects(fs.stat(path.join(gameRoot, name)), { code: 'ENOENT' });
});
test('switching differently named addon reuses owned target, avoids duplicate loading', async t => {
  const { engine, game, gameRoot, add } = await setup(t);
  const a = await add('0.3.3.4', 1), b = await add('0.4.2beta', 2, 'new-name.addon64');
  await engine.apply((await engine.preview(game.id, a.id)).id, consent);
  const plan = await engine.preview(game.id, b.id); assert.equal(plan.changes[0].name, 'nr.addon64');
  await engine.apply(plan.id, consent);
  assert.deepEqual(await fs.readFile(path.join(gameRoot, 'nr.addon64')), pe(2));
  await assert.rejects(fs.stat(path.join(gameRoot, 'new-name.addon64')), { code: 'ENOENT' });
});
test('fault after writing triggers automatic rollback', async t => {
  const { engine, game, gameRoot, add } = await setup(t, { afterWrite: async () => { throw new Error('simulated power failure'); } });
  const target = path.join(gameRoot, 'nr.addon64'); await fs.writeFile(target, pe(8));
  const pkg = await add('0.4.2beta');
  await assert.rejects(engine.apply((await engine.preview(game.id, pkg.id)).id, consent));
  assert.deepEqual(await fs.readFile(target), pe(8)); assert.equal(game.installed, null);
  assert.equal((await engine.history())[0].status, 'reverted');
});
test('refuses unconfirmed foreign file adoption', async t => {
  const { engine, game, gameRoot, add } = await setup(t); const pkg = await add('0.3.3.4');
  await fs.writeFile(path.join(gameRoot, 'nr.addon64'), pe(9));
  await assert.rejects(engine.apply((await engine.preview(game.id, pkg.id)).id, { confirm: true, compatibility: true, adoptNames: [] }), code('ADOPTION_REQUIRED'));
  assert.deepEqual(await fs.readFile(path.join(gameRoot, 'nr.addon64')), pe(9));
});
test('refuses changes made between preview and commit', async t => {
  const { engine, game, gameRoot, add } = await setup(t); const pkg = await add('0.3.3.4');
  const plan = await engine.preview(game.id, pkg.id);
  await fs.writeFile(path.join(gameRoot, 'nr.addon64'), pe(3));
  await assert.rejects(engine.apply(plan.id, consent), code('FILE_CHANGED'));
  assert.deepEqual(await fs.readFile(path.join(gameRoot, 'nr.addon64')), pe(3));
});
test('rollback preserves user modifications after installation', async t => {
  const { engine, game, gameRoot, add } = await setup(t); const pkg = await add('0.3.3.4');
  const result = await engine.apply((await engine.preview(game.id, pkg.id)).id, consent);
  await fs.writeFile(path.join(gameRoot, 'nr.addon64'), pe(4));
  await assert.rejects(engine.recover(game.id, result.transactionId), code('EXTERNAL_CHANGE'));
  assert.deepEqual(await fs.readFile(path.join(gameRoot, 'nr.addon64')), pe(4));
});
test('tampered backup blocks rollback before modifying destination', async t => {
  const { engine, game, gameRoot, add } = await setup(t); const pkg = await add('0.3.3.4');
  const target = path.join(gameRoot, 'nr.addon64'); await fs.writeFile(target, pe(9));
  const result = await engine.apply((await engine.preview(game.id, pkg.id)).id, consent);
  await fs.writeFile(engine.backupPath({ tx: result.transactionId, index: 0 }), pe(8));
  await assert.rejects(engine.recover(game.id, result.transactionId), code('BACKUP_DAMAGED'));
  assert.deepEqual(await fs.readFile(target), pe(1));
});
test('process restart recovers applying journal from durable backups', async t => {
  const { engine, game, gameRoot, dependencies } = await setup(t);
  const txid = crypto.randomUUID(), before = pe(7), after = pe(3);
  await fs.mkdir(engine.txDir(txid), { recursive: true });
  await fs.writeFile(engine.backupPath({ tx: txid, index: 0 }), before);
  await fs.writeFile(path.join(gameRoot, 'nr.addon64'), after);
  await atomicJson(engine.journalPath(txid), { schema: 1, id: txid, gameId: game.id, root: gameRoot, operation: 'install', version: '0.4.2beta', createdAt: new Date().toISOString(), status: 'applying', beforeInstalled: null, afterInstalled: null, changes: [{ name: 'nr.addon64', before: sha256(before), after: sha256(after), role: 'addon', adopt: true }] });
  const fresh = await new Engine(engine.root, dependencies).init();
  assert.equal((await fresh.pending(game.id)).length, 1);
  await fresh.recover(game.id, txid);
  assert.deepEqual(await fs.readFile(path.join(gameRoot, 'nr.addon64')), before);
  await fresh.recover(game.id, txid); assert.equal((await fresh.pending(game.id)).length, 0);
});
test('safety gate is reevaluated after the preview', async t => {
  const { engine, game, add } = await setup(t); const pkg = await add('0.3.3.4');
  const plan = await engine.preview(game.id, pkg.id);
  engine.deps.scan = async () => ({ blockers: ['游戏正在运行'] });
  await assert.rejects(engine.apply(plan.id, consent), code('INSTALL_BLOCKED'));
  assert.equal((await engine.history()).length, 0);
});
test('file lock prevents all writes', async t => {
  const { engine, game, add } = await setup(t, { locks: async () => { const e = new Error('locked'); e.code = 'FILES_LOCKED'; throw e; } });
  const pkg = await add('0.3.3.4');
  await assert.rejects(engine.apply((await engine.preview(game.id, pkg.id)).id, consent), code('FILES_LOCKED'));
  assert.equal((await engine.history()).length, 0);
});
test('package cache tamper is caught before any game writes', async t => {
  const { engine, game, add } = await setup(t); const pkg = await add('0.3.3.4');
  await fs.writeFile(path.join(engine.root, 'packages', pkg.id, 'nr.addon64'), pe(6));
  await assert.rejects(engine.preview(game.id, pkg.id), code('CACHE_TAMPERED'));
});
test('expired and forged plan tokens are rejected', async t => {
  const { engine, game, add } = await setup(t); const pkg = await add('0.3.3.4');
  const p = await engine.preview(game.id, pkg.id); engine.plans.get(p.id).expires = 0;
  await assert.rejects(engine.apply(p.id, consent), code('PLAN_EXPIRED'));
  await assert.rejects(engine.apply(crypto.randomUUID(), consent), code('PLAN_EXPIRED'));
});
test('changing game settings invalidates an outstanding preview', async t => {
  const { engine, game, add } = await setup(t); const pkg = await add('0.3.3.4');
  const p = await engine.preview(game.id, pkg.id); game.api = 'DX11';
  await assert.rejects(engine.apply(p.id, consent), code('PLAN_CHANGED'));
});
test('legacy environment checkbox is not a gate but actual installation consent remains required', async t => {
  const { engine, game, add } = await setup(t); const pkg = await add('0.3.3.4');
  game.environmentConfirmed = false;
  const p = await engine.preview(game.id, pkg.id); assert.equal(p.blockers.length, 0);
  await assert.rejects(engine.apply(p.id, {confirm:true}), code('CONFIRM_REQUIRED'));
  game.environmentConfirmed = true;
  await assert.rejects(engine.apply((await engine.preview(game.id, pkg.id)).id, { confirm: true }), code('CONFIRM_REQUIRED'));
});
test('all proxy DLL names remain unconditionally protected', () => {
  for (const name of ['dxgi.dll', 'd3d12.dll', 'd3d11.dll', 'd3d9.dll', 'dinput8.dll', 'winmm.dll', 'version.dll', 'kernel32.dll', 'evil.exe']) assert.throws(() => allowedFile(name), code('PROTECTED_FILE'));
});
test('exported diagnostics omit usernames, game names, directories and file contents', async t => {
  const { engine, game, gameRoot, add } = await setup(t); const pkg = await add('0.3.3.4');
  await engine.apply((await engine.preview(game.id, pkg.id)).id, consent);
  const diagnostic = await engine.diagnostic();
  assert.ok(!diagnostic.includes(gameRoot)); assert.ok(!diagnostic.includes(game.name)); assert.ok(!diagnostic.includes('nr.addon64'));
  assert.ok(diagnostic.includes(pkg.sourceHash));
});
