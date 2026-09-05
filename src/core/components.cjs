'use strict';
// Public package metadata only. No component code is loaded or inspected for algorithms.
const { fail, HASH, leaf } = require('./safety.cjs');
const APIS = new Set(['DX11', 'DX12', 'Vulkan', 'OpenGL']);
const CHANNELS = new Set(['stable', 'beta', 'local']);
const COMPONENTS = new Set(['nr-before-sr', 'nr-runtime', 'reshade', 'dxvk', 'enb', 'streamline']);
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value, max = 160) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value); }
function fields(value, names) {
  if (!plain(value) || Object.keys(value).some(k => !names.includes(k))) fail('COMPONENT_SCHEMA', '组件清单有不支持的字段或格式，请使用契约 v2。');
}
function uniqueStrings(value, allowed, min = 0, max = 16) {
  return Array.isArray(value) && value.length >= min && value.length <= max && new Set(value).size === value.length && value.every(x => typeof x === 'string' && allowed.has(x));
}
function parts(value) {
  // Accept the project's four-part stable and "0.3.8beta" legacy version spellings.
  if (typeof value !== 'string' || value.length > 64) return null;
  const match = /^(\d+(?:\.\d+){1,3})(?:-?([A-Za-z][0-9A-Za-z.-]*))?$/.exec(value);
  if (!match) return null;
  const numbers = match[1].split('.').map(Number);
  if (numbers.some(x => !Number.isSafeInteger(x))) return null;
  return { numbers, pre: match[2] ? match[2].toLowerCase().split('.') : null };
}
function compareVersions(a, b) {
  const aa = parts(a), bb = parts(b); if (!aa || !bb) return null;
  for (let i = 0; i < 4; i++) {
    const diff = (aa.numbers[i] || 0) - (bb.numbers[i] || 0); if (diff) return Math.sign(diff);
  }
  if (!aa.pre && !bb.pre) return 0;
  if (!aa.pre || !bb.pre) return aa.pre ? -1 : 1;
  for (let i = 0; i < Math.max(aa.pre.length, bb.pre.length); i++) {
    const x = aa.pre[i], y = bb.pre[i]; if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { const xx = BigInt(x), yy = BigInt(y); if (xx !== yy) return xx > yy ? 1 : -1; continue; }
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
function version(value) { if (!parts(value)) fail('COMPONENT_VERSION', '版本号需为数字分段，可带 beta 等预发布标记。'); }
function checkBounds(min, max) {
  if (min !== undefined) version(min);
  if (max !== undefined) version(max);
  if (min !== undefined && max !== undefined && compareVersions(min, max) > 0) fail('COMPONENT_VERSION', '版本范围的最小值不能大于最大值。');
}
function inRange(value, min, max) {
  if (!parts(value)) return false;
  return (min === undefined || compareVersions(value, min) >= 0) && (max === undefined || compareVersions(value, max) <= 0);
}
function https(url) {
  if (!text(url, 500)) return false;
  try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search; } catch { return false; }
}
function validateComponent(c) {
  fields(c, ['schemaVersion', 'componentId', 'displayName', 'version', 'channel', 'managerMinVersion', 'managerMaxVersion', 'architectures', 'supportedApis', 'files', 'dependencies', 'conflicts', 'rollbackProtocol', 'source', 'license']);
  if (c.schemaVersion !== 2 || c.componentId !== 'nr-before-sr' || !text(c.displayName) || !CHANNELS.has(c.channel)) fail('COMPONENT_SCHEMA', '当前组件契约仅开放 NR before SR；其他 DLL 安装策略尚未开放。');
  version(c.version); version(c.managerMinVersion); checkBounds(c.managerMinVersion, c.managerMaxVersion);
  if (!uniqueStrings(c.architectures, new Set(['x64']), 1, 1) || !uniqueStrings(c.supportedApis, APIS, 1, 4)) fail('COMPONENT_SCHEMA', '组件架构或 API 清单无效。');
  if (c.rollbackProtocol !== 'manager-journal-v1') fail('ROLLBACK_PROTOCOL', '不支持此恢复协议，不能安全安装该组件。');
  if (!Array.isArray(c.files) || c.files.length < 1 || c.files.length > 2) fail('COMPONENT_SCHEMA', '需要一个 addon 和可选的 NR runtime。');
  const names = new Set(); let addons = 0;
  for (const f of c.files) {
    fields(f, ['path', 'role', 'sha256', 'size']); const name = leaf(f.path).toLowerCase();
    if (names.has(name) || typeof f.sha256 !== 'string' || !HASH.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 64 || f.size > 256 * 1024 * 1024) fail('COMPONENT_FILE', '组件文件名、大小或校验值无效。');
    names.add(name);
    if (f.role === 'addon' && name.endsWith('.addon64')) addons++;
    else if (f.role !== 'nr-runtime' || name !== 'nvngx_dlssnr.dll') fail('PROTECTED_FILE', '组件清单不能授予覆盖代理或系统 DLL 的权限。');
  }
  if (addons !== 1) fail('COMPONENT_FILE', '组件必须且只能包含一个 addon。');
  if (!Array.isArray(c.dependencies) || c.dependencies.length > 8 || !Array.isArray(c.conflicts) || c.conflicts.length > 16) fail('COMPONENT_SCHEMA', '依赖或冲突清单无效。');
  const deps = new Set();
  for (const d of c.dependencies) {
    fields(d, ['componentId', 'minVersion', 'maxVersion', 'capabilities']);
    if (!['reshade', 'nr-runtime'].includes(d.componentId) || deps.has(d.componentId) || !uniqueStrings(d.capabilities, new Set(['addon-support']), 0, 1)) fail('COMPONENT_DEPENDENCY', '依赖项未知或重复，不能静默忽略。');
    deps.add(d.componentId); checkBounds(d.minVersion, d.maxVersion);
  }
  for (const cfl of c.conflicts) {
    fields(cfl, ['componentId', 'fileName']);
    if ((cfl.componentId === undefined) === (cfl.fileName === undefined)) fail('COMPONENT_CONFLICT', '冲突项应只声明组件身份或文件名。');
    if (cfl.componentId !== undefined && !COMPONENTS.has(cfl.componentId)) fail('COMPONENT_CONFLICT', '不认识的冲突组件不能自动放行。');
    if (cfl.fileName !== undefined) leaf(cfl.fileName);
  }
  fields(c.source, ['kind', 'url']); fields(c.license, ['name', 'redistribution', 'url']);
  if (!['local', 'official'].includes(c.source.kind) || (c.source.url !== undefined && !https(c.source.url))) fail('COMPONENT_SOURCE', '组件来源必须是明确的本地来源或无凭据的 HTTPS 地址。');
  if (!text(c.license.name) || !['not-declared', 'allowed', 'not-allowed'].includes(c.license.redistribution) || (c.license.url !== undefined && !https(c.license.url))) fail('COMPONENT_LICENSE', '缺少明确的许可证和再分发说明。');
  return c;
}
function installManifest(c) {
  validateComponent(c);
  return { schema: 1, component: c.componentId, version: c.version, architecture: 'x64', apis: [...c.supportedApis], files: c.files.map(f => ({ ...f })) };
}
function componentForPackage(pkg) {
  if (!pkg.componentManifest) return null; // 0.1 packages remain valid and are not rewritten.
  const c = validateComponent(pkg.componentManifest), m = pkg.manifest, norm = installManifest(c);
  if (norm.version !== m.version || norm.component !== m.component || JSON.stringify(norm.apis) !== JSON.stringify(m.apis) || norm.files.length !== m.files.length || norm.files.some((f, i) => ['path', 'role', 'sha256', 'size'].some(k => f[k] !== m.files[i][k]))) fail('COMPONENT_MISMATCH', '组件身份清单与安装文件清单不一致，请重新导入。');
  return c;
}
function componentBlockers(pkg, report, managerVersion) {
  const c = componentForPackage(pkg); if (!c) return [];
  const blockers = [];
  if (!inRange(managerVersion, c.managerMinVersion, c.managerMaxVersion)) blockers.push(`组件需要管理器 ${c.managerMinVersion}${c.managerMaxVersion ? ' 至 ' + c.managerMaxVersion : ' 或更新版本'}。`);
  // Evidence is supplied by the scanner/curated catalog, NEVER by the package itself.
  const evidence = report.componentEvidence || [];
  for (const d of c.dependencies) {
    const e = evidence.find(e => e.componentId === d.componentId && e.verified === true);
    if (!e || !inRange(e.version, d.minVersion, d.maxVersion) || d.capabilities.some(x => !e.capabilities?.includes(x))) blockers.push(`${d.componentId} 的版本或能力依赖未能核验；人工勾选不能代替已声明依赖的证据。`);
  }
  for (const cf of c.conflicts) {
    const hit = cf.fileName ? report.files.some(f => f.name.toLowerCase() === cf.fileName.toLowerCase()) : (report.files.some(f => f.componentId === cf.componentId) || evidence.some(e => e.componentId === cf.componentId));
    if (hit) blockers.push(`发现组件声明的冲突：${cf.fileName || cf.componentId}。`);
  }
  return blockers;
}
function changeKind(previous, target, identical) {
  if (!previous) return 'install';
  if (previous === target) return identical ? 'verify' : 'rebuild';
  const result = compareVersions(target, previous);
  return result === null ? 'switch' : result < 0 ? 'downgrade' : 'upgrade';
}
module.exports = { validateComponent, installManifest, componentForPackage, componentBlockers, compareVersions, inRange, changeKind };
