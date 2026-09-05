'use strict';
// Safety-only inspection: never loads, executes, patches, renames or deletes a game component.
const path = require('node:path');
const { fail, assertGameRoot, noLinks, digestFile, inside } = require('./safety.cjs');
const { PROXIES, peInfo, metadata, environment } = require('./platform.cjs');
const { loaderStatus } = require('./loader.cjs');
const { walk, ONLINE_IDS, AUXILIARY } = require('./discovery.cjs');
async function scanGame(game, storeRoot, options = {}) {
  const restoring = options.purpose === 'uninstall';
  const root = await assertGameRoot(game.scanRoot, storeRoot);
  if (!game.exe || !inside(root, game.exe)) fail('EXE_REQUIRED', '请先选择游戏真正运行的 EXE。');
  const targetRoot = await assertGameRoot(path.dirname(game.exe), storeRoot);
  await noLinks(game.exe);
  const exe = await peInfo(game.exe).catch(e => {
    if (e.code === 'ENOENT') return { valid: false, arch: '未知', dll: false, imports: [], apis: [] };
    throw e;
  });
  const result = await walk(root);
  const interesting = result.files.filter(f => PROXIES.has(f.name.toLowerCase()) || /\.asi$|\.addon(?:32|64)$|^nvngx_.*\.dll$|^sl\..*\.dll$|^reshade|^enb|^dxvk/i.test(f.name));
  if (interesting.length > 150) result.problems.push('图形组件过多，需要确认真实游戏目录');
  const selected = interesting.slice(0, 150), meta = {};
  for (let i = 0; i < selected.length; i += 25) Object.assign(meta, await metadata(selected.slice(i, i + 25).map(x => x.path)));
  const files = [];
  for (const f of selected) {
    try {
      const pe = /\.(dll|asi|addon64|addon32)$/i.test(f.name) ? await peInfo(f.path) : null;
      const m = meta[f.path] || {};
      const hash = await digestFile(f.path), receipt = game.installed?.files?.find(x => x.name.toLowerCase() === f.name.toLowerCase() && path.dirname(f.path) === targetRoot);
      const owned = !!receipt && receipt.sha256 === hash;
      const product = `${m.description || ''} ${m.product || ''}`;
      const source = owned ? (receipt.role === 'reshade-loader' ? '管理器安装（ReShade）' : '管理器安装') : /reshade/i.test(product) ? 'ReShade（按版本资源识别）' : /dxvk/i.test(product) ? 'DXVK' : /enb/i.test(product) ? 'ENB' : /^sl\./i.test(f.name) ? 'Streamline（按文件名识别）' : '来源待确认';
      const proxy = PROXIES.has(f.name.toLowerCase());
      const approvedLoader = require('../../config/loader-evidence.json').some(k => k.sha256 === hash && k.architecture === pe?.arch);
      const componentId = approvedLoader || receipt?.role === 'reshade-loader' ? 'reshade' : /^sl\./i.test(f.name) ? 'streamline' : /reshade/i.test(source) ? 'reshade' : source === 'DXVK' ? 'dxvk' : source === 'ENB' ? 'enb' : f.name.toLowerCase() === 'nvngx_dlssnr.dll' ? 'nr-runtime' : owned && /\.addon64$/i.test(f.name) ? 'nr-before-sr' : null;
      files.push({ ...f, componentId, ownership: owned ? 'manager-owned' : source === '来源待确认' ? 'unknown' : 'known-third-party', arch: pe?.arch || '不适用', imports: pe?.imports || [], sha256: hash, version: m.version || '未提供', signature: m.signature || '未能验证', signer: m.signer || '', description: m.description || '', source, owned, shared: owned ? '运行时使用仍需检查' : '可能由游戏或其他工具使用', risk: proxy && !/reshade/i.test(source) ? 'high' : owned ? 'low' : 'warning', proxy, loaderCandidate: proxy || /\.asi$/i.test(f.name) });
    } catch { result.problems.push('部分组件读取或哈希失败'); }
  }
  const env = await environment(targetRoot, game.exe), blockers = [], riskWarnings = [];
  const warn = (code, message) => riskWarnings.push({ code, message });
  if (!restoring && (!exe.valid || exe.dll || exe.arch !== 'x64')) blockers.push('这个运行程序不受支持，请选择 Windows x64 游戏。');
  if (!restoring && AUXILIARY.test(path.basename(game.exe))) blockers.push('这是启动器或辅助程序，请识别真正运行的游戏。');
  if (!restoring && !game.api) blockers.push('还未确定游戏运行方式，请启动一次游戏后重新识别。');
  if (game.kind === 'online' || ONLINE_IDS.has(game.steamId)) warn('ONLINE_GAME', '这是在线或竞技游戏，安装模组可能影响启动或账号；仅在游戏允许的环境中测试。');
  if (result.antiCheat.length) warn('ANTI_CHEAT_FILES', '游戏目录存在反作弊组件；本工具不绕过检测，继续安装可能导致拒绝启动或账号风险。');
  if (env.antiCheat.length) warn('ANTI_CHEAT_SERVICE', '检测到正在运行的反作弊服务。切换插件不会绕过它，可能仍被游戏拒绝加载。');
  if (!env.verified) blockers.push(env.reason || '无法确认游戏是否已关闭，请稍后重试。');
  if (env.running.length) blockers.push('游戏仍在运行。请退出游戏后切换版本，避免写入正在使用的文件。');
  if (result.problems.length) warn('SCAN_PARTIAL', '部分目录未完整扫描；只处理确认过的目标文件，其他内容保持不动。');
  const localProxies = files.filter(f => f.proxy && path.dirname(f.path) === targetRoot);
  if (localProxies.some(f => f.arch !== 'x64' || f.componentId !== 'reshade')) warn('UNKNOWN_PROXY', '发现其他图形加载器。它们会原样保留，不覆盖、不改名；插件能否一起工作仍需验证。');
  if (localProxies.length > 1) warn('MULTIPLE_PROXIES', '存在多个加载器，将原样保留；不自动创建额外代理链。');
  const addonConfig = await require('./loader-config.cjs').addonLocation(targetRoot);
  if (addonConfig.state !== 'default') warn('CUSTOM_ADDON_PATH', 'ReShade 使用了自定义或无法读取的插件目录。配置保持原样，本次仅部署到游戏目录，实际加载位置需要确认。');
  const loaderFound = localProxies.some(f => f.componentId === 'reshade');
  const loader = loaderStatus(files, targetRoot, require('../../config/loader-evidence.json'));
  const warnings = ['静态检查不代表已经验证游戏内效果。', ...result.problems, ...riskWarnings.map(w => w.message)];
  return { addonConfig, loader, componentEvidence: loader.componentEvidence, scannedAt: new Date().toISOString(), targetRoot, scanRoot: root, exe, files, antiCheat: result.antiCheat, environment: env, blockers: [...new Set(blockers)], warnings, riskWarnings, loaderFound, compatibility: '待验证' };
}
module.exports = { scanGame };
