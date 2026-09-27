'use strict';
// Guest NR runtime pins only. Hash match is identity/integrity, not NVIDIA origin or compatibility.
const { fail, HASH, leaf } = require('./safety.cjs');
const { MAX_FILE } = require('./packages.cjs');
const CATALOG = require('../../config/nr-runtimes.json');
const ORIGINS = new Set(['guest']);
const CHANNELS = new Set(['local']);
const VERIFICATIONS = new Set(['unverified']);
const ROLES = new Set(['primary', 'parked']);
const FAMILIES = new Set(['20-30', '40-50']);
const IDS = /^[A-Za-z0-9][A-Za-z0-9.-]{0,31}$/;
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(value, max = 400) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value); }
function fields(value, names, label) {
  if (!plain(value) || Object.keys(value).some(k => !names.includes(k))) fail('RUNTIME_CATALOG', `${label} 含有不支持的字段。`);
}
function forbidUrls(value, trail = 'catalog') {
  if (Array.isArray(value)) return value.forEach((item, i) => forbidUrls(item, `${trail}[${i}]`));
  if (!plain(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (/url|uri|href/i.test(key) || (typeof item === 'string' && /https?:\/\//i.test(item))) fail('RUNTIME_CATALOG', `${trail}.${key} 不得声明下载地址。`);
    forbidUrls(item, `${trail}.${key}`);
  }
}
function nvidiaClaim(value) {
  return typeof value === 'string' && /nvidia|official\s+nvidia|英伟达官方/i.test(value);
}
function loadCatalog(raw = CATALOG) {
  fields(raw, ['schema', 'componentId', 'fileName', 'disclaimer', 'selection', 'candidates'], '运行库目录');
  if (raw.schema !== 1 || raw.componentId !== 'nr-runtime' || raw.fileName !== 'nvngx_dlssnr.dll') fail('RUNTIME_CATALOG', '运行库目录身份无效。');
  if (!text(raw.disclaimer, 800) || !/guest/i.test(raw.disclaimer) || !/not official nvidia/i.test(raw.disclaimer)) fail('RUNTIME_CATALOG', '运行库目录必须标明 guest，且不得声称 NVIDIA 官方来源。');
  fields(raw.selection, ['mode', 'autoDetectGpuFamily'], '运行库选择策略');
  if (raw.selection.mode !== 'explicit' || raw.selection.autoDetectGpuFamily !== false) fail('RUNTIME_CATALOG', '当前只开放显式选择，不能自动按显卡族挑选运行库。');
  if (!Array.isArray(raw.candidates) || raw.candidates.length < 1 || raw.candidates.length > 8) fail('RUNTIME_CATALOG', '运行库候选数量无效。');
  const ids = new Set(), hashes = new Set(), defaults = new Set();
  for (const pin of raw.candidates) {
    fields(pin, ['id', 'label', 'gpuFamily', 'gpuFamilyLabel', 'role', 'defaultForFamily', 'channel', 'origin', 'verification', 'license', 'file', 'transport', 'notes'], '运行库候选');
    if (!IDS.test(pin.id) || ids.has(pin.id) || !text(pin.label, 40) || !FAMILIES.has(pin.gpuFamily) || !text(pin.gpuFamilyLabel, 32)) fail('RUNTIME_CATALOG', '运行库候选编号或显卡族无效。');
    if (!ROLES.has(pin.role) || typeof pin.defaultForFamily !== 'boolean' || !CHANNELS.has(pin.channel) || !ORIGINS.has(pin.origin) || !VERIFICATIONS.has(pin.verification)) fail('RUNTIME_CATALOG', '运行库候选来源、渠道或核验状态无效。');
    if (pin.role === 'parked' && pin.defaultForFamily) fail('RUNTIME_CATALOG', '停用候选不能作为该显卡族的默认运行库。');
    if (pin.defaultForFamily) {
      if (defaults.has(pin.gpuFamily)) fail('RUNTIME_CATALOG', '同一显卡族只能有一个默认运行库。');
      defaults.add(pin.gpuFamily);
    }
    fields(pin.license, ['name', 'redistribution'], '运行库许可');
    if (!text(pin.license.name, 80) || pin.license.redistribution !== 'not-declared') fail('RUNTIME_CATALOG', 'guest 运行库再分发状态必须是 not-declared。');
    fields(pin.file, ['path', 'role', 'size', 'sha256'], '运行库文件');
    if (leaf(pin.file.path) !== raw.fileName || pin.file.role !== 'nr-runtime' || !HASH.test(pin.file.sha256) || hashes.has(pin.file.sha256)) fail('RUNTIME_CATALOG', '运行库文件名或哈希钉无效。');
    if (!Number.isSafeInteger(pin.file.size) || pin.file.size < 64) fail('RUNTIME_CATALOG', '运行库大小无效。');
    if (pin.transport !== undefined) {
      fields(pin.transport, ['kind', 'name', 'sha256', 'size'], '运行库传输钉');
      if (pin.transport.kind !== 'zip' || leaf(pin.transport.name) !== pin.transport.name || !HASH.test(pin.transport.sha256)) fail('RUNTIME_CATALOG', '运行库传输钉无效。');
      if (pin.transport.size !== undefined && (!Number.isSafeInteger(pin.transport.size) || pin.transport.size < 64)) fail('RUNTIME_CATALOG', '运行库传输钉大小无效。');
    }
    if (!text(pin.notes, 240) || nvidiaClaim(pin.notes) || nvidiaClaim(pin.label) || nvidiaClaim(pin.license.name)) fail('RUNTIME_CATALOG', '运行库说明不能声称 NVIDIA 官方来源。');
    ids.add(pin.id); hashes.add(pin.file.sha256);
  }
  forbidUrls(raw);
  return raw;
}
function catalog() { return loadCatalog(); }
function requirePin(id, raw) {
  const pin = loadCatalog(raw).candidates.find(x => x.id === id);
  if (!pin) fail('RUNTIME_UNKNOWN', `未登记的运行库候选：${id}。`);
  return pin;
}
function matchRuntime(file, raw) {
  if (!file || !HASH.test(file.sha256 || '')) return null;
  const pin = loadCatalog(raw).candidates.find(x => x.file.sha256 === file.sha256);
  if (!pin) return null;
  if (file.size !== undefined && file.size !== pin.file.size) fail('RUNTIME_MISMATCH', `运行库大小与目录钉 ${pin.id} 不一致。`);
  return pin;
}
function assertRuntimeMatches(file, pin) {
  const name = file.path ? leaf(file.path).toLowerCase() : pin.file.path;
  if (name !== pin.file.path || file.sha256 !== pin.file.sha256 || file.size !== pin.file.size) fail('RUNTIME_MISMATCH', `输入文件与运行库钉 ${pin.id} 的名称、大小或 SHA-256 不一致。`);
  return pin;
}
function packability(pin) {
  const packableInV1 = pin.file.size <= MAX_FILE;
  return { packableInV1, maxFile: MAX_FILE, reason: packableInV1 ? null : `运行库钉 ${pin.id} 为 ${pin.file.size} 字节，超过现行单文件 ${MAX_FILE} 字节上限，不能打进标准 .dlss5pkg。` };
}
function assertPackable(pin) {
  const status = packability(pin);
  if (!status.packableInV1) fail('RUNTIME_TOO_LARGE', status.reason);
  return status;
}
function describeRuntime(pin) {
  const parked = pin.role === 'parked' || !pin.defaultForFamily ? '，非默认' : '';
  return `guest 运行库（${pin.label} / ${pin.gpuFamilyLabel}${parked}，未核验，非 NVIDIA 官方）`;
}
function summarizePin(pin) {
  if (!pin) return null;
  return { id: pin.id, label: pin.label, gpuFamily: pin.gpuFamily, gpuFamilyLabel: pin.gpuFamilyLabel, role: pin.role, defaultForFamily: pin.defaultForFamily, channel: pin.channel, origin: pin.origin, verification: pin.verification, redistribution: pin.license.redistribution, sha256: pin.file.sha256, size: pin.file.size, packableInV1: packability(pin).packableInV1 };
}
function packageRuntimePin(manifest, raw) {
  const file = manifest?.files?.find(f => f.role === 'nr-runtime');
  return file ? summarizePin(matchRuntime(file, raw)) : null;
}
function runtimeScanFields(pin) {
  return { source: describeRuntime(pin), ownership: 'known-third-party', runtimePin: summarizePin(pin) };
}
module.exports = { loadCatalog, catalog, requirePin, matchRuntime, assertRuntimeMatches, packability, assertPackable, describeRuntime, summarizePin, packageRuntimePin, runtimeScanFields, MAX_FILE };
