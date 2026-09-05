'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { temp, setup, cleanScan } = require('./helpers.cjs');
const { sanitize, readFeedbackBundle, buildFeedback, privateBundle } = require('../src/core/feedback.cjs');
const { writeZip, readZip } = require('../src/core/packages.cjs');
const { sha256 } = require('../src/core/safety.cjs');
const { registerFeedback } = require('../src/feedback-ipc.cjs');
function input(overrides = {}) { return { type: 'image', symptom: '更新后闪烁', steps: '打开游戏，切换场景', unstable: false, shareGameName: false, ...overrides }; }
function bundle(overrides = {}) {
  const bytes = Buffer.from('PRIVATE runtime log: C:\\Users\\secret\\game token=hidden');
  const manifest = { schemaVersion: 1, producerId: 'nr-before-sr', producerVersion: '0.4.2beta', createdAt: '2026-09-05T12:00:00Z', gameExeName: 'Game.exe', api: 'DX12', files: [{ path: 'runtime.log', role: 'log', sha256: sha256(bytes), sensitivity: 'public' }], ...overrides };
  return writeZip([['feedback-manifest.json', Buffer.from(JSON.stringify(manifest))], ['runtime.log', bytes]]);
}
test('free text masks paths, links, credentials, mail, account fields and machine IDs', () => {
  const values = ['C:\\Users\\Alice\\game\\secret.log', '/Users/Alice/secret', '\\\\server\\share\\log', 'https://host.invalid/private?token=abc', 'mail@example.org', 'ghp_abcABC123XYZ', 'token=verysecret', '用户名: Alice', 'password = hunter2', '01234567-89ab-cdef-0123-456789abcdef', 'smartLanny/dlss5-nr-before-sr-lab'];
  for (const value of values) assert.notEqual(sanitize(value), value, value);
  assert.equal(sanitize('画面在转动视角时闪烁'), '画面在转动视角时闪烁');
});
test('report requires symptom; missing optional steps remains an explicit evidence gap', () => {
  assert.throws(() => buildFeedback({ managerVersion: '0.2.0-beta.1', input: input({ symptom: '' }) }));
  const draft = buildFeedback({ managerVersion: '0.2.0-beta.1', input: input({ steps: '' }) });
  assert.ok(draft.quality.includes('未提供复现步骤')); assert.ok(draft.publicReport.includes('尚未提供复现步骤')); assert.ok(!draft.publicReport.includes('无法稳定复现'));
  assert.ok(buildFeedback({ managerVersion: '0.2.0-beta.1', input: input({ steps: '', unstable: true }) }).quality.length);
});
test('default report omits game name, EXE, source paths and raw scanner strings', async t => {
  const { game } = await setup(t); game.name = 'PrivateGameName';
  const report = await cleanScan(game); report.files = [{ name: 'PrivateAddon.addon64', path: '/Users/Secret/log', componentId: 'nr-before-sr', version: 'https://private.invalid/source', sha256: 'a'.repeat(64), signature: 'CN=PrivateName', ownership: 'manager-owned' }];
  const draft = buildFeedback({ managerVersion: '0.2.0-beta.1', game, report, input: input({ symptom: '故障\nC:\\Users\\Secret\\src\\file.cpp\ntoken=abcsecret' }) });
  for (const value of ['PrivateGameName', 'Game.exe', 'PrivateAddon', 'Secret', 'abcsecret', 'private.invalid', 'CN=PrivateName']) assert.ok(!draft.publicReport.includes(value), value);
  assert.ok(draft.publicReport.includes('证据不足')); assert.equal(draft.route, 'maintainer-triage');
  const opted = buildFeedback({ managerVersion: '0.2.0-beta.1', game, input: input({ shareGameName: true }) });
  assert.ok(opted.publicReport.includes('PrivateGameName'));
});
test('valid runtime manifest hashes do not authenticate producer or leak log contents', async t => {
  const root = await temp(t), file = path.join(root, 'feedback.zip'); await fs.writeFile(file, bundle());
  const attachment = await readFeedbackBundle(file); assert.equal(attachment.summary.status, 'manifest-hashes-match');
  const draft = buildFeedback({ managerVersion: '0.2.0-beta.1', input: input(), attachment });
  assert.ok(!draft.publicReport.includes('PRIVATE runtime log'));
  assert.ok(!JSON.stringify(draft.snapshot).includes('hidden'));
  const noAttachment = readZip(privateBundle(draft, attachment, false)); assert.ok(!noAttachment.has('runtime-feedback.zip'));
  const included = readZip(privateBundle(draft, attachment, true)); assert.deepEqual(included.get('runtime-feedback.zip').bytes, attachment.bytes);
  attachment.bytes[0] ^= 1; assert.throws(() => privateBundle(draft, attachment, true), e => e.code === 'FEEDBACK_CHANGED');
});
test('legacy ZIP remains clearly unstructured and is never parsed as source or executed', async t => {
  const root = await temp(t), file = path.join(root, 'legacy.zip');
  await fs.writeFile(file, writeZip([['old.log', Buffer.from('private log')]]));
  const value = await readFeedbackBundle(file); assert.equal(value.summary.status, 'legacy-unstructured');
});
for (const [name, payload] of [
  ['hash mismatch', () => bundle({ files: [{ path: 'runtime.log', role: 'log', sha256: '0'.repeat(64) }] })],
  ['unknown schema', () => bundle({ schemaVersion: 99 })],
  ['unlisted file', () => bundle({ files: [] })],
  ['wrong producer', () => bundle({ producerId: 'unknown' })],
  ['absolute EXE path', () => bundle({ gameExeName: 'C:\\private\\Game.exe' })],
  ['dump attachment', () => writeZip([['crash.dmp', Buffer.from('dump')]])],
  ['source attachment', () => writeZip([['private.cpp', Buffer.from('code')]])],
  ['executable attachment', () => writeZip([['program.exe', Buffer.from('executable')]])]
]) test(`runtime feedback rejects ${name}`, async t => {
  const root = await temp(t), file = path.join(root, 'rejected.zip'); await fs.writeFile(file, payload());
  await assert.rejects(readFeedbackBundle(file));
});
test('feedback mismatch is a visible evidence gap, not successful game verification', async t => {
  const root = await temp(t), file = path.join(root, 'feedback.zip'); await fs.writeFile(file, bundle());
  const a = await readFeedbackBundle(file);
  const draft = buildFeedback({ managerVersion: '0.2.0-beta.1', game: { exe: 'Other.exe', api: 'DX11', installed: { version: '0.3.3.4' } }, input: input(), attachment: a });
  assert.ok(draft.quality.some(x => x.includes('API'))); assert.ok(draft.quality.some(x => x.includes('EXE'))); assert.ok(draft.quality.some(x => x.includes('组件版本')));
});
test('feedback IPC requires immutable draft ID and review, never accepts raw export body or uploads it', async t => {
  const { engine, game, root, gameRoot } = await setup(t), handlers = {}, opened = [], copied = [];
  let savePath = path.join(root, 'public-report.md');
  registerFeedback({ handle: (key, fn) => handlers[key] = fn, engine, win: {}, clipboard: { writeText: x => copied.push(x) }, shell: { openExternal: async x => opened.push(x) }, dialog: { showSaveDialog: async () => ({ canceled: false, filePath: savePath }) } });
  const draft = await handlers['feedback-preview']({ gameId: game.id, input: input() });
  await assert.rejects(handlers['feedback-copy']({ id: draft.id, reviewed: false }), e => e.code === 'FEEDBACK_REVIEW');
  await handlers['feedback-open']({ id: draft.id, reviewed: true, body: 'evil', url: 'https://evil.invalid' });
  assert.equal(copied[0], draft.publicReport); assert.ok(opened[0].startsWith('https://github.com/smartLanny/dlss5-manager/issues/new?title='));
  assert.ok(!opened[0].includes('body=')); assert.ok(!opened[0].includes('evil'));
  await handlers['feedback-export']({ id: draft.id, reviewed: true, kind: 'public', includeAttachment: false });
  assert.equal(await fs.readFile(savePath, 'utf8'), draft.publicReport);
  savePath = path.join(gameRoot, 'public-report.md');
  await assert.rejects(handlers['feedback-export']({ id: draft.id, reviewed: true, kind: 'public', includeAttachment: false }), e => e.code === 'FEEDBACK_EXPORT_PATH');
  await assert.rejects(handlers['feedback-export']({ id: draft.id, reviewed: true, kind: 'public', includeAttachment: true }), e => e.code === 'FEEDBACK_PRIVATE');
  await assert.rejects(handlers['feedback-export']({ id: draft.id, reviewed: true, kind: 'private', includeAttachment: true, confirmPrivate: false }), e => e.code === 'FEEDBACK_PRIVATE');
  await assert.rejects(handlers['feedback-copy']({ id: crypto.randomUUID(), reviewed: true }), e => e.code === 'FEEDBACK_EXPIRED');
});
