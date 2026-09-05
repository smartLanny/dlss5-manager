'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, noLinks, sha256, digestFile, durableWrite } = require('./safety.cjs');
const { readZip, peBytes } = require('./packages.cjs');
const { download } = require('./network.cjs');
const PIN = require('../../config/reshade.json');
function unpackOfficial(bytes, pin = PIN) {
  if (bytes.length !== pin.size || sha256(bytes) !== pin.sha256) fail('RESHADE_CHECKSUM', '运行环境下载不完整或已变化。请重试，游戏文件尚未修改。');
  // The fixed, whole-file hash above covers the setup, ZIP and any signing trailer.
  // Some official setup files append signing data AFTER the ZIP end record.
  // Trim that bounded trailer only here; generic user ZIP imports remain strict.
  // This executable is read as data, NEVER launched.
  let end = -1, zipEnd = -1, offset = -1;
  const trailerLimit = 64 * 1024;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557 - trailerLimit); i--) {
    if (bytes.readUInt32LE(i) !== 0x06054b50) continue;
    const candidateEnd = i + 22 + bytes.readUInt16LE(i + 20);
    const candidateOffset = i - bytes.readUInt32LE(i + 12) - bytes.readUInt32LE(i + 16);
    if (candidateEnd > bytes.length || bytes.length - candidateEnd > trailerLimit || candidateOffset < 0 || candidateOffset > 1024 * 1024 || candidateOffset + 4 > i) continue;
    if (bytes.readUInt32LE(candidateOffset) !== 0x04034b50) continue;
    end = i; zipEnd = candidateEnd; offset = candidateOffset; break;
  }
  if (end < 0) fail('RESHADE_ARCHIVE', '无法读取官方运行环境安装包。');
  const entries = readZip(bytes.subarray(offset, zipEnd), { maxPackage: 32 * 1024 * 1024, maxFile: 16 * 1024 * 1024 });
  const dll = entries.get(pin.dll.name.toLowerCase())?.bytes;
  if (!dll || dll.length !== pin.dll.size || sha256(dll) !== pin.dll.sha256 || !peBytes(dll) || !dll.includes(Buffer.from('Searching for add-ons'))) fail('RESHADE_CAPABILITY', '运行环境不具备预期的插件加载能力。');
  return dll;
}
async function ensureReShade(root, progress = () => {}, dependencies = {}) {
  const pin = dependencies.pin || PIN, dir = path.join(root, 'runtime-cache', `reshade-${pin.version}`), target = path.join(dir, 'ReShade64.dll');
  await noLinks(dir); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (await digestFile(target) === pin.dll.sha256) return { source: target, after: pin.dll.sha256, role: 'reshade-loader', version: pin.version };
  // Tampered cache is not overwritten silently. It is outside the game and can be replaced after retaining it.
  if (await digestFile(target)) await fs.rename(target, path.join(dir, `changed-${Date.now()}.bin`));
  progress('正在准备 ReShade 运行环境');
  const bytes = await (dependencies.download || download)(pin.url, { maxBytes: pin.size, headers: { Referer: 'https://reshade.me/', 'User-Agent': 'Zhuangjizhai-DLSS5-Manager' } });
  const dll = unpackOfficial(bytes, pin);
  await durableWrite(target, dll, true);
  progress('运行环境已准备好');
  return { source: target, after: pin.dll.sha256, role: 'reshade-loader', version: pin.version };
}
function loaderName(api) { return ['DX11', 'DX12'].includes(api) ? 'dxgi.dll' : api === 'OpenGL' ? 'opengl32.dll' : null; }
function validateLoaderFile(f) {
  if (f.role !== 'reshade-loader' || !['dxgi.dll', 'opengl32.dll'].includes(f.name.toLowerCase())) fail('PROTECTED_FILE', '不是允许管理的运行环境文件。');
  const hashes = [f.sha256, f.before, f.after, f.baselineHash].filter(x => x !== undefined && x !== null);
  if (!hashes.length || hashes.some(h => !require('../../config/loader-evidence.json').some(k => k.sha256 === h && k.architecture === 'x64' && k.componentId === 'reshade'))) fail('PROTECTED_FILE', '未知加载器不能自动替换，原文件保持不动。');
  return f.name;
}
module.exports = { PIN, unpackOfficial, ensureReShade, loaderName, validateLoaderFile };
