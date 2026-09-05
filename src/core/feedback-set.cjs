'use strict';
const { fail, sha256 } = require('./safety.cjs');
const { writeZip } = require('./packages.cjs');
const { MAX_BUNDLE, readFeedbackBundle, buildFeedback, sanitize } = require('./feedback.cjs');

// Transport aggregation only. An opaque NR ZIP is not silently interpreted as our schema.
async function readFeedbackSet(files) {
  if (!Array.isArray(files) || !files.length || files.length > 2 || files.some(f => typeof f !== 'string')) fail('FEEDBACK_COUNT', '一次选择一个核心包，或同次采集的核心包和图像包（最多两个 ZIP）。');
  const attachments = [];
  let total = 0;
  for (const file of files) {
    const attachment = await readFeedbackBundle(file);
    total += attachment.bytes.length;
    if (total > 2 * MAX_BUNDLE) fail('FEEDBACK_SIZE', '反馈附件总量过大，请保留核心小包，图像包单独发送。');
    if (attachments.some(a => a.summary.sha256 === attachment.summary.sha256)) fail('FEEDBACK_DUPLICATE', '选中了相同内容的反馈包，请重新选择本次的核心包和图像包。');
    attachments.push(attachment);
  }
  return attachments;
}
function setSummary(attachments) {
  return { count: attachments.length, fileCount: attachments.reduce((n, a) => n + a.summary.fileCount, 0),
    size: attachments.reduce((n, a) => n + a.summary.size, 0),
    pairing: attachments.length > 1 ? 'unverified' : 'not-applicable',
    note: attachments.length > 1 ? '已保留两个附件；尚未验证是否同次采集，请勿混用旧 F8 与新 F7。' : '仅保留在本机，尚未上传。' };
}
function buildFeedbackSet({ attachments = [], ...options }) {
  const rawSummary = options.input?.runtimeSummary;
  if (rawSummary !== undefined && (typeof rawSummary !== 'string' || rawSummary.length > 6000)) fail('FEEDBACK_INPUT', '复制的运行时摘要最多 6000 字。');
  const draft = buildFeedback({ ...options, attachment: attachments[0] || null });
  const extraQuality = attachments.slice(1).flatMap(attachment => buildFeedback({ ...options, attachment }).quality);
  draft.quality = [...new Set([...draft.quality, ...extraQuality])];
  if (attachments.length > 1) draft.quality.push('两个附件的采集配对关系待验证');
  const runtimeSummary = sanitize(rawSummary || '', 6000);
  draft.snapshot.runtimeSummary = runtimeSummary || null;
  draft.snapshot.runtimeAttachments = attachments.map(a => ({ status: a.summary.status, sha256: a.summary.sha256, size: a.bytes.length, fileCount: a.summary.fileCount }));
  draft.snapshot.pairing = setSummary(attachments).pairing;
  draft.snapshot.quality = draft.quality;
  const extra = [];
  if (attachments.length > 1) extra.push('## 补充附件', ...attachments.map((a, i) => `附件 ${i + 1}：SHA-256 ${a.summary.sha256}`), '配对关系待验证；相同文件名或同时选择不能证明同一次采集。', ...extraQuality);
  if (runtimeSummary) extra.push('## 用户粘贴的运行时摘要', '以下为经脱敏的用户提供内容，未与附件核对，不代表当前安装或实际运行状态。', runtimeSummary);
  if (extra.length) draft.publicReport += '\n\n' + extra.join('\n');
  draft.attachmentSummary = setSummary(attachments);
  return draft;
}
function privateFeedbackSet(draft, attachments, includeAttachments) {
  const entries = [['public-report.md', Buffer.from(draft.publicReport)], ['manager-summary.json', Buffer.from(JSON.stringify(draft.snapshot, null, 2))]];
  const inventory = [];
  if (includeAttachments) {
    const expected = draft.snapshot.runtimeAttachments;
    if (!attachments.length || attachments.length > 2 || !Array.isArray(expected) || attachments.length !== expected.length) fail('FEEDBACK_CHANGED', '附件数量与预览不一致，请重新生成报告。');
    attachments.forEach((a, i) => {
      if (a.bytes.length !== expected[i].size || sha256(a.bytes) !== expected[i].sha256) fail('FEEDBACK_CHANGED', '附件内容与预览不一致，请重新生成报告。');
      const name = attachments.length === 1 ? 'runtime-feedback.zip' : `runtime-feedback-${i + 1}.zip`;
      entries.push([name, a.bytes]); inventory.push({ file: name, sha256: expected[i].sha256, size: expected[i].size });
    });
  }
  entries.push(['attachments.json', Buffer.from(JSON.stringify({ schemaVersion: 1, included: inventory, pairing: draft.snapshot.pairing, uploaded: false }, null, 2))]);
  entries.push(['READ-ME.txt', Buffer.from('这是本地生成的反馈包，没有自动上传。请检查后通过作者已确认的渠道发送。原始附件可能包含路径、账号或截图内容，未进行脱敏改写。两个附件不代表配对已验证；请保留同次采集的 F7 核心/图像包，不要与旧 F8 混用。')]);
  return writeZip(entries);
}
module.exports = { readFeedbackSet, setSummary, buildFeedbackSet, privateFeedbackSet };
