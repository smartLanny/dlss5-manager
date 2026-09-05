'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { leaf, noLinks, sha256, assertGameRoot } = require('../src/core/safety.cjs');
const { importPackage, readZip, writeZip, validateManifest, canonical } = require('../src/core/packages.cjs');
const { parseVdf, walk } = require('../src/core/discovery.cjs');
const { peInfo, AC, checkLocks, environment } = require('../src/core/platform.cjs');
const { scanGame } = require('../src/core/scanner.cjs');
const { pe, temp, setup } = require('./helpers.cjs');
const code = c => e => e.code === c;
function manifest(bytes = pe(1)) { return { schema: 1, component: 'nr-before-sr', architecture: 'x64', version: '0.4.2beta', apis: ['DX12'], files: [{ path: 'nr.addon64', role: 'addon', sha256: sha256(bytes) }] }; }
function bundle(m = manifest(), extra = {}) { return writeZip([['manifest.json', Buffer.from(JSON.stringify({ manifest: m, ...extra }))], ['nr.addon64', pe(1)]]); }

test('Windows path traversal, alternate streams, device names and ambiguous names rejected', () => {
  for (const n of ['../x.addon64', '..\\x.addon64', 'C:\\x.dll', '/x.dll', 'x.dll:stream', 'CON.dll', 'LPT1.addon64', 'x.dll ', 'x.dll.', '.hidden', 'x\0.dll', 'a/b']) assert.throws(() => leaf(n));
  assert.equal(leaf('装机宅.addon64'), '装机宅.addon64');
});
test('symlink and hardlink targets rejected', async t => {
  const root = await temp(t), target = path.join(root, 'real'); await fs.writeFile(target, 'safe');
  const hard = path.join(root, 'hard'); await fs.link(target, hard); await assert.rejects(noLinks(hard), code('LINK_BLOCKED')); await fs.unlink(hard);
  const link = path.join(root, 'link');
  try { await fs.symlink(target, link); } catch (e) { if (e.code === 'EPERM') { t.diagnostic('File symlink requires a Windows privilege; hardlink protection was verified.'); return; } throw e; }
  await assert.rejects(noLinks(link), code('LINK_BLOCKED'));
});
test('manager storage, filesystem roots and network roots cannot be game directories', async t => {
  const root = await temp(t), store = path.join(root, 'manager'); await fs.mkdir(store);
  await assert.rejects(assertGameRoot(store, store)); await assert.rejects(assertGameRoot(path.parse(root).root));
  await assert.rejects(assertGameRoot('\\\\server\\game'));
});
test('valid x64 PE and x86 architecture identified without executing the file', async t => {
  const root = await temp(t), x64 = path.join(root, 'game.exe'), x86 = path.join(root, 'other.exe');
  await fs.writeFile(x64, pe(1, false)); await fs.writeFile(x86, pe(1, false, false));
  assert.equal((await peInfo(x64)).arch, 'x64'); assert.equal((await peInfo(x86)).arch, 'x86');
  await fs.writeFile(x64, Buffer.from('not a PE')); assert.equal((await peInfo(x64)).valid, false);
});
test('unsigned package imports only with explicit source consent', async t => {
  const root = await temp(t), file = path.join(root, 'update.dlss5pkg'); await fs.writeFile(file, bundle());
  await assert.rejects(importPackage(file, { acceptLocal: false }, path.join(root, 'cache')), code('SOURCE_CONFIRMATION'));
  const p = await importPackage(file, { acceptLocal: true }, path.join(root, 'cache'));
  assert.equal(p.trust, 'local-unverified'); assert.equal(p.manifest.version, '0.4.2beta'); assert.equal(p.compatibility, '待验证');
});
test('hash mismatch and renamed x86 binaries cannot be imported as addons', async t => {
  const root = await temp(t), file = path.join(root, 'bad.addon64'); await fs.writeFile(file, pe(1, true, false));
  await assert.rejects(importPackage(file, { version: '1.0', api: 'DX12', acceptLocal: true, expectedHash: '0'.repeat(64) }, path.join(root, 'cache')), code('HASH_MISMATCH'));
  await assert.rejects(importPackage(file, { version: '1.0', api: 'DX12', acceptLocal: true }, path.join(root, 'cache')), code('PAYLOAD_INVALID'));
});
test('Ed25519 package signature validates independently from payload hash', async t => {
  const root = await temp(t), file = path.join(root, 'signed.dlss5pkg'), m = manifest();
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const key = publicKey.export({ type: 'spki', format: 'pem' });
  const signature = crypto.sign(null, Buffer.from(canonical(m)), privateKey).toString('base64');
  await fs.writeFile(file, bundle(m, { keyId: 'test-only', signature }));
  const p = await importPackage(file, {}, path.join(root, 'cache'), { 'test-only': key });
  assert.equal(p.trust, 'publisher-verified');
  await assert.rejects(importPackage(file, {}, path.join(root, 'cache'), {}), code('UNKNOWN_SIGNER'));
  await fs.writeFile(file, bundle({ ...m, version: '9.9' }, { keyId: 'test-only', signature }));
  await assert.rejects(importPackage(file, {}, path.join(root, 'cache'), { 'test-only': key }), code('SIGNATURE_INVALID'));
});
test('package manifest never permits graphics proxy or system DLL replacement', () => {
  const m = manifest(); m.files.push({ path: 'dxgi.dll', role: 'nr-runtime', sha256: 'a'.repeat(64) });
  assert.throws(() => validateManifest(m), code('PROTECTED_FILE'));
});
test('ZIP rejects duplicate names and corrupted payload CRC', () => {
  assert.throws(() => readZip(writeZip([['manifest.json', Buffer.from('{}')], ['manifest.json', Buffer.from('{}')]])), code('ZIP_DUPLICATE'));
  const b = bundle(); b[30 + Buffer.byteLength('manifest.json')] ^= 1;
  assert.throws(() => readZip(b), code('ZIP_CHECKSUM'));
});
test('ZIP extraction cannot escape its flat payload namespace', () => {
  const safe = 'nr.addon64', unsafe = '../evil.xx'; assert.equal(safe.length, unsafe.length);
  const b = writeZip([['manifest.json', Buffer.from('{}')], [safe, pe(1)]]);
  let p = -1; while ((p = b.indexOf(Buffer.from(safe), p + 1)) >= 0) Buffer.from(unsafe).copy(b, p);
  assert.throws(() => readZip(b), code('UNSAFE_NAME'));
});
test('ZIP enforces output limits before decompression', () => {
  const b = bundle(), central = b.readUInt32LE(b.length - 6);
  b.writeUInt32LE(0xffffffff, central + 24);
  assert.throws(() => readZip(b), code('ZIP_UNSUPPORTED'));
});
test('unlisted package payloads and payload hash mismatch are rejected', async t => {
  const root = await temp(t), file = path.join(root, 'update.dlss5pkg'), m = manifest();
  await fs.writeFile(file, writeZip([['manifest.json', Buffer.from(JSON.stringify({ manifest: m }))], ['nr.addon64', pe(1)], ['extra.txt', Buffer.from('unexpected')]]));
  await assert.rejects(importPackage(file, { acceptLocal: true }, path.join(root, 'cache')), code('EXTRA_PAYLOAD'));
  m.files[0].sha256 = 'a'.repeat(64); await fs.writeFile(file, bundle(m));
  await assert.rejects(importPackage(file, { acceptLocal: true }, path.join(root, 'cache')), code('PAYLOAD_INVALID'));
});
test('VDF parser handles escaped Windows paths and comments, rejects unbalanced structure', () => {
  const doc = parseVdf('"libraryfolders" { // note\n "0" { "path" "D:\\\\Steam Library" } }');
  assert.equal(doc.libraryfolders['0'].path, 'D:\\Steam Library');
  assert.throws(() => parseVdf('"libraryfolders" { "0" "x"'));
  assert.equal(Object.getPrototypeOf(parseVdf('"__proto__" "safe"')), null);
});
test('anti-cheat files create a blocking report, including nested directories', async t => {
  const { game, gameRoot, engine } = await setup(t);
  await fs.mkdir(path.join(gameRoot, 'EasyAntiCheat')); await fs.writeFile(path.join(gameRoot, 'EasyAntiCheat', 'EasyAntiCheat_EOS_Setup.exe'), pe(1, false));
  const report = await scanGame(game, engine.root);
  assert.ok(report.antiCheat.length > 0); assert.ok(report.blockers.some(b => b.includes('反作弊')));
  for (const n of ['EasyAntiCheat', 'BEService', 'BattlEye', 'xhunter', 'ACE-guard', 'AntiCheatExpert']) assert.ok(AC.test(n), n);
});
test('scan budget exhaustion is explicit, never a clean safety result', async t => {
  const root = await temp(t); for (let i = 0; i < 4; i++) await fs.writeFile(path.join(root, `${i}.txt`), 'x');
  assert.ok((await walk(root, { maxEntries: 2 })).problems.length);
});
test('known online Steam ID cannot be overridden to offline', async t => {
  const { game, engine } = await setup(t); game.steamId = '730'; game.kind = 'offline';
  const report = await scanGame(game, engine.root);
  assert.ok(report.blockers.some(b => b.includes('修改分类不能解除')));
});
test('ACE detection respects name boundaries and does not flag Windows interface services', () => {
  for (const name of ['nsi Network Store Interface Service', 'Device Interface Service', 'InterfaceService']) assert.equal(AC.test(name), false, name);
  for (const name of ['ACE-BASE', 'ACE-Service', 'ACEGuard', 'Game_ACE-Launcher', 'BEService', 'EasyAntiCheat_EOS']) assert.equal(AC.test(name), true, name);
});
test('native process and service enumeration returns structured Windows safety result', { skip: process.platform !== 'win32' }, async t => {
  const root = await temp(t); let diagnostic = '';
  const result = await environment(root, path.join(root, 'NotRunningSyntheticGame.exe'), e => { diagnostic = String(e.stderr || e.message).slice(0, 1800); });
  assert.equal(result.verified, true, diagnostic || result.reason);
  assert.ok(Array.isArray(result.running)); assert.ok(Array.isArray(result.antiCheat));
});
test('native file lock probe accepts a closed Windows file', { skip: process.platform !== 'win32' }, async t => {
  const root = await temp(t), file = path.join(root, 'a.addon64'); await fs.writeFile(file, pe()); await checkLocks([file]);
});
