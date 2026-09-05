'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { setup, pe, consent, cleanScan } = require('./helpers.cjs');
const { component } = require('./next-helpers.cjs');
const { Engine } = require('../src/core/engine.cjs');
const { installManifest } = require('../src/core/components.cjs');
const { sha256 } = require('../src/core/safety.cjs');
test('install twice, upgrade, downgrade, uninstall preserves first original snapshot', async t => {
  const { engine, game, gameRoot, add } = await setup(t), target = path.join(gameRoot, 'nr.addon64');
  await fs.writeFile(target, pe(9)); const stable = await add('0.3.3.4', 1), beta = await add('0.4.2beta', 2);
  await engine.apply((await engine.preview(game.id, stable.id)).id, consent);
  const original = structuredClone(game.installed.files[0].baseline);
  const before = await fs.readFile(engine.stateFile); const historyCount = (await engine.history()).length;
  const noop = await engine.preview(game.id, stable.id); assert.equal(noop.noOp, true); assert.equal(noop.transition, 'verify');
  assert.equal((await engine.apply(noop.id, consent)).unchanged, true);
  assert.equal((await engine.history()).length, historyCount); assert.deepEqual(await fs.readFile(engine.stateFile), before);
  await engine.apply((await engine.preview(game.id, beta.id)).id, consent);
  const downgrade = await engine.preview(game.id, stable.id); assert.equal(downgrade.transition, 'downgrade');
  await assert.rejects(engine.apply(downgrade.id, consent), e => e.code === 'DOWNGRADE_CONFIRMATION');
  await engine.apply((await engine.preview(game.id, stable.id)).id, { ...consent, downgrade: true });
  assert.deepEqual(game.installed.files[0].baseline, original);
  await engine.apply((await engine.preview(game.id, null, 'uninstall')).id, consent);
  assert.deepEqual(await fs.readFile(target), pe(9));
});
test('same version with different bytes is an explicit rebuild, not a false no-op', async t => {
  const { engine, game, add } = await setup(t); const a = await add('0.4.2beta', 1), b = await add('0.4.2beta', 2);
  await engine.apply((await engine.preview(game.id, a.id)).id, consent);
  const plan = await engine.preview(game.id, b.id); assert.equal(plan.noOp, false); assert.equal(plan.transition, 'rebuild');
});
test('different game records cannot independently own the same target directory', async t => {
  const { engine, game, gameRoot, add } = await setup(t); const a = await add('0.3.3.4');
  await engine.apply((await engine.preview(game.id, a.id)).id, consent);
  const other = { ...game, id: crypto.randomUUID(), exe: path.join(gameRoot, 'Another.exe'), installed: null };
  engine.state.games.push(other);
  await assert.rejects(engine.preview(other.id, a.id), e => e.code === 'TARGET_ALREADY_MANAGED');
});
test('forged ownership and corrupted original backup block upgrades', async t => {
  const { engine, game, gameRoot, add } = await setup(t); const a = await add('0.3.3.4');
  await fs.writeFile(path.join(gameRoot, 'nr.addon64'), pe(9));
  await engine.apply((await engine.preview(game.id, a.id)).id, consent);
  const old = game.installed.version; game.installed.version = '9.9';
  await assert.rejects(engine.preview(game.id, a.id), e => e.code === 'OWNERSHIP_UNVERIFIED');
  game.installed.version = old;
  await fs.writeFile(engine.backupPath(game.installed.files[0].baseline), pe(7));
  await assert.rejects(engine.preview(game.id, a.id), e => e.code === 'BACKUP_DAMAGED');
});
test('v1 state is read without rewriting; v2 import snapshots metadata and blocks unsafe downgrade', async t => {
  const { engine, game, add, dependencies } = await setup(t); const a = await add('0.4.2beta');
  await engine.apply((await engine.preview(game.id, a.id)).id, consent);
  // Synthesize metadata written by the legacy v1 manager after installation.
  engine.state.schema = 1; await engine.save();
  const before = await fs.readFile(engine.stateFile);
  const fresh = await new Engine(engine.root, dependencies).init(); assert.deepEqual(await fs.readFile(engine.stateFile), before);
  const imported = fresh.state.packages[0]; imported.componentManifest = component(); imported.manifest = installManifest(imported.componentManifest);
  await fresh.save(); assert.equal(fresh.state.schema, 2);
  const entries = (await fs.readdir(path.join(engine.root, 'metadata-backups'))).filter(n => n.startsWith('state-v1-')); assert.equal(entries.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(engine.root, 'metadata-backups', entries[0]), 'utf8')), JSON.parse(before));
  const reopened = await new Engine(engine.root, dependencies).init(); assert.equal(reopened.state.schema, 2);
  assert.equal((await reopened.preview(game.id, imported.id)).noOp, true);
});
test('dependency evidence is rechecked at apply, not only at preview', async t => {
  const { engine, game, add } = await setup(t); const a = await add('0.4.2beta');
  a.componentManifest = component(); a.componentManifest.dependencies = [{ componentId: 'reshade', minVersion: '6.8', capabilities: ['addon-support'] }];
  a.manifest = installManifest(a.componentManifest); await engine.save();
  engine.deps.scan = async g => ({ ...await cleanScan(g), componentEvidence: [{ componentId: 'reshade', verified: true, version: '6.8.0', capabilities: ['addon-support'] }] });
  const plan = await engine.preview(game.id, a.id); assert.deepEqual(plan.blockers, []);
  engine.deps.scan = cleanScan;
  await assert.rejects(engine.apply(plan.id, consent), e => e.code === 'INSTALL_BLOCKED');
  assert.equal((await engine.history()).length, 0);
});
