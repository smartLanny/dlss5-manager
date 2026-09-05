'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha256 } = require('../src/core/safety.cjs');
const { setup, pe, consent } = require('./helpers.cjs');

test('empty transaction directory from interrupted mkdir does not brick startup', async t => {
  const { engine } = await setup(t);
  const id = crypto.randomUUID(); await fs.mkdir(engine.txDir(id), { recursive: true });
  assert.deepEqual(await engine.history(), []);
  await fs.writeFile(path.join(engine.txDir(id), '0.bin'), pe());
  await assert.rejects(engine.history(), e => e.code === 'JOURNAL_INVALID');
});
test('two-file failure restores addon and runtime together to exact baselines', async t => {
  const { engine, game, gameRoot, add } = await setup(t, { afterWrite: async i => { if (i === 1) throw new Error('injected second-file failure'); } });
  const pkg = await add('0.4.2beta', 1), runtime = pe(2);
  pkg.manifest.files.push({ path: 'nvngx_dlssnr.dll', role: 'nr-runtime', sha256: sha256(runtime) });
  await fs.writeFile(path.join(engine.root, 'packages', pkg.id, 'nvngx_dlssnr.dll'), runtime); await engine.save();
  await fs.writeFile(path.join(gameRoot, 'nr.addon64'), pe(8));
  await fs.writeFile(path.join(gameRoot, 'nvngx_dlssnr.dll'), pe(9));
  await assert.rejects(engine.apply((await engine.preview(game.id, pkg.id)).id, consent));
  assert.deepEqual(await fs.readFile(path.join(gameRoot, 'nr.addon64')), pe(8));
  assert.deepEqual(await fs.readFile(path.join(gameRoot, 'nvngx_dlssnr.dll')), pe(9));
  assert.equal((await engine.history())[0].status, 'reverted');
  assert.equal(game.installed, null);
});
test('rollback waits rather than touching files if game launches during a failed update', async t => {
  const { engine, game, gameRoot, add } = await setup(t);
  const pkg = await add('0.4.2beta', 1);
  engine.deps.afterWrite = async () => {
    engine.deps.environment = async () => ({ verified: true, running: ['DemoGame'], antiCheat: [] });
    throw new Error('injected update failure');
  };
  await assert.rejects(engine.apply((await engine.preview(game.id, pkg.id)).id, consent), e => e.code === 'RECOVERY_NEEDED');
  assert.deepEqual(await fs.readFile(path.join(gameRoot, 'nr.addon64')), pe(1));
  const history = await engine.history(); assert.equal(history[0].status, 'recovery-needed');
  engine.deps.environment = async () => ({ verified: true, running: [], antiCheat: [] });
  await engine.recover(game.id, history[0].id);
  await assert.rejects(fs.stat(path.join(gameRoot, 'nr.addon64')), { code: 'ENOENT' });
});
