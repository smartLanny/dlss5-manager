'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, sha256, digestFile, noLinks, durableWrite, readJson } = require('./safety.cjs');
const { download } = require('./network.cjs');
const { readZip, peBytes } = require('./packages.cjs');
const { powershell } = require('./platform.cjs');

const RUNTIME_PROFILES = Object.freeze({
  'rtx50': { id: 'rtx50', label: 'RTX 50', version: '310.8.0', archive: 'nvngx_dlssnr_310.8.0.zip', url: 'https://github.com/RankFTW/rhi-repo/releases/download/dlssnr-310.8.0/nvngx_dlssnr_310.8.0.zip', archiveSha256: '388c0a7912e15ec911b9c9e11a692142b11fe387ddf2b637d8c358138fffb3ac', experimental: false, notes: '标准 NR runtime；管理器安装路径已验证，真实游戏效果按已有验证记录。' },
  'rtx40': { id: 'rtx40', label: 'RTX 40', version: '310.8.0-RTX40', archive: 'nvngx_dlssnr_310.8.0-RTX40.zip', url: 'https://github.com/RankFTW/rhi-repo/releases/download/dlssnr-310.8.0-RTX40/nvngx_dlssnr_310.8.0-RTX40.zip', archiveSha256: '46124cfaef532ad5f6da07494772ea8c1b3e719f934e254385697f38d1289e3f', experimental: true, notes: '实验性 / 待验证；r3 没有宣称解决 RTX40 MFG #63。' },
  'rtx20-30': { id: 'rtx20-30', label: 'RTX 20/30', version: '310.8.SF-v2', archive: 'nvngx_dlssnr_310.8.SF-v2.zip', url: 'https://github.com/RankFTW/rhi-repo/releases/download/dlssnr-310.8.SF-v2/nvngx_dlssnr_310.8.SF-v2.zip', archiveSha256: '1da35941894994eb087e017577829e492454e9bae3a6a9397027069ceb74955c', experimental: true, notes: '实验性 / 待验证路线。' }
});

function archiveEntryName(name) {
  if (typeof name !== 'string' || name.length > 240 || name.startsWith('/') || name.includes('\\')) fail('RUNTIME_ARCHIVE', '运行组件压缩包路径不安全。');
  const parts = name.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) fail('RUNTIME_ARCHIVE', '运行组件压缩包路径不安全。');
  return name;
}

function profile(id) {
  const value = RUNTIME_PROFILES[id];
  if (!value) fail('GPU_PROFILE_UNKNOWN', '未找到对应显卡运行环境。');
  return value;
}

async function bundledRuntime(profileValue, resourcesRoot) {
  const p = profile(profileValue.id || profileValue);
  if (!profileValue.bundleFile || !resourcesRoot) return null;
  const file = path.join(resourcesRoot, 'components', profileValue.bundleFile);
  await noLinks(file);
  const bytes = await fs.readFile(file);
  if (profileValue.bundleSha256 && sha256(bytes) !== profileValue.bundleSha256) fail('RUNTIME_BUNDLE_DAMAGED', '随包运行环境校验失败，请重新获取安装器。');
  if (!peBytes(bytes)) fail('RUNTIME_ARCHITECTURE', '随包运行环境不是 Windows x64 文件。');
  return { sourceBytes: bytes, source: file, after: sha256(bytes), profile: p, distribution: 'bundled' };
}

async function ensureRuntime(managerRoot, profileValue, progress = () => {}, options = {}) {
  const p = profile(profileValue.id || profileValue);
  const cache = path.join(managerRoot, 'runtime-cache', p.id);
  const target = path.join(cache, 'nvngx_dlssnr.dll');
  const metaFile = path.join(cache, 'runtime.json');
  await noLinks(cache); await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  const cachedMeta = await readJson(metaFile, null), cachedHash = await digestFile(target);
  if (cachedHash && cachedMeta?.profileId === p.id && cachedMeta.archiveSha256 === p.archiveSha256 && cachedMeta.fileSha256 === cachedHash && peBytes(await fs.readFile(target))) {
    return { source: target, after: cachedHash, role: 'nr-runtime', profile: p, distribution: 'cached' };
  }
  const local = await bundledRuntime(profileValue, options.resourcesRoot);
  if (local) {
    await durableWrite(target, local.sourceBytes, true);
    await durableWrite(metaFile, JSON.stringify({ profileId: p.id, archiveSha256: p.archiveSha256, fileSha256: local.after, source: 'offline-bundle' }), true);
    return { source: target, after: local.after, role: 'nr-runtime', profile: p, distribution: 'bundled' };
  }
  progress('正在准备运行环境');
  const bytes = await (options.download || download)(p.url, { maxBytes: 220 * 1024 * 1024, timeout: 30000, headers: { Accept: 'application/zip', 'User-Agent': 'Zhuangjizhai-DLSS5-Manager' } });
  if (sha256(bytes) !== p.archiveSha256) fail('RUNTIME_CHECKSUM', '运行环境下载校验失败，游戏文件尚未修改。');
  const entries = readZip(bytes, { maxPackage: 220 * 1024 * 1024, maxFile: 256 * 1024 * 1024, maxEntries: 64, minEntries: 1, nameValidator: archiveEntryName });
  const matches = [...entries.values()].filter(x => path.posix.basename(x.name).toLowerCase() === 'nvngx_dlssnr.dll');
  if (matches.length !== 1 || !peBytes(matches[0].bytes)) fail('RUNTIME_PAYLOAD', '运行环境压缩包中没有唯一的 Windows x64 文件。');
  const dll = matches[0].bytes, fileHash = sha256(dll);
  await durableWrite(target, dll, true);
  await durableWrite(metaFile, JSON.stringify({ profileId: p.id, archiveSha256: p.archiveSha256, fileSha256: fileHash, source: p.url }), true);
  progress('运行环境已准备好');
  return { source: target, after: fileHash, role: 'nr-runtime', profile: p, distribution: 'online' };
}

module.exports = { RUNTIME_PROFILES, profile, archiveEntryName, bundledRuntime, ensureRuntime, powershell };
