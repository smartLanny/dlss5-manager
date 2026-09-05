'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { fail, validId, inside, noLinks, durableWrite } = require('./core/safety.cjs');
const { readFeedbackSet, setSummary, buildFeedbackSet, privateFeedbackSet } = require('./core/feedback-set.cjs');
function registerFeedback({ handle, engine, win, dialog, shell, clipboard }) {
  let attachments = [], attachmentGameId = null;
  const drafts = new Map();
  function get(id) {
    validId(id); const draft = drafts.get(id);
    if (!draft || draft.expires < Date.now()) fail('FEEDBACK_EXPIRED', '反馈预览已过期，请重新生成并检查内容。');
    return draft;
  }
  function reviewed(input) { if (input.reviewed !== true) fail('FEEDBACK_REVIEW', '请先预览报告，确认不包含需要保密的信息。'); }
  async function exportPath(file, extension) {
    if (!path.isAbsolute(file) || /^[\\/]{2}/.test(file) || path.extname(file).toLowerCase() !== extension || inside(engine.root, file) || engine.state.games.some(g => inside(g.scanRoot, file))) fail('FEEDBACK_EXPORT_PATH', '报告只能保存到游戏目录和管理器数据目录之外的本地文件。');
    await noLinks(file);
  }
  handle('feedback-import', async ({ gameId = null } = {}) => {
    if (gameId) engine.game(gameId);
    const selected = await dialog.showOpenDialog(win, { title: '选择本次核心包，或同次核心和图像包', properties: ['openFile', 'multiSelections'], filters: [{ name: '反馈包', extensions: ['zip'] }] });
    if (selected.canceled) return null;
    // A failed replacement must not leave an earlier session masquerading as the new one.
    attachments = []; attachmentGameId = null; drafts.clear();
    const next = await readFeedbackSet(selected.filePaths);
    attachments = next; attachmentGameId = gameId; return setSummary(next);
  }, true);
  handle('feedback-clear', async () => { attachments = []; attachmentGameId = null; drafts.clear(); return true; }, true);
  handle('feedback-preview', async ({ gameId, input }) => {
    const game = gameId ? engine.game(gameId) : null;
    if (attachments.length && attachmentGameId !== (gameId || null)) fail('FEEDBACK_GAME_CHANGED', '已更换反馈游戏，请重新选择本次附件，避免发错日志。');
    let report = null, eventCode = engine.lastEventCode || null;
    if (game?.exe) {
      try { report = await engine.deps.scan(game, engine.root); }
      catch (e) { eventCode = /^[A-Z_]{1,64}$/.test(e.code || '') ? e.code : 'SCAN_FAILED'; }
    }
    const draft = buildFeedbackSet({ managerVersion: require('../package.json').version, game, report, history: await engine.history(game?.id), input, attachments, eventCode });
    const id = crypto.randomUUID();
    for (const [key, value] of drafts) if (value.expires < Date.now()) drafts.delete(key);
    if (drafts.size >= 10) drafts.delete(drafts.keys().next().value);
    drafts.set(id, { ...draft, attachments: attachments.slice(), expires: Date.now() + 30 * 60 * 1000 });
    return { id, publicReport: draft.publicReport, title: draft.title, quality: draft.quality, route: draft.route, attachmentSummary: draft.attachmentSummary };
  }, true);
  handle('feedback-copy', async input => {
    reviewed(input); const draft = get(input.id); clipboard.writeText(draft.publicReport); return true;
  });
  handle('feedback-open', async input => {
    reviewed(input); const draft = get(input.id);
    clipboard.writeText(draft.publicReport);
    // The report body is NOT sent through a URL or an API. The user pastes and submits it.
    await shell.openExternal('https://github.com/smartLanny/dlss5-manager/issues/new?title=' + encodeURIComponent(draft.title));
    return true;
  });
  handle('feedback-export', async input => {
    reviewed(input); const draft = get(input.id);
    if (!['public', 'private'].includes(input.kind) || typeof input.includeAttachment !== 'boolean') fail('FEEDBACK_INPUT', '请选择公开报告或本地私有包。');
    if (input.kind === 'public' && input.includeAttachment) fail('FEEDBACK_PRIVATE', '公开报告不能包含运行时原始附件。');
    if (input.includeAttachment && input.confirmPrivate !== true) fail('FEEDBACK_PRIVATE', '原附件可能含隐私；请确认只用于私下诊断，不直接公开上传。');
    const ext = input.kind === 'public' ? '.md' : '.zip';
    const selected = await dialog.showSaveDialog(win, { title: input.kind === 'public' ? '保存已预览的公开报告' : '保存反馈包，检查后发给作者（不会自动上传）', defaultPath: input.kind === 'public' ? 'public-report.md' : 'diagnostic-private.zip', filters: [{ name: '反馈报告', extensions: [ext.slice(1)] }] });
    if (selected.canceled) return null;
    await exportPath(selected.filePath, ext);
    const bytes = input.kind === 'public' ? Buffer.from(draft.publicReport) : privateFeedbackSet(draft, draft.attachments, input.includeAttachment);
    await durableWrite(selected.filePath, bytes); return true;
  }, true);
}
module.exports = { registerFeedback };
