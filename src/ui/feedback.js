'use strict';
let feedbackDraft = null, feedbackAttachment = null, feedbackSelectedGame = '';
function renderFeedbackGames() {
  const select = $('feedbackGame'), old = select.value;
  select.innerHTML = '<option value="">安装器本身 / 未找到游戏</option>' + state.games.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  if (state.games.some(g => g.id === old)) select.value = old;
}
function clearAttachmentDisplay() {
  feedbackAttachment = null; feedbackDraft = null;
  $('feedbackAttachment').textContent = ''; $('feedbackClear').hidden = true;
}
async function changeFeedbackGame(id) {
  if (id !== feedbackSelectedGame) {
    await api('feedback-clear'); clearAttachmentDisplay(); $('feedbackRuntimeSummary').value = '';
    feedbackSelectedGame = id;
  }
  $('feedbackGame').value = id;
}
function feedbackGuidance() {
  const type = $('feedbackType').value;
  $('feedbackGuide').textContent = type === 'image' ? '画面、色彩或闪烁问题：支持 F7 的版本请采集一次，并选中同次生成的核心包和图像包。不要混用旧 F8 包。' : type === 'crash' ? '进不了游戏或已经崩溃：先生成本页安装诊断；有作者提供的离线采集包可一起附上。F8 不能替代崩溃转储。' : '能进游戏但无效果：支持 F8 的版本可先按 F8 收集，完成后复制报告摘要、附上本次核心 ZIP。旧版没有 F8 也能提交反馈。';
}
function feedbackGame(id) {
  closeDialogs(); showPage('feedback');
  run('正在选择反馈游戏', async () => { await changeFeedbackGame(id); $('feedbackSymptom').focus(); });
}
document.addEventListener('click', e => { const b = e.target.closest('[data-feedback-game]'); if (b && !busy) feedbackGame(b.dataset.feedbackGame); });
$('feedbackGame').addEventListener('change', () => run('正在切换反馈游戏', () => changeFeedbackGame($('feedbackGame').value)));
$('feedbackType').addEventListener('change', feedbackGuidance); feedbackGuidance();
$('feedbackForm').addEventListener('submit', e => {
  e.preventDefault(); if (!$('feedbackForm').reportValidity()) return;
  run('正在整理反馈', async () => {
    feedbackDraft = await api('feedback-preview', { gameId: $('feedbackGame').value || null, input: {
      type: $('feedbackType').value, symptom: $('feedbackSymptom').value, steps: $('feedbackSteps').value,
      unstable: $('feedbackUnstable').checked, shareGameName: $('feedbackShareName').checked, runtimeSummary: $('feedbackRuntimeSummary').value
    } });
    $('feedbackReport').textContent = feedbackDraft.publicReport;
    $('feedbackQuality').textContent = feedbackDraft.quality.length ? '还可以补充：' + feedbackDraft.quality.join('；') : '已整理基础信息，实际原因需要进一步检查。';
    $('feedbackQuality').hidden = false; $('feedbackInclude').checked = false; $('feedbackInclude').disabled = !feedbackAttachment;
    $('feedbackDialog').showModal();
  });
});
$('feedbackImport').addEventListener('click', () => run('正在读取本次反馈附件', async () => {
  try {
    const r = await api('feedback-import', { gameId: $('feedbackGame').value || null });
    if (!r) return;
    feedbackAttachment = r; feedbackDraft = null; feedbackSelectedGame = $('feedbackGame').value;
    $('feedbackAttachment').textContent = `已加入 ${r.count} 个反馈包，内含 ${r.fileCount} 个文件。${r.note}`;
    $('feedbackClear').hidden = false;
  } catch (e) { clearAttachmentDisplay(); throw e; }
}));
$('feedbackClear').addEventListener('click', () => run('正在移除附件', async () => { await api('feedback-clear'); clearAttachmentDisplay(); }));
for (const [id, method] of [['feedbackCopy', 'feedback-copy'], ['feedbackOpen', 'feedback-open']]) $(id).addEventListener('click', () => run('正在准备反馈', async () => {
  if (!feedbackDraft) return;
  await api(method, { id: feedbackDraft.id, reviewed: true });
  toast(method === 'feedback-open' ? '报告已复制。在 GitHub 编辑页粘贴、检查后提交；原始附件没有上传。' : '报告已复制，检查后可发给作者。');
}));
for (const [id, kind] of [['feedbackSave', 'public'], ['feedbackPrivate', 'private']]) $(id).addEventListener('click', () => run('正在保存反馈', async () => {
  if (!feedbackDraft) return;
  const include = kind === 'private' && $('feedbackInclude').checked;
  if (await api('feedback-export', { id: feedbackDraft.id, reviewed: true, kind, includeAttachment: include, confirmPrivate: include })) toast('已保存到本机。检查后把这个文件发给作者，尚未自动上传。');
}));
