'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Engine } = require('../src/core/engine.cjs');
const { setup, consent } = require('./helpers.cjs');
const { digestFile } = require('../src/core/safety.cjs');
const accepts = p => ({ ...consent, downgrade: true, riskCodes: p.riskWarnings.map(w => w.code) });

test('lifecycle state is backed up once and durable before game writes; merely opening and previewing does not upgrade', async t => {
  const { engine, game, add, dependencies } = await setup(t);
  const a = await add('0.3.3.4'); const b = await add('0.4.1beta', 2);
  const old = await fs.readFile(engine.stateFile, 'utf8');
  await new Engine(engine.root, dependencies).init();
  const p = await engine.preview(game.id, a.id);
  assert.equal(await fs.readFile(engine.stateFile, 'utf8'), old);
  engine.deps.afterWrite = async () => assert.equal(JSON.parse(await fs.readFile(engine.stateFile, 'utf8')).schema, 4);
  await engine.apply(p.id, accepts(p));
  const folder = path.join(engine.root, 'metadata-backups');
  const snapshots = (await fs.readdir(folder)).filter(n => n.startsWith('state-before-lifecycle-'));
  assert.equal(snapshots.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder, snapshots[0]), 'utf8')), JSON.parse(old));
  const update = await engine.preview(game.id, b.id); await engine.apply(update.id, accepts(update));
  assert.equal((await fs.readdir(folder)).filter(n => n.startsWith('state-before-lifecycle-')).length, 1);
  const reopened = await new Engine(engine.root, dependencies).init();
  assert.equal(reopened.state.schema, 4);
  assert.equal([1, 2, 3].includes(reopened.state.schema), false, 'state is outside beta.2 supported schema range');
});

test('metadata backup failure stops the operation before creating a game transaction or writing a file', async t => {
  const { engine, game, gameRoot, add } = await setup(t); const a = await add('0.3.3.3');
  const old = await fs.readFile(engine.stateFile, 'utf8');
  await fs.writeFile(path.join(engine.root, 'metadata-backups'), 'occupied by a regular file');
  const p = await engine.preview(game.id, a.id);
  await assert.rejects(engine.apply(p.id, accepts(p)));
  assert.equal(await digestFile(path.join(gameRoot, 'nr.addon64')), null);
  assert.equal(await fs.readFile(engine.stateFile, 'utf8'), old);
  assert.equal(engine.state.schema, JSON.parse(old).schema);
  assert.equal((await engine.history()).length, 0);
});

test('restoring a legacy transaction also upgrades first, while an exact no-op does not', async t => {
  const { engine, game, add } = await setup(t); const a = await add('0.3.3.4');
  const p = await engine.preview(game.id, a.id); const tx = await engine.apply(p.id, accepts(p));
  // Model an older compatible transaction record without retained dependencies.
  engine.state.schema = 3; await engine.save();
  const p2 = await engine.preview(game.id, a.id); assert.equal(p2.noOp, true);
  await engine.apply(p2.id, accepts(p2)); assert.equal(engine.state.schema, 3);
  let observed;
  const restore = engine.restore.bind(engine);
  engine.restore = async (journal, g) => { await restore(journal, g); observed = JSON.parse(await fs.readFile(engine.stateFile, 'utf8')).schema; };
  await engine.recover(game.id, tx.transactionId);
  assert.equal(observed, 4); assert.equal(engine.state.schema, 4); assert.equal(game.installed, null);
});
