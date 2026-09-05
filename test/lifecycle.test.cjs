'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setup, pe, consent, cleanScan } = require('./helpers.cjs');
const { scanGame } = require('../src/core/scanner.cjs');
const { digestFile, sha256 } = require('../src/core/safety.cjs');
const { retainedEnvironment, uninstallSummary } = require('../src/core/uninstall.cjs');
const { preferredPackage, versionKey } = require('../src/core/versions.cjs');
const { guessVersion } = require('../src/core/packages.cjs');
const accepts = plan => ({ ...consent, downgrade: true, riskCodes: plan.riskWarnings.map(w => w.code) });

async function managedHost(t) {
  const ctx = await setup(t);
  // Isolated synthetic evidence in this test process, never written into a release catalog.
  const loader = pe(5), hash = sha256(loader), evidence = require('../config/loader-evidence.json');
  evidence.push({ componentId: 'reshade', architecture: 'x64', sha256: hash, version: 'test-only' });
  t.after(() => evidence.splice(evidence.findIndex(x => x.sha256 === hash), 1));
  const file = path.join(ctx.sourceRoot, 'runtime.bin'); await fs.writeFile(file, loader);
  const pkg = await ctx.add('0.3.3.4');
  const install = await ctx.engine.preview(ctx.game.id, pkg.id, 'install', { loader: { name: 'dxgi.dll', role: 'reshade-loader', source: file, after: hash, version: 'test-only' } });
  await ctx.engine.apply(install.id, accepts(install));
  ctx.engine.deps.scan = async g => {
    const r = await cleanScan(g); r.addonConfig = { state: 'default' }; r.riskWarnings = [];
    for (const name of await fs.readdir(ctx.gameRoot)) if (/\.(addon64|dll|ini)$/i.test(name)) r.files.push({ name, path: path.join(ctx.gameRoot, name), sha256: await digestFile(path.join(ctx.gameRoot, name)), proxy: name === 'dxgi.dll' });
    return r;
  };
  return { ...ctx, loaderHash: hash };
}
test('uninstall inspection does not require an existing x64 EXE or a chosen API', async t => {
  const { engine, game } = await setup(t); await fs.unlink(game.exe); game.api = '';
  const un = await scanGame(game, engine.root, { purpose: 'uninstall' });
  assert.ok(!un.blockers.some(x => /x64|运行方式|启动器/.test(x)));
  const install = await scanGame(game, engine.root);
  assert.ok(install.blockers.some(x => /x64/.test(x))); assert.ok(install.blockers.some(x => /运行方式/.test(x)));
});
test('uninstall uses its inspection purpose at preview and apply, even if EXE vanishes after preview', async t => {
  const { engine, game, gameRoot, add } = await setup(t); const pkg = await add('0.3.3.4');
  let plan = await engine.preview(game.id, pkg.id); await engine.apply(plan.id, accepts(plan));
  const purposes = [];
  engine.deps.scan = async (g, root, options) => { purposes.push(options.purpose); const r = await cleanScan(g); if (options.purpose !== 'uninstall') r.blockers.push('test: invalid executable'); return r; };
  game.api = ''; await engine.save(); plan = await engine.preview(game.id, null, 'uninstall');
  await fs.unlink(game.exe); const result = await engine.apply(plan.id, accepts(plan));
  assert.deepEqual(purposes, ['uninstall', 'uninstall']); assert.equal(game.installed, null);
  assert.equal(await digestFile(path.join(gameRoot, 'nr.addon64')), null); assert.deepEqual(result.uninstall.removed, ['nr.addon64']);
});
test('uninstall inspection still rejects an out-of-root EXE path', async t => {
  const { engine, game, root } = await setup(t); const outside = path.join(root, 'foreign.exe'); await fs.writeFile(outside, pe(1, false));
  game.exe = outside; await assert.rejects(scanGame(game, engine.root, { purpose: 'uninstall' }), e => e.code === 'EXE_REQUIRED');
});
test('new unrelated addon preserves a shared manager-created host while uninstall removes our addon', async t => {
  const { engine, game, gameRoot, loaderHash } = await managedHost(t);
  const other = path.join(gameRoot, 'OtherTool.addon64'); await fs.writeFile(other, pe(6));
  const p = await engine.preview(game.id, null, 'uninstall');
  assert.deepEqual(p.retainedEnvironment.map(f => f.name), ['dxgi.dll']); assert.equal(p.blockers.length, 0);
  assert.ok(p.riskWarnings.some(w => w.code === 'SHARED_ENVIRONMENT'));
  const r = await engine.apply(p.id, accepts(p));
  assert.equal(await digestFile(path.join(gameRoot, 'nr.addon64')), null);
  assert.equal(await digestFile(path.join(gameRoot, 'dxgi.dll')), loaderHash);
  assert.equal(await digestFile(other), sha256(pe(6))); assert.equal(game.installed, null);
  assert.deepEqual(r.uninstall.kept, ['dxgi.dll']);
  const journal = (await engine.history(game.id))[0]; assert.equal(journal.retainedEnvironment[0].sha256, loaderHash);
  await engine.recover(game.id, journal.id); assert.ok(game.installed); assert.equal(await digestFile(other), sha256(pe(6)));
});
test('clean uninstallation removes a manager-created host when no other addon or ReShade settings exist', async t => {
  const { engine, game, gameRoot } = await managedHost(t);
  const p = await engine.preview(game.id, null, 'uninstall'); assert.deepEqual(p.retainedEnvironment, []);
  await engine.apply(p.id, accepts(p)); assert.equal(await digestFile(path.join(gameRoot, 'dxgi.dll')), null);
});
test('preset/configuration or incomplete/custom addon scope retains the host conservatively', () => {
  const root = path.resolve('game'), current = [{ name: 'dxgi.dll', role: 'reshade-loader', sha256: 'a'.repeat(64) }, { name: 'nvngx_dlssnr.dll', role: 'nr-runtime', sha256: 'b'.repeat(64) }];
  for (const r of [{ files: [{ path: path.join(root, 'ReShade.ini'), name: 'ReShade.ini' }] }, { addonConfig: { state: 'custom' } }, { riskWarnings: [{ code: 'SCAN_PARTIAL' }] }]) {
    const kept = retainedEnvironment(current, { targetRoot: root, files: [], ...r }); assert.ok(kept.some(f => f.name === 'dxgi.dll'));
  }
});
test('new addon after uninstall preview invalidates consent before any file is removed', async t => {
  const { engine, game, gameRoot } = await managedHost(t); const p = await engine.preview(game.id, null, 'uninstall');
  await fs.writeFile(path.join(gameRoot, 'NewTool.addon64'), pe(6));
  await assert.rejects(engine.apply(p.id, accepts(p)), e => ['RISK_CHANGED', 'UNINSTALL_CHANGED'].includes(e.code));
  assert.equal(await digestFile(path.join(gameRoot, 'nr.addon64')), sha256(pe(1)));
});
test('recovery cannot reclaim a shared host changed by another tool after uninstall', async t => {
  const { engine, game, gameRoot } = await managedHost(t); await fs.writeFile(path.join(gameRoot, 'Other.addon64'), pe(6));
  const p = await engine.preview(game.id, null, 'uninstall'); const r = await engine.apply(p.id, accepts(p));
  await fs.writeFile(path.join(gameRoot, 'dxgi.dll'), pe(8));
  await assert.rejects(engine.recover(game.id, r.transactionId), e => e.code === 'EXTERNAL_CHANGE');
  assert.equal(await digestFile(path.join(gameRoot, 'nr.addon64')), null); assert.equal(game.installed, null);
});
test('restoring a prior manually installed addon is not labelled factory original or clean removal', async t => {
  const { engine, game, gameRoot, add } = await setup(t); const original = pe(3); await fs.writeFile(path.join(gameRoot, 'nr.addon64'), original);
  const pkg = await add('0.3.3.4'); const p = await engine.preview(game.id, pkg.id); await engine.apply(p.id, accepts(p));
  const un = await engine.preview(game.id, null, 'uninstall'); const s = uninstallSummary(un);
  assert.deepEqual(s.restored, ['nr.addon64']); assert.match(s.detail, /并非游戏出厂/);
  await engine.apply(un.id, accepts(un)); assert.deepEqual(await fs.readFile(path.join(gameRoot, 'nr.addon64')), original);
});
test('default A/B matches only requested stable and beta; explicit future selection remains supported', () => {
  const packages = ['0.3.3.4', '0.4.1beta-r3', '0.4.2beta', '0.4.1-beta'].map((v, id) => ({ id: String(id), manifest: { version: v } }));
  assert.equal(preferredPackage(packages, {}, 'A').id, '0'); assert.equal(preferredPackage(packages, {}, 'B').id, '3');
  assert.equal(preferredPackage(packages.slice(0, 3), {}, 'B'), undefined);
  assert.equal(preferredPackage(packages, { ab: { B: '2' } }, 'B').id, '2');
  assert.equal(preferredPackage(packages, { installed: { packageId: '1' } }).id, '1');
  assert.equal(versionKey('beta0.4.1'), '0.4.1beta'); assert.notEqual(versionKey('beta0.4.1-r3'), '0.4.1beta');
});
test('filename hints retain beta and revision instead of mislabelling beta0.4.1-r3 as stable 0.4.1', () => {
  assert.equal(guessVersion('DLSS5-beta0.4.1-r3-zh-CN.addon64'), '0.4.1beta-r3');
  assert.equal(guessVersion('DLSS5-beta0.4.1-Chinese.addon64'), '0.4.1beta');
  assert.equal(guessVersion('DLSS5-0.3.3.4-Chinese.addon64'), '0.3.3.4');
  assert.equal(guessVersion('unknown.addon64'), null); assert.equal(guessVersion('0.1.2.3.4.addon64'), null);
});


test('rolling back the original installation cannot remove a host subsequently shared by another addon', async t => {
  const { engine, game, gameRoot, loaderHash } = await managedHost(t);
  const install = (await engine.history(game.id))[0];
  await fs.writeFile(path.join(gameRoot, 'OtherTool.addon64'), pe(6));
  await assert.rejects(engine.recover(game.id, install.id), e => e.code === 'SHARED_ENVIRONMENT');
  assert.equal(await digestFile(path.join(gameRoot, 'dxgi.dll')), loaderHash);
  const un = await engine.preview(game.id, null, 'uninstall'); await engine.apply(un.id, accepts(un));
  assert.equal(game.installed, null); assert.equal(await digestFile(path.join(gameRoot, 'dxgi.dll')), loaderHash);
});
