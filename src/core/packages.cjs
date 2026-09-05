'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { fail, leaf, sha256, HASH, noLinks, durableWrite } = require('./safety.cjs');
const { APIS } = require('./platform.cjs');
const MAX_FILE = 256 * 1024 * 1024, MAX_PACKAGE = 512 * 1024 * 1024;
const CATALOG = [
  { version: '0.3.3.4', title: '稳定版', description: '日常使用，优先选择这一版。', channel: 'stable', badge: '推荐', compatibility: '待验证' },
  { version: '0.3.8beta', title: 'UI 调整', description: '体验调整后的插件菜单与交互。', channel: 'beta', badge: '测试版', compatibility: '待验证' },
  { version: '0.4.2beta', title: '色彩 · 效率强化', description: '体验色彩与效率方面的实验改进。', channel: 'beta', badge: '测试版', compatibility: '待验证' }
];
function versionName(v) {
  if (typeof v !== 'string' || !/^[0-9][0-9A-Za-z.-]{0,63}$/.test(v)) fail('VERSION_INVALID', '版本号只允许数字、英文字母、小数点和短横线。');
  return v;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_PACKAGE) fail('PACKAGE_SIZE', '更新包为空或过大。');
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end < 0) fail('ZIP_INVALID', '更新包损坏，或不是支持的 ZIP 格式。');
  const count = buffer.readUInt16LE(end + 10), centralSize = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== count || count < 2 || count > 32 || start + centralSize !== end) fail('ZIP_INVALID', '不支持分卷、ZIP64 或包含过多文件的更新包。');
  let pos = start, total = 0;
  const entries = new Map(), spans = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || buffer.readUInt32LE(pos) !== 0x02014b50) fail('ZIP_INVALID', '更新包目录损坏。');
    const flags = buffer.readUInt16LE(pos + 8), method = buffer.readUInt16LE(pos + 10), crc = buffer.readUInt32LE(pos + 16), compressed = buffer.readUInt32LE(pos + 20), size = buffer.readUInt32LE(pos + 24);
    const nl = buffer.readUInt16LE(pos + 28), extra = buffer.readUInt16LE(pos + 30), comment = buffer.readUInt16LE(pos + 32), attr = buffer.readUInt32LE(pos + 38), local = buffer.readUInt32LE(pos + 42);
    if (pos + 46 + nl + extra + comment > end || !nl || flags & ~0x808 || ![0, 8].includes(method) || ((attr >>> 16) & 0xf000) === 0xa000 || size > MAX_FILE) fail('ZIP_UNSUPPORTED', '更新包包含加密、链接或不支持的文件。');
    const name = leaf(buffer.toString('utf8', pos + 46, pos + 46 + nl));
    const key = name.toLowerCase();
    if (entries.has(key)) fail('ZIP_DUPLICATE', '更新包中有重名文件，已拒绝导入。');
    if (local + 30 > start || buffer.readUInt32LE(local) !== 0x04034b50) fail('ZIP_INVALID', '更新包文件头损坏。');
    const lnl = buffer.readUInt16LE(local + 26), lel = buffer.readUInt16LE(local + 28), dataStart = local + 30 + lnl + lel;
    if (buffer.readUInt16LE(local + 6) !== flags || buffer.readUInt16LE(local + 8) !== method || buffer.toString('utf8', local + 30, local + 30 + lnl) !== name || dataStart + compressed > start) fail('ZIP_INVALID', '更新包文件头和清单不一致。');
    if (spans.some(([a, b]) => local < b && dataStart + compressed > a)) fail('ZIP_INVALID', '更新包文件区域重叠。');
    spans.push([local, dataStart + compressed]);
    total += size;
    if (total > MAX_PACKAGE) fail('PACKAGE_SIZE', '更新包解压后过大，已停止。');
    const packed = buffer.subarray(dataStart, dataStart + compressed);
    let bytes;
    try { bytes = method === 0 ? Buffer.from(packed) : zlib.inflateRawSync(packed, { maxOutputLength: Math.max(size, 1) }); }
    catch { fail('ZIP_INVALID', '更新包解压校验失败。'); }
    if (bytes.length !== size || crc32(bytes) !== crc) fail('ZIP_CHECKSUM', '更新包损坏，请重新获取。');
    entries.set(key, { name, bytes });
    pos += 46 + nl + extra + comment;
  }
  if (pos !== end) fail('ZIP_INVALID', '更新包目录长度不匹配。');
  return entries;
}
function writeZip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, bytes] of entries) {
    const n = Buffer.from(leaf(name)), crc = crc32(bytes), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(n.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, bytes); centrals.push(central, n); offset += local.length + n.length + bytes.length;
  }
  const c = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(c.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, c, end]);
}
function peBytes(bytes) {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') return false;
  const p = bytes.readUInt32LE(60);
  return p <= bytes.length - 24 && bytes.readUInt32LE(p) === 0x4550 && bytes.readUInt16LE(p + 4) === 0x8664 && !!(bytes.readUInt16LE(p + 22) & 0x2000);
}
function validateManifest(manifest) {
  if (!manifest || manifest.schema !== 1 || manifest.component !== 'nr-before-sr' || manifest.architecture !== 'x64') fail('MANIFEST_INVALID', '需要契约版本 1 的 NR before SR x64 更新包。');
  versionName(manifest.version);
  if (!Array.isArray(manifest.apis) || !manifest.apis.length || manifest.apis.some(x => !APIS.includes(x))) fail('API_INVALID', '更新包没有声明支持的图形 API。');
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 2) fail('MANIFEST_INVALID', 'Beta 仅支持一个 addon 和可选的 NR runtime。');
  const names = new Set(); let addons = 0;
  for (const f of manifest.files) {
    if (!f || !HASH.test(f.sha256)) fail('HASH_INVALID', '更新包缺少有效的 SHA-256 清单。');
    const n = leaf(f.path).toLowerCase();
    if (names.has(n)) fail('MANIFEST_INVALID', '文件清单存在重名。'); names.add(n);
    if (f.role === 'addon' && n.endsWith('.addon64')) addons++;
    else if (!(f.role === 'nr-runtime' && n === 'nvngx_dlssnr.dll')) fail('PROTECTED_FILE', '更新包尝试修改不允许的 DLL。Beta 不替换图形代理、系统 DLL 或游戏引擎文件。');
  }
  if (addons !== 1) fail('MANIFEST_INVALID', '更新包必须且只能包含一个 x64 addon。');
  return manifest;
}
async function importPackage(file, options, cacheRoot, trustedKeys = {}) {
  await noLinks(file);
  const st = await fs.stat(file);
  if (!st.isFile() || st.size > MAX_PACKAGE) fail('PACKAGE_SIZE', '文件过大或不是普通文件。');
  const bytes = await fs.readFile(file), sourceHash = sha256(bytes);
  if (options.expectedHash && (!HASH.test(options.expectedHash.toLowerCase()) || sourceHash !== options.expectedHash.toLowerCase())) fail('HASH_MISMATCH', 'SHA-256 与发布者提供的校验值不一致，已拒绝导入。');
  let manifest, payloads, trust = options.expectedHash ? 'checksum-matched' : 'local-unverified';
  if (path.extname(file).toLowerCase() === '.addon64') {
    const filename = leaf(path.basename(file));
    manifest = validateManifest({ schema: 1, component: 'nr-before-sr', version: versionName(options.version), architecture: 'x64', apis: [options.api], description: '用户从本地导入；版本和 API 由用户依据发布说明填写。', files: [{ path: filename, role: 'addon', sha256: sourceHash }] });
    payloads = new Map([[filename.toLowerCase(), { name: filename, bytes }]]);
  } else {
    payloads = readZip(bytes);
    const record = payloads.get('manifest.json');
    if (!record || record.bytes.length > 64 * 1024) fail('MANIFEST_INVALID', '更新包缺少 manifest.json。普通压缩包请先解压，再导入其中的 addon。');
    let envelope;
    try { envelope = JSON.parse(record.bytes.toString('utf8')); } catch { fail('MANIFEST_INVALID', '更新清单格式有误。'); }
    manifest = validateManifest(envelope.manifest);
    if (envelope.signature || envelope.keyId) {
      const key = trustedKeys[envelope.keyId];
      if (!key) fail('UNKNOWN_SIGNER', '发布签名尚未受此管理器信任，请更新管理器，不要绕过验证。');
      let ok = false;
      try { ok = crypto.verify(null, Buffer.from(canonical(manifest)), key, Buffer.from(envelope.signature, 'base64')); } catch { /* Fail closed. */ }
      if (!ok) fail('SIGNATURE_INVALID', '发布者签名验证失败，不能安装。');
      trust = 'publisher-verified';
    }
    if (payloads.size !== manifest.files.length + 1) fail('EXTRA_PAYLOAD', '更新包含有未声明文件，已拒绝导入。');
  }
  if (trust !== 'publisher-verified' && options.acceptLocal !== true) fail('SOURCE_CONFIRMATION', '请确认文件来自装机宅发布渠道。哈希校验不等于发布者身份认证。');
  for (const f of manifest.files) {
    const p = payloads.get(f.path.toLowerCase());
    if (!p || sha256(p.bytes) !== f.sha256 || !peBytes(p.bytes)) fail('PAYLOAD_INVALID', '插件架构、文件类型或 SHA-256 不匹配，需要有效的 x64 DLL / addon。');
  }
  const id = crypto.randomUUID(), dir = path.join(cacheRoot, id);
  await noLinks(cacheRoot); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try { for (const f of manifest.files) await durableWrite(path.join(dir, f.path), payloads.get(f.path.toLowerCase()).bytes, true); }
  catch (e) { await fs.rm(dir, { recursive: true, force: true }); throw e; }
  return { id, manifest, sourceHash, trust, importedAt: new Date().toISOString(), compatibility: '待验证' };
}
module.exports = { CATALOG, MAX_PACKAGE, versionName, canonical, crc32, readZip, writeZip, peBytes, validateManifest, importPackage };
