'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { temp, setup } = require('./helpers.cjs');
const { writeZip, readZip } = require('../src/core/packages.cjs');
const { readFeedbackSet, buildFeedbackSet, privateFeedbackSet } = require('../src/core/feedback-set.cjs');
const { registerFeedback } = require('../src/feedback-ipc.cjs');
const input = { type: 'image', symptom: '闪烁', steps: '', unstable: true, shareGameName: false };
async function examples(t) {
  const root = await temp(t), paths = [path.join(root, 'core.zip'), path.join(root, 'image.zip')];
  await fs.writeFile(paths[0], writeZip([['trace.log', Buffer.from('PRIVATE C:\\Users\\secret')]]));
  await fs.writeFile(paths[1], writeZip([['frame.bin', Buffer.from('sensitive image data')]]));
  return { paths, attachments: await readFeedbackSet(paths) };
}
test('core and optional image ZIP stay byte-exact, private-only and pairing unverified', async t => {
  const { paths, attachments } = await examples(t); const draft = buildFeedbackSet({ managerVersion: 'test', input, attachments });
  assert.equal(draft.snapshot.pairing, 'unverified'); assert.ok(draft.quality.some(q => /配对/.test(q))); assert.ok(!draft.publicReport.includes('PRIVATE'));
  const omitted = readZip(privateFeedbackSet(draft, attachments, false)); assert.equal(omitted.has('runtime-feedback-1.zip'), false);
  const included = readZip(privateFeedbackSet(draft, attachments, true));
  for (let i = 0; i < 2; i++) assert.deepEqual(included.get(`runtime-feedback-${i + 1}.zip`).bytes, await fs.readFile(paths[i]));
  assert.equal(JSON.parse(included.get('attachments.json').bytes).uploaded, false);
});
test('duplicate, too many and unsafe ZIP contents are rejected rather than pretending to be paired', async t => {
  const { paths } = await examples(t);
  await assert.rejects(readFeedbackSet([paths[0], paths[0]]), e => e.code === 'FEEDBACK_DUPLICATE');
  await assert.rejects(readFeedbackSet([...paths, paths[0]]), e => e.code === 'FEEDBACK_COUNT');
  await fs.writeFile(paths[1], writeZip([['program.exe', Buffer.from('not executed')]]));
  await assert.rejects(readFeedbackSet(paths), e => e.code === 'FEEDBACK_CONTENT');
});
test('pasted completed-session summary is sanitized but never claimed to match the current installation', () => {
  const draft = buildFeedbackSet({ managerVersion: 'test', input: { ...input, runtimeSummary: 'F8 completed\nC:\\Users\\secret\\x.log\ntoken=abcdef\nGPU model supplied by user' } });
  assert.ok(!draft.publicReport.includes('secret')); assert.ok(!draft.publicReport.includes('abcdef')); assert.match(draft.publicReport, /未与附件核对/); assert.match(draft.publicReport, /F8 completed/);
  assert.throws(() => buildFeedbackSet({ managerVersion: 'test', input: { ...input, runtimeSummary: 'x'.repeat(6001) } }));
});
test('all selected attachments are hash-checked against the preview during export', async t => {
  const { attachments } = await examples(t); const draft = buildFeedbackSet({ managerVersion: 'test', input, attachments });
  assert.throws(() => privateFeedbackSet(draft, attachments.slice(0, 1), true), e => e.code === 'FEEDBACK_CHANGED');
  attachments[1].bytes[0] ^= 1; assert.throws(() => privateFeedbackSet(draft, attachments, true), e => e.code === 'FEEDBACK_CHANGED');
});
test('second bundle mismatch is included in the quality gaps, not only the first bundle', async t => {
  const { attachments } = await examples(t); attachments[1].summary.api = 'DX11';
  const draft = buildFeedbackSet({ managerVersion: 'test', input, game: { api: 'DX12' }, attachments });
  assert.ok(draft.quality.some(q => q.includes('API'))); assert.ok(draft.publicReport.includes('API 与'));
});
test('feedback attachments are bound to the selected game, cancellation retains and failure clears old evidence', async t => {
  const { engine, game } = await setup(t); const { paths } = await examples(t); const handlers = {};
  const other = { ...game, id: crypto.randomUUID(), name: 'Other' }; engine.state.games.push(other);
  let selected = { canceled: false, filePaths: paths };
  registerFeedback({ handle: (name, fn) => handlers[name] = fn, engine, win: {}, dialog: { showOpenDialog: async () => selected } });
  const summary = await handlers['feedback-import']({ gameId: game.id }); assert.equal(summary.count, 2);
  await assert.rejects(handlers['feedback-preview']({ gameId: other.id, input }), e => e.code === 'FEEDBACK_GAME_CHANGED');
  const before = await handlers['feedback-preview']({ gameId: game.id, input }); assert.equal(before.attachmentSummary.count, 2);
  selected = { canceled: true }; assert.equal(await handlers['feedback-import']({ gameId: game.id }), null);
  assert.equal((await handlers['feedback-preview']({ gameId: game.id, input })).attachmentSummary.count, 2);
  selected = { canceled: false, filePaths: [paths[0], paths[0]] }; await assert.rejects(handlers['feedback-import']({ gameId: game.id }));
  const after = await handlers['feedback-preview']({ gameId: game.id, input }); assert.equal(after.attachmentSummary.count, 0);
  await assert.rejects(handlers['feedback-copy']({ id: before.id, reviewed: true }), e => e.code === 'FEEDBACK_EXPIRED');
});
