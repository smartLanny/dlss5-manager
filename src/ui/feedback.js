'use strict';
let feedbackDraft = null, feedbackAttachment = null;
function renderFeedbackGames() {
  if (!state) return;
  const value = $('feedbackGame').value || selectedGame || '';
  $('feedbackGame').innerHTML = '<option value="">尚未添加 / 未选择游戏</option>' + state.games.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  $('feedbackGame').value = state.games.some(g => g.id === value) ? value : '';
}
function invalidateFeedback() {
  feedbackDraft = null; $('feedbackReviewed').checked = false; $('feedbackReviewed').disabled = true;
  $('feedbackIncludeAttachment').checked = false; $('feedbackIncludeAttachment').disabled = true;
  $('feedbackQuality').textContent = '内容已变化，请重新生成预览。';
  for (const id of ['feedbackCopy', 'feedbackPublic', 'feedbackPrivate', 'feedbackOpen']) $(id).disabled = true;
}
function openGameFeedback(id) {
  showPage('feedback'); renderFeedbackGames(); $('feedbackGame').value = id; invalidateFeedback(); $('feedbackSymptom').focus();
}
function feedbackConsent() { return { id: feedbackDraft?.id, reviewed: $('feedbackReviewed').checked }; }
$('feedbackForm').addEventListener('input', invalidateFeedback);
$('feedbackForm').addEventListener('submit', event => {
  event.preventDefault(); if (!$('feedbackForm').reportValidity()) return;
  run('正在只读检查并生成脱敏报告', async () => {
    const draft = await api('feedback-preview', { gameId: $('feedbackGame').value || null, input: { type: $('feedbackType').value, symptom: $('feedbackSymptom').value, steps: $('feedbackSteps').value, unstable: $('feedbackUnstable').checked, shareGameName: $('feedbackShareName').checked } });
    feedbackDraft = draft; $('feedbackReport').textContent = draft.publicReport;
    $('feedbackQuality').className = `notice ${draft.quality.length ? 'warning' : 'neutral'}`;
    $('feedbackQuality').textContent = draft.quality.length ? '还需补充：' + draft.quality.join('；') : '基础证据已整理，提交前请再核对自由填写的文字。';
    $('feedbackReviewed').disabled = false; $('feedbackReviewed').checked = false;
    $('feedbackIncludeAttachment').disabled = !draft.attachmentSummary;
    $('feedbackIncludeAttachment').checked = false;
    for (const id of ['feedbackCopy', 'feedbackPublic', 'feedbackPrivate', 'feedbackOpen']) $(id).disabled = true;
  });
});
$('feedbackReviewed').addEventListener('change', () => {
  for (const id of ['feedbackCopy', 'feedbackPublic', 'feedbackPrivate', 'feedbackOpen']) $(id).disabled = !feedbackDraft || !$('feedbackReviewed').checked;
});
$('feedbackImport').addEventListener('click', () => run('正在校验反馈包，文件不会上传', async () => {
  const summary = await api('feedback-import'); if (!summary) return;
  feedbackAttachment = summary; invalidateFeedback(); $('feedbackClear').hidden = false;
  $('feedbackAttachment').textContent = `${summary.status === 'manifest-hashes-match' ? '清单与哈希一致' : '旧格式附件，未提供清单'} · ${summary.fileCount} 个文件 · ${(summary.size / 1024).toFixed(1)} KiB\n` + summary.files.map(f => f.name).join('、');
  toast('反馈包已在本地校验。公开报告只包含摘要，不包含原始附件。');
}));
$('feedbackClear').addEventListener('click', () => run('正在移除本次反馈附件', async () => {
  await api('feedback-clear'); feedbackAttachment = null; invalidateFeedback(); $('feedbackClear').hidden = true; $('feedbackAttachment').textContent = '未添加运行时附件';
}));
$('feedbackCopy').addEventListener('click', () => run('正在复制已预览的报告', async () => { await api('feedback-copy', feedbackConsent()); toast('公开报告已复制。'); }));
$('feedbackOpen').addEventListener('click', () => run('正在打开管理器反馈页', async () => { await api('feedback-open', feedbackConsent()); toast('报告已复制。请在 GitHub 粘贴并检查后自行提交，尚未创建 Issue。'); }));
$('feedbackPublic').addEventListener('click', () => run('正在保存公开报告', async () => { if (await api('feedback-export', { ...feedbackConsent(), kind: 'public', includeAttachment: false })) toast('已保存公开报告，没有原始附件。'); }));
$('feedbackPrivate').addEventListener('click', () => run('正在保存本地私有诊断包', async () => {
  const include = $('feedbackIncludeAttachment').checked;
  if (await api('feedback-export', { ...feedbackConsent(), kind: 'private', includeAttachment: include, confirmPrivate: include })) toast('私有包已保存在本机，没有上传。分享前请检查原始附件。');
}));
renderFeedbackGames();
