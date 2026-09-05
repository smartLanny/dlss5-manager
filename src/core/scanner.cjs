'use strict';
// Safety-only inspection: never loads, executes, patches, renames or deletes a game component.
const path = require('node:path');
const { fail, assertGameRoot, noLinks, digestFile, inside } = require('./safety.cjs');
const { PROXIES, peInfo, metadata, environment } = require('./platform.cjs');
const { walk, ONLINE_IDS, AUXILIARY } = require('./discovery.cjs');
async function scanGame(game, storeRoot) {
  const root = await assertGameRoot(game.scanRoot, storeRoot);
  if (!game.exe || !inside(root, game.exe)) fail('EXE_REQUIRED', '请先选择游戏真正运行的 EXE。');
  const targetRoot = await assertGameRoot(path.dirname(game.exe), storeRoot);
  await noLinks(game.exe);
  const exe = await peInfo(game.exe);
  const result = await walk(root);
  const interesting = result.files.filter(f => PROXIES.has(f.name.toLowerCase()) || /\.addon(?:32|64)$|^nvngx_.*\.dll$|^sl\..*\.dll$|^reshade|^enb|^dxvk/i.test(f.name));
  if (interesting.length > 150) result.problems.push('图形组件过多，需要确认真实游戏目录');
  const selected = interesting.slice(0, 150), meta = {};
  for (let i = 0; i < selected.length; i += 25) Object.assign(meta, await metadata(selected.slice(i, i + 25).map(x => x.path)));
  const files = [];
  for (const f of selected) {
    try {
      const pe = /\.(dll|addon64|addon32)$/i.test(f.name) ? await peInfo(f.path) : null;
      const m = meta[f.path] || {};
      const hash = await digestFile(f.path), receipt = game.installed?.files?.find(x => x.name.toLowerCase() === f.name.toLowerCase() && path.dirname(f.path) === targetRoot);
      const owned = !!receipt && receipt.sha256 === hash;
      const product = `${m.description || ''} ${m.product || ''}`;
      const source = owned ? '管理器安装' : /reshade/i.test(product) ? 'ReShade（按版本资源识别）' : /dxvk/i.test(product) ? 'DXVK' : /enb/i.test(product) ? 'ENB' : /^sl\./i.test(f.name) ? 'Streamline（按文件名识别）' : '来源待确认';
      const proxy = PROXIES.has(f.name.toLowerCase());
      files.push({ ...f, arch: pe?.arch || '不适用', imports: pe?.imports || [], sha256: hash, version: m.version || '未提供', signature: m.signature || '未能验证', signer: m.signer || '', description: m.description || '', source, owned, shared: owned ? '运行时使用仍需检查' : '可能由游戏或其他工具使用', risk: proxy && !/reshade/i.test(source) ? 'high' : owned ? 'low' : 'warning', proxy });
    } catch { result.problems.push('部分组件读取或哈希失败'); }
  }
  const env = await environment(targetRoot, game.exe), blockers = [];
  if (!exe.valid || exe.dll || exe.arch !== 'x64') blockers.push('Beta 仅支持有效的 Windows x64 游戏 EXE。');
  if (AUXILIARY.test(path.basename(game.exe))) blockers.push('当前文件疑似启动器或辅助程序，请重新选择 EXE。');
  if (!game.api) blockers.push('请依据游戏设置或发布说明确认图形 API。');
  if (game.kind !== 'offline') blockers.push(game.kind === 'online' ? '在线或竞技游戏不开放自动安装。' : '游戏类型尚未确认，只支持单机离线目标。');
  if (ONLINE_IDS.has(game.steamId)) blockers.push('该 Steam 游戏属于高风险在线游戏，修改分类不能解除限制。');
  if (result.antiCheat.length || env.antiCheat.length) blockers.push('检测到反作弊组件或服务，已阻止安装。');
  if (!env.verified) blockers.push(env.reason || '无法完成系统安全检查。');
  if (env.running.length) blockers.push('游戏或相关进程仍在运行，请完全退出。');
  blockers.push(...result.problems.map(x => x + '，扫描不完整。'));
  const localProxies = files.filter(f => f.proxy && path.dirname(f.path) === targetRoot);
  for (const f of localProxies) {
    if (f.arch !== 'x64' || !f.source.startsWith('ReShade')) blockers.push(`${f.name} 的加载链无法确认，Beta 只报告，不修改。`);
  }
  if (localProxies.length > 1) blockers.push('检测到多个本地代理 DLL，无法确认安全加载链。');
  const loaderFound = localProxies.some(f => f.source.startsWith('ReShade'));
  const warnings = ['静态扫描不能证明运行时兼容，也不能保证账号安全。', 'Beta 不会安装或替换 ReShade、显卡驱动或图形代理 DLL。'];
  if (!loaderFound) warnings.push('未识别到同目录 ReShade。必须先按教程配置支持 Add-on 的加载环境。');
  return { scannedAt: new Date().toISOString(), targetRoot, scanRoot: root, exe, files, antiCheat: result.antiCheat, environment: env, blockers: [...new Set(blockers)], warnings, loaderFound, compatibility: '待验证' };
}
module.exports = { scanGame };
