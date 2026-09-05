'use strict';
const path = require('node:path');

// A read-only plan. Never infer ownership or incompatibility from a filename alone.
// Keep shared dependencies when removing NR would otherwise break other addons.
function retainedEnvironment(current, report) {
  const owned = new Set(current.map(f => f.name.toLowerCase()));
  const local = (report.files || []).filter(f => path.dirname(f.path) === report.targetRoot);
  const otherAddons = local.some(f => /\.(?:addon32|addon64|asi)$/i.test(f.name) && !owned.has(f.name.toLowerCase()));
  const incomplete = report.riskWarnings?.some(w => w.code === 'SCAN_PARTIAL');
  const custom = report.addonConfig && report.addonConfig.state !== 'default';
  const shaderSettings = local.some(f => /^reshade.*\.ini$/i.test(f.name) && !owned.has(f.name.toLowerCase()));
  const reasons = [otherAddons && 'other-addons', incomplete && 'scan-incomplete', custom && 'custom-addon-path', shaderSettings && 'reshade-settings'].filter(Boolean);
  if (!reasons.length) return [];
  return current.filter(f => f.role === 'reshade-loader' || (f.role === 'nr-runtime' && (otherAddons || incomplete || custom))).map(f => ({
    name: f.name, role: f.role, sha256: f.sha256, reasons,
    action: '为现有插件或配置保留，不再随 NR 卸载自动删除'
  }));
}
function uninstallSummary(plan) {
  const kept = plan.retainedEnvironment || [];
  const restored = plan.changes.filter(c => c.after !== null).map(c => c.name);
  const removed = plan.changes.filter(c => c.after === null).map(c => c.name);
  return { removed, restored, kept: kept.map(f => f.name),
    message: kept.length ? '已撤销本工具安装的 NR；共用运行环境已保留。' : '已撤销本工具的安装改动。',
    detail: [removed.length ? '移除本工具新增的插件文件。' : '', restored.length ? '被接管的文件还原到安装前版本（可能是你原来使用的插件，并非游戏出厂文件）。' : '', kept.length ? '保留共用运行环境：' + kept.map(f => f.name).join('、') + '，避免影响其他插件和预设。' : '', '游戏设置、存档及未接管的文件不删除。恢复记录仍保留在本机。'].filter(Boolean).join('\n') };
}
module.exports = { retainedEnvironment, uninstallSummary };
