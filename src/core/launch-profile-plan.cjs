'use strict';
// Read-only request compiler, NOT a live driver writer or backend installer.
// It emits actual config contents and scoped setting intents for review. All
// application/restoration must later go through the existing Engine and a
// profile-aware NVAPI adapter. No FS, subprocess, injection or network here.
const { createHash } = require('node:crypto');
const ini = require('../vendor/swapper-ini.cjs');
const SOURCES = Object.freeze({
  optiscaler: 'da70e61e1542a0b99adcb24168ff941e42109567',
  rtx40: '4e776d068f91b4a665425542bb005dd57cc3d891',
  nvapi: '87dca625e83fd89a983e19b904e5f3a580da90d2'
});
const SR_MODES = Object.freeze({ performance: 0, balanced: 1, quality: 2, dlaa: 4, ultraPerformance: 5, custom: 6 });
const SR_RATIOS = Object.freeze({ dlaa: 1, quality: 1.5, balanced: 1.7, performance: 2, ultraPerformance: 3 });
const SR_PRESETS = Object.freeze({ K: 11, L: 12, M: 13 });
const DRS = Object.freeze({
  srMode: 0x10AFB768, srOverride: 0x10E41E01, srPreset: 0x10E41DF3, srRatio: 0x10E41DF5,
  fgMode: 0x10308298, fgCount: 0x104D6667, fgDynamicMax: 0x10562D0F, fgTarget: 0x10CF4125
});
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_INPUT', `${name}必须是普通对象`);
  return value;
}
function keys(value, allowed, name) {
  object(value, name);
  for (const k of Object.keys(value)) if (!allowed.includes(k)) fail('UNKNOWN_FIELD', `${name}不支持字段 ${k}`);
}
function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) fail('INVALID_RANGE', `${name}范围为${min}–${max}，必须是整数`);
  return value;
}
function hash(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function textInput(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || /\u0000|\uFFFD/.test(text))
    fail('INVALID_TEXT', '配置必须是有效 UTF-8 文本且不超过 1 MiB');
  return text;
}
function plan(backend, fields = {}) {
  return { schema: 1, backend, sourceRef: SOURCES[backend], phase: 'preview-only',
    applied: false, runtimeVerified: false, requiresRestart: true, ...fields };
}
// Public DRS IDs are not hardware capabilities. In particular the integer
// range 1..15 in a header does not grant 16X FG support on any graphics card.
function planNvidiaSr(request) {
  keys(request, ['quality', 'renderPercent', 'preset'], 'SR请求');
  const { quality, preset } = request;
  if (quality === 'game') {
    if (request.renderPercent !== undefined || preset !== undefined) fail('CONFLICTING_REQUEST', '恢复游戏控制不能同时指定比例或模型');
    return plan('nvapi', { domain: 'sr', operations: [{ action: 'restore-owned-settings',
      ids: [DRS.srMode, DRS.srOverride, DRS.srRatio, DRS.srPreset] }],
      warnings: ['需要原始逐项快照；不是清除整个驱动 profile，也不是把用户原设置写成默认值。'] });
  }
  if (!Object.hasOwn(SR_MODES, quality)) fail('UNKNOWN_QUALITY', '未知 SR 档位');
  if (preset !== undefined && !Object.hasOwn(SR_PRESETS, preset)) fail('UNKNOWN_PRESET', '模型仅支持显式 K/L/M；不猜测 GPU 自动推荐');
  let percent = 0;
  if (quality === 'custom') percent = integer(request.renderPercent, 33, 100, '原生渲染百分比');
  else if (request.renderPercent !== undefined) fail('CONFLICTING_REQUEST', '只有自定义档位接收渲染百分比');
  const operations = [
    { action: 'set-dword', id: DRS.srOverride, value: 1 },
    { action: 'set-dword', id: DRS.srMode, value: SR_MODES[quality] },
    { action: 'set-dword', id: DRS.srRatio, value: percent }
  ];
  if (preset !== undefined) operations.push({ action: 'set-dword', id: DRS.srPreset, value: SR_PRESETS[preset] });
  return plan('nvapi', { domain: 'sr', operations, requirements: ['existing-native-or-injected-dlss', 'per-application-profile'],
    warnings: ['仅表示拟写入的每游戏驱动请求；尚无 NVAPI 执行器，不证明实际 R 改变。',
      'SR 档位、K/L/M 模型、NR 工作比例是三个不同设置；本计划不写 RR/NR/FG 键。'] });
}
// Refuse ambiguous duplicate sections/keys instead of changing only the first
// duplicate and showing the user an INI value the backend may never consume.
function uniqueTargets(text, targets) {
  const counts = new Map(); let section = ''; const sections = new Map();
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/);
    if (header) {
      section = header[1].trim().toLowerCase();
      sections.set(section, (sections.get(section) || 0) + 1);
      // The reused helper expects plain headers; do not normalize a whole file.
      if (line.trim().toLowerCase() !== `[${section}]`)
        fail('AMBIGUOUS_INI', '目标 INI 节使用了不受支持的头部语法，请保留原文件');
      continue;
    }
    const entry = line.match(/^\s*([^;#][^=]*?)\s*=/);
    if (entry) { const key = `${section}/${entry[1].trim().toLowerCase()}`; counts.set(key, (counts.get(key) || 0) + 1); }
  }
  for (const [s, k] of targets) if ((sections.get(s.toLowerCase()) || 0) > 1 ||
      (counts.get(`${s.toLowerCase()}/${k.toLowerCase()}`) || 0) > 1)
    fail('AMBIGUOUS_INI', '目标 INI 节或键重复，未生成覆盖内容');
}
function planOptiScalerSr(text, request) {
  textInput(text); keys(request, ['quality', 'renderPercent'], 'OptiScaler SR请求');
  const targets = [['UpscaleRatio', 'UpscaleRatioOverrideEnabled'], ['UpscaleRatio', 'UpscaleRatioOverrideValue']];
  uniqueTargets(text, targets);
  if (request.quality === 'game') {
    if (request.renderPercent !== undefined) fail('CONFLICTING_REQUEST', '恢复请求不能同时指定比例');
    return plan('optiscaler', { domain: 'sr', destination: 'OptiScaler.ini', beforeSha256: hash(text),
      operations: [{ action: 'restore-owned-ini-keys', targets }],
      warnings: ['恢复事务应合并回原有逐键值，保留之后无关修改；不是将整份 INI 覆盖成模板。'] });
  }
  let ratio;
  if (request.quality === 'custom') {
    const p = request.renderPercent;
    if (!Number.isFinite(p) || p < 100 / 3 || p > 100) fail('INVALID_RANGE', '该 OptiScaler 配方使用 1–3 倍比例，对应约33.333%–100%');
    ratio = 100 / p;
  } else {
    if (!Object.hasOwn(SR_RATIOS, request.quality)) fail('UNKNOWN_QUALITY', '未知超分档位');
    if (request.renderPercent !== undefined) fail('CONFLICTING_REQUEST', '预设与自定义比例不能同时提交');
    ratio = SR_RATIOS[request.quality];
  }
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  let next = ini.setIni(text, targets[0][0], targets[0][1], 'true');
  next = bom + ini.setIni(next, targets[1][0], targets[1][1], String(Number(ratio.toFixed(9))));
  return plan('optiscaler', { domain: 'sr', destination: 'OptiScaler.ini', beforeSha256: hash(text), afterSha256: hash(next), content: next,
    linearRenderPercent: 100 / ratio, requirements: ['matched-installed-backend', 'existing-temporal-upscaler-input'],
    warnings: ['OptiScaler 使用输出/输入倍率，不是把75直接写成倍率。',
      '保留原有 DRS、NR 和 FG 配置；实际渲染 R 仍需后端/游戏运行时确认。'] });
}
function parseControl(text) {
  textInput(text); let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { fail('INVALID_JSON', '原 MFG 配置无法解析，不使用空对象覆盖'); }
  object(value, 'MFG配置');
  if (value.version !== 11) fail('PROTOCOL_MISMATCH', '仅适配已审阅的 MFG control v11，不改写未知协议');
  // JSON stringify must not silently turn an unknown infinity into null or
  // a large integer identifier into a rounded value. Bound nesting as well.
  const pending = [[value, 0]];
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (depth > 64) fail('INVALID_JSON_VALUE', '原配置嵌套过深，未生成重写内容');
    if (typeof item === 'number' && (!Number.isFinite(item) ||
        (Number.isInteger(item) && !Number.isSafeInteger(item)) || Object.is(item, -0)))
      fail('INVALID_JSON_VALUE', '原配置含无法无损保留的数值，未生成重写内容');
    if (item && typeof item === 'object') for (const child of Object.values(item)) pending.push([child, depth + 1]);
  }
  return value;
}
function reviewMfgStatus(status, now = Date.now()) {
  if (!status) return { state: 'unknown', reason: '没有本会话状态，不能按显卡型号猜倍率' };
  object(status, 'MFG状态');
  if (!Number.isFinite(now) || !Number.isFinite(status.heartbeat) || Math.abs(now / 1000 - status.heartbeat) > 5)
    return { state: 'stale', reason: '状态缺少有效心跳或已过期，不沿用旧会话上限' };
  if (status.activeWrapperObserved !== true) return { state: 'unknown', reason: '尚未观察到实际活动帧生成后端' };
  const max = status.safeMaximumMultiplier;
  if (!Number.isInteger(max) || max < 2 || max > 6) return { state: 'unknown', reason: '后端未给出有效安全倍率' };
  return { state: 'reported', safeMaximumMultiplier: max,
    dynamicSupportKnown: status.dynamicMfgSupportKnown === true && typeof status.dynamicMfgSupported === 'boolean',
    dynamicSupported: status.dynamicMfgSupportKnown === true && typeof status.dynamicMfgSupported === 'boolean'
      ? status.dynamicMfgSupported : null,
    note: '仅是上游字段的只读解析；未验证生产进程、模块身份或最终显示节奏，不能据此自动应用。' };
}
function planRtx40Mfg(text, request, status = null, now = Date.now()) {
  const original = parseControl(text);
  keys(request, ['mode', 'multiplier', 'targetFps', 'experimental56'], 'MFG请求');
  if (!['follow', 'fixed', 'dynamic'].includes(request.mode)) fail('UNKNOWN_MODE', '该公开控制协议没有 off 模式；关闭须用游戏或恢复/停用操作，不冒充 follow');
  if (request.experimental56 !== undefined && typeof request.experimental56 !== 'boolean') fail('INVALID_INPUT', 'experimental56 必须是布尔值');
  if (request.mode !== 'fixed' && request.multiplier !== undefined) fail('CONFLICTING_REQUEST', '仅固定模式接收倍率');
  if (request.mode !== 'dynamic' && (request.targetFps !== undefined || request.experimental56 !== undefined)) fail('CONFLICTING_REQUEST', '动态目标只能用于动态模式');
  const next = { ...original, version: 11, followGame: request.mode === 'follow', mode: request.mode };
  if (request.mode === 'fixed') next.multiplier = integer(request.multiplier, 2, 6, '总帧倍率');
  if (request.mode === 'dynamic') {
    next.dynamicTargetFrameRate = integer(request.targetFps ?? 0, 0, 1000, '动态目标');
    next.dynamicExperimental56 = request.experimental56 === true;
  } else next.dynamicExperimental56 = false;
  // A stale dormant setting must not create generated-only debug output merely
  // because the manager requests a different multiplier. Preserve user's value;
  // the preview flags it, and application requires an explicit reviewed policy.
  const evidence = reviewMfgStatus(status, now);
  const warnings = ['这是社区 RTX40 MFG 后端请求，不是官方40系MFG支持；必须已有可用 Streamline FG。',
    '配置路径由实际前端决定：CET目录与EXE旁边不能同时盲写。'];
  if (evidence.state !== 'reported') warnings.push(evidence.reason);
  if (original.generatedOnlyDebug === true) warnings.push('原配置已启用 generatedOnlyDebug；预览保留但不得默认自动应用。');
  let feasibility = 'unknown';
  if (request.mode === 'follow') feasibility = 'follow-request';
  else if (evidence.state === 'reported') {
    feasibility = request.mode === 'fixed'
      ? (next.multiplier <= evidence.safeMaximumMultiplier ? 'within-reported-limit' : 'outside-reported-limit')
      : (!evidence.dynamicSupportKnown ? 'unknown' : !evidence.dynamicSupported ? 'dynamic-reported-unsupported' : next.dynamicExperimental56 && evidence.safeMaximumMultiplier < 6
        ? 'outside-reported-limit' : 'within-reported-limit');
  }
  const content = (text.startsWith('\uFEFF') ? '\uFEFF' : '') + JSON.stringify(next, null, 2).replace(/\n/g, text.includes('\r\n') ? '\r\n' : '\n') + (text.includes('\r\n') ? '\r\n' : '\n');
  return plan('rtx40', { domain: 'fg', destination: 'RTX40MFG-Universal.json', beforeSha256: hash(text), afterSha256: hash(content),
    content, feasibility, evidence, warnings, automaticApplicationAllowed: false });
}
module.exports = { SOURCES, DRS, planNvidiaSr, planOptiScalerSr, planRtx40Mfg, reviewMfgStatus };
