'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, noLinks, sha256, leaf, HASH } = require('./safety.cjs');
const { readZip, writeZip } = require('./packages.cjs');
const MAX_BUNDLE = 64 * 1024 * 1024;
const TYPES = Object.freeze({ discovery: '游戏识别 / EXE / API', install: '安装 / 更新 / 卸载', crash: '无法启动 / 黑屏 / 崩溃', inactive: '插件已安装但不生效', image: '画面 / 闪烁 / 色彩', conflict: 'ReShade / DLL 冲突', other: '其他问题' });
const RUNTIME = new Set(['crash', 'inactive', 'image']);
const ROLES = new Set(['log', 'screenshot', 'summary', 'other']);
function sanitize(value, limit = 4000) {
  // All free text still requires human preview: no regex can recognize every secret.
  return String(value ?? '').slice(0, limit)
    .replace(/(?:https?:\/\/|www\.)[^\s<>]+/gi, '[链接已隐藏]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"<>]*/g, '[本地路径已隐藏]')
    .replace(/(?:^|[\s="'(])\/(?!\/)[^\r\n"<>]*/gm, ' [本地路径已隐藏]')
    .replace(/%[A-Za-z_]+%[\\/][^\r\n"<>]*/g, '[本地路径已隐藏]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|AKIA[A-Z0-9]{16})\b/g, '[凭据已隐藏]')
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, '[标识已隐藏]')
    .replace(/(?:authorization|bearer|token|password|passwd|cookie|账号|账户|用户名|密码|令牌)\s*[:=：]?\s*[^\r\n]+/gi, '[敏感字段已隐藏]')
    .replace(/(?:smartLanny[\\/])?dlss5-nr-before-sr-lab/gi, '[独立组件]')
    .replace(/[<>`]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
}
function relativeName(name) {
  if (typeof name !== 'string' || name.length > 240 || name.includes('\\') || name.startsWith('/')) fail('FEEDBACK_PATH', '反馈包包含不安全的路径。');
  const clean = name.endsWith('/') ? name.slice(0, -1) : name;
  clean.split('/').forEach(leaf); return name;
}
async function readFeedbackBundle(file) {
  await noLinks(file); const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_BUNDLE) fail('FEEDBACK_SIZE', '反馈包必须是小于 64 MiB 的 ZIP；不要附带大型转储。');
  const bytes = await fs.readFile(file);
  const entries = readZip(bytes, { maxPackage: MAX_BUNDLE, maxFile: 16 * 1024 * 1024, maxEntries: 64, minEntries: 1, nameValidator: relativeName });
  const files = [...entries.values()].filter(f => !f.name.endsWith('/'));
  if (files.some(f => /\.(?:dmp|mdmp|hdmp|core|exe|dll|addon64|addon32|pdb|cpp|h|hpp|c)$/i.test(f.name))) fail('FEEDBACK_CONTENT', '当前反馈包不能包含转储、程序二进制或源码，请使用日志和截图反馈包。');
  const record = entries.get('feedback-manifest.json');
  let manifest = null, status = 'legacy-unstructured';
  if (record) {
    if (record.bytes.length > 64 * 1024) fail('FEEDBACK_MANIFEST', '反馈清单过大。');
    try { manifest = JSON.parse(record.bytes.toString('utf8')); } catch { fail('FEEDBACK_MANIFEST', '反馈清单 JSON 损坏。'); }
    if (!manifest || manifest.schemaVersion !== 1 || !['nr-before-sr', 'dlss5-manager', 'reshade'].includes(manifest.producerId) || typeof manifest.producerVersion !== 'string' || !/^[0-9][0-9A-Za-z.-]{0,63}$/.test(manifest.producerVersion) || !Number.isFinite(Date.parse(manifest.createdAt))) fail('FEEDBACK_SCHEMA', '反馈包版本或生产者尚不受支持，不能降级成普通附件绕过清单校验。');
    leaf(manifest.gameExeName);
    if (!/\.exe$/i.test(manifest.gameExeName) || (manifest.api !== undefined && !['DX11', 'DX12', 'Vulkan', 'OpenGL'].includes(manifest.api)) || !Array.isArray(manifest.files) || manifest.files.length !== files.length - 1) fail('FEEDBACK_MANIFEST', '反馈清单与实际文件数或 API 不匹配。');
    const seen = new Set();
    for (const item of manifest.files) {
      if (!item || typeof item.path !== 'string' || !ROLES.has(item.role) || typeof item.sha256 !== 'string' || !HASH.test(item.sha256) || (item.sensitivity !== undefined && !['public', 'private', 'sensitive'].includes(item.sensitivity))) fail('FEEDBACK_MANIFEST', '反馈文件角色或校验值无效。');
      const key = relativeName(item.path).toLowerCase(), payload = entries.get(key);
      if (seen.has(key) || key === 'feedback-manifest.json' || !payload || payload.name.endsWith('/') || sha256(payload.bytes) !== item.sha256) fail('FEEDBACK_HASH', '反馈包存在重名、缺失文件或哈希不一致，已拒绝导入。');
      seen.add(key);
    }
    status = 'manifest-hashes-match';
  }
  const summary = { status, sha256: sha256(bytes), size: bytes.length, fileCount: files.length, producerId: manifest?.producerId || null, producerVersion: manifest?.producerVersion || null, api: manifest?.api || null, gameExeName: manifest?.gameExeName || null, files: files.map(f => ({ name: sanitize(f.name, 240), size: f.bytes.length })), note: '仅验证文件完整性，不证明发布者身份或问题原因。原附件只会进入经确认的本地私有包。' };
  return { bytes, summary };
}
function validateInput(input) {
  if (!input || !Object.hasOwn(TYPES, input.type) || typeof input.symptom !== 'string' || !input.symptom.trim() || input.symptom.length > 2000 || typeof input.steps !== 'string' || input.steps.length > 2000 || typeof input.unstable !== 'boolean' || typeof input.shareGameName !== 'boolean') fail('FEEDBACK_INPUT', '请选择问题类型、填写现象和复现步骤，或注明无法稳定复现。');

}
function buildFeedback({ managerVersion, game, report = null, history = [], input, attachment = null, eventCode = null }) {
  validateInput(input);
  const quality = [];
  if (!input.steps.trim() && !input.unstable) quality.push('未提供复现步骤');
  if (!game) quality.push('未选择游戏');
  if (!game?.installed?.version) quality.push('未发现已安装组件版本');
  if (!report) quality.push('没有本次扫描证据');
  if (RUNTIME.has(input.type) && !attachment) quality.push('运行时问题缺少反馈包，证据不足');
  if (attachment?.summary.status === 'legacy-unstructured') quality.push('旧反馈包无版本化清单，仅作为附件保留');
  if (attachment?.summary.api && game?.api && attachment.summary.api !== game.api) quality.push('反馈包 API 与所选游戏不一致');
  if (attachment?.summary.gameExeName && game?.exe && attachment.summary.gameExeName.toLowerCase() !== path.basename(game.exe).toLowerCase()) quality.push('反馈包 EXE 与所选游戏不一致');
  if (attachment?.summary.producerId === 'nr-before-sr' && game?.installed?.version && attachment.summary.producerVersion !== game.installed.version) quality.push('反馈包组件版本与当前安装版本不一致');
  const latest = history.find(h => h.gameId === game?.id);
  if (input.type === 'install' && !latest && !eventCode) quality.push('未找到安装事务或事件码，请先复现失败');
  // Whitelist the evidence fields. Never serialize raw manifests, process lists, paths or logs here.
  const snapshot = {
    schemaVersion: 1, managerVersion, type: input.type,
    game: input.shareGameName ? sanitize(game?.name || '未选择', 160) : '未公开（可在提交前补充）',
    exe: input.shareGameName && game?.exe ? sanitize(path.basename(game.exe), 160) : '未公开',
    api: ['DX11', 'DX12', 'Vulkan', 'OpenGL'].includes(game?.api) ? game.api : '待确认',
    componentVersion: sanitize(game?.installed?.version || '未安装', 64),
    channel: ['stable', 'beta', 'local'].includes(game?.installed?.channel) ? game.installed.channel : '待确认',
    architecture: ['x64', 'x86', 'ARM64'].includes(report?.exe?.arch) ? report.exe.arch : '待确认',
    scanTime: report?.scannedAt && Number.isFinite(Date.parse(report.scannedAt)) ? report.scannedAt : null,
    loader: ['absent', 'unverified', 'catalog-verified'].includes(report?.loader?.state) ? report.loader.state : '未核验',
    addonSupport: ['yes', 'no', 'unknown'].includes(report?.loader?.addonSupport) ? report.loader.addonSupport : 'unknown',
    blockerCount: report?.blockers?.length || 0,
    files: (report?.files || []).slice(0, 150).map(f => ({ role: ['nr-before-sr', 'nr-runtime', 'reshade', 'dxvk', 'enb', 'streamline'].includes(f.componentId) ? f.componentId : 'other-graphics-file', version: sanitize(f.version, 64), sha256: typeof f.sha256 === 'string' && HASH.test(f.sha256) ? f.sha256 : null, ownership: ['manager-owned', 'unknown', 'known-third-party'].includes(f.ownership) ? f.ownership : f.owned ? 'manager-owned' : 'unknown', signature: ['Valid', 'NotSigned', 'HashMismatch', 'NotTrusted', 'UnknownError'].includes(f.signature) ? f.signature : '待核验' })),
    transaction: latest ? { id: /^[a-f0-9-]{36}$/.test(latest.id) ? latest.id : '无效', status: ['preparing', 'prepared', 'applying', 'committed', 'restoring', 'reverted', 'aborted', 'recovery-needed'].includes(latest.status) ? latest.status : '未知', errorCode: /^[A-Z_]{1,64}$/.test(latest.errorCode || '') ? latest.errorCode : null } : null,
    eventCode: /^[A-Z_]{1,64}$/.test(eventCode || '') ? eventCode : null,
    attachment: attachment ? { status: attachment.summary.status, sha256: attachment.summary.sha256, fileCount: attachment.summary.fileCount } : null,
    compatibility: '待验证', quality
  };
  const publicReport = [
    `# ${RUNTIME.has(input.type) ? '运行时反馈' : '管理器反馈'}：${TYPES[input.type]}`,
    `管理器：${managerVersion}；组件：${snapshot.componentVersion}；渠道：${snapshot.channel}`,
    `游戏：${snapshot.game}；EXE：${snapshot.exe}`,
    `API：${snapshot.api}；架构：${snapshot.architecture}；游戏兼容性：待验证`,
    '', '## 问题现象', sanitize(input.symptom), '', '## 复现步骤', sanitize(input.steps) || (input.unstable ? '无法稳定复现' : '尚未提供复现步骤'),
    ...(input.unstable && input.steps.trim() ? ['补充：无法稳定复现'] : []),
    '', '## 可核验证据', `扫描时间：${snapshot.scanTime || '未扫描'}；阻断项数量：${snapshot.blockerCount}`,
    `ReShade：${snapshot.loader}；完整 Add-on 能力：${snapshot.addonSupport}`,
    `最近事务：${snapshot.transaction ? snapshot.transaction.id + ' / ' + snapshot.transaction.status : '无'}；事件码：${snapshot.eventCode || snapshot.transaction?.errorCode || '无'}`,
    ...snapshot.files.map(f => `组件 ${f.role}；版本 ${f.version}；归属 ${f.ownership}；签名 ${f.signature}；SHA-256 ${f.sha256 || '未取得'}`),
    `反馈包：${snapshot.attachment ? snapshot.attachment.status + ' / SHA-256 ' + snapshot.attachment.sha256 : '未提供'}`,
    '', '## 证据完整度', quality.length ? quality.join('；') : '已提供基础材料，仍需维护者复核；不代表已定位原因。',
    '', '此公开报告未包含原始附件、游戏目录、进程清单、硬件唯一标识或私有仓库入口。提交前请再次检查自由填写的文字。'
  ].join('\n');
  return { title: `[${RUNTIME.has(input.type) ? '运行时反馈' : 'Manager'}] ${TYPES[input.type]}`, publicReport, snapshot, quality, route: RUNTIME.has(input.type) ? 'maintainer-triage' : 'manager', attachmentSummary: attachment?.summary || null };
}
function privateBundle(draft, attachment, includeAttachment) {
  const entries = [['public-report.md', Buffer.from(draft.publicReport)], ['manager-summary.json', Buffer.from(JSON.stringify(draft.snapshot, null, 2))]];
  if (includeAttachment) {
    if (!attachment || sha256(attachment.bytes) !== draft.snapshot.attachment?.sha256) fail('FEEDBACK_CHANGED', '附件与预览时不一致，请重新生成报告。');
    entries.push(['runtime-feedback.zip', attachment.bytes]);
  }
  entries.push(['READ-ME.txt', Buffer.from('仅供本地私下诊断。包含原始运行时附件时，附件可能保留路径、账号或截图内容，未进行脱敏改写。请自行检查后通过已确认的私下渠道发送，不要直接上传到公开 Issue。')]);
  return writeZip(entries);
}
module.exports = { TYPES, MAX_BUNDLE, sanitize, readFeedbackBundle, buildFeedback, privateBundle };
