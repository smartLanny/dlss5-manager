'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { fail, assertGameRoot, noLinks, inside } = require('./safety.cjs');
const { AC, peInfo, steamRoots } = require('./platform.cjs');
const AUXILIARY = /(?:^|[^a-z])steam(?:webhelper)?(?:\.exe)?$|launcher|launchpad|redlauncher|unins|uninstall|setup|crash|crashhandler|crashreporter|reporter|updater|installer|redist|cef(?:subprocess)?|webview|webhelper|unitycrash|vcredist|benchmark|benchmarkhelper|record|service|anticheat|easyanticheat|battleye|helper/i;
const ONLINE_IDS = new Set(['730', '570', '578080', '1172470', '359550', '236390', '1085660', '1938090', '440', '230410', '1599340', '381210', '252490', '552990']);
function parseVdf(text) {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}]|\/\/[^\n]*|[^\s{}"]+/g) || [];
  let i = 0, depth = 0;
  const unquote = t => t.startsWith('"') ? t.slice(1, -1).replace(/\\([\\"])/g, '$1') : t;
  function object(nested) {
    if (++depth > 20) fail('VDF_INVALID', 'Steam 库文件层级异常。');
    const obj = Object.create(null);
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t.startsWith('//')) continue;
      if (t === '}') { if (!nested) fail('VDF_INVALID', 'Steam 库文件格式异常。'); depth--; return obj; }
      if (t === '{') fail('VDF_INVALID', 'Steam 库文件格式异常。');
      const key = unquote(t); let next = tokens[i++];
      while (next?.startsWith('//')) next = tokens[i++];
      if (!next || next === '}') fail('VDF_INVALID', 'Steam 库文件不完整。');
      obj[key] = next === '{' ? object(true) : unquote(next);
    }
    depth--; if (nested) fail('VDF_INVALID', 'Steam 库文件不完整。'); return obj;
  }
  return object(false);
}
// Read-only discovery; incomplete scans must never be interpreted as safe.
async function walk(root, options = {}) {
  const files = [], antiCheat = [], problems = [];
  let seen = 0;
  const max = options.maxEntries || 30000, maxDepth = options.maxDepth ?? 8;
  async function visit(dir, depth) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { problems.push('部分文件夹无法读取'); return; }
    for (const e of entries) {
      if (++seen > max) { if (!problems.includes('文件数量超过扫描上限')) problems.push('文件数量超过扫描上限'); return; }
      const full = path.join(dir, e.name), rel = path.relative(root, full);
      if (AC.test(e.name) || /^ace$/i.test(e.name)) antiCheat.push(rel);
      if (e.isSymbolicLink()) { problems.push('检测到未扫描的链接目录或文件'); continue; }
      if (e.isDirectory()) {
        if (e.name === '.git') continue;
        if (options.discoveryOnly && /^(paks|movies|screenshots|textures|audio|reshade-shaders)$/i.test(e.name)) continue;
        if (depth >= maxDepth) { problems.push('部分目录超过扫描深度'); continue; }
        await visit(full, depth + 1);
      } else if (e.isFile()) files.push({ path: full, relative: rel, name: e.name });
    }
  }
  await noLinks(root); await visit(root, 0);
  return { files, antiCheat, problems: [...new Set(problems)] };
}
function normalizedName(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function likelyGameExecutable(file, root) {
  const relative = path.relative(root, file.path).replace(/\\/g, '/');
  const name = path.basename(file.name, '.exe');
  if (AUXILIARY.test(file.name) || AUXILIARY.test(relative)) return false;
  if (/^(?:dllhost|conhost|explorer|unins|setup|install|update|patch|crash|report)/i.test(name)) return false;
  return relative.split('/').length <= 7;
}
function candidateScore(file, pe, root, options = {}) {
  const relative = path.relative(root, file.path).replace(/\\/g, '/');
  const lower = relative.toLowerCase();
  const stem = normalizedName(path.basename(file.name, '.exe'));
  const game = normalizedName(options.gameName);
  const preferred = (options.preferredExecutables || []).map(normalizedName);
  let score = pe.apis.length * 24 + (pe.arch === 'x64' ? 16 : -50);
  if (preferred.some(x => x && (stem === x || stem.includes(x) || x.includes(stem)))) score += 90;
  if (game && (stem === game || stem.includes(game) || game.includes(stem))) score += 36;
  if (/^(?:bin\/x64|binaries\/win64|engine\/binaries\/win64)\//i.test(lower)) score += 30;
  if (!lower.includes('/')) score += 16;
  if (/shipping|game|client|win64/i.test(stem)) score += 8;
  return score;
}
async function candidates(root, options = {}) {
  const result = await walk(root, { maxEntries: 18000, maxDepth: 12, discoveryOnly: true });
  const exes = result.files.filter(f => /\.exe$/i.test(f.name) && likelyGameExecutable(f, root)).slice(0, 150);
  const list = [];
  for (const f of exes) {
    const pe = await peInfo(f.path);
    if (!pe.valid || pe.dll) continue;
    const st = await fs.stat(f.path);
    list.push({ path: f.path, arch: pe.arch, apis: pe.apis, modifiedAt: st.mtime.toISOString(), size: st.size, score: candidateScore(f, pe, root, options) });
  }
  return list.sort((a, b) => b.score - a.score);
}
async function discoverSteam(extraRoots = []) {
  const roots = new Set([...(await steamRoots()), ...extraRoots]);
  const notes = [];
  for (const root of [...roots]) {
    try {
      const file = path.join(root, 'steamapps', 'libraryfolders.vdf'); await noLinks(file);
      const stat = await fs.stat(file); if (stat.size > 1024 * 1024) throw new Error('oversize');
      const value = parseVdf(await fs.readFile(file, 'utf8')).libraryfolders || {};
      for (const entry of Object.values(value)) if (entry && typeof entry.path === 'string') roots.add(path.resolve(entry.path));
    } catch { notes.push('部分 Steam 库配置无法读取，可手动选择 Steam 目录或添加 EXE。'); }
  }
  const games = [];
  for (const root of roots) {
    let list;
    try { await noLinks(root); list = await fs.readdir(path.join(root, 'steamapps')); } catch { continue; }
    for (const name of list.filter(n => /^appmanifest_\d+\.acf$/.test(n)).slice(0, 1000)) {
      try {
        const file = path.join(root, 'steamapps', name); await noLinks(file);
        if ((await fs.stat(file)).size > 1024 * 1024) continue;
        const a = parseVdf(await fs.readFile(file, 'utf8')).AppState;
        if (!a || !/^\d+$/.test(a.appid) || typeof a.installdir !== 'string' || /[\\/:]|^\.+$/.test(a.installdir)) continue;
        const gameRoot = path.resolve(root, 'steamapps', 'common', a.installdir);
        if (!inside(path.join(root, 'steamapps', 'common'), gameRoot)) continue;
        await assertGameRoot(gameRoot);
        games.push({ id: crypto.randomUUID(), name: String(a.name || a.installdir).slice(0, 160), scanRoot: gameRoot, exe: '', api: '', kind: ONLINE_IDS.has(a.appid) ? 'online' : 'unknown', steamId: a.appid, appId: a.appid, source: 'steam', steamRoot: root, libraryId: a.appid, launchExecutables: manifestExecutables(a), candidates: [], installed: null });
      } catch { notes.push('部分游戏清单已失效，未自动添加。'); }
    }
  }
  return { games, notes: [...new Set(notes)] };
}
function manualScanRoot(exe) {
  const dir = path.dirname(exe);
  const child = path.basename(dir), parent = path.basename(path.dirname(dir)), grand = path.basename(path.dirname(path.dirname(dir)));
  if (/^(win64|win32)$/i.test(child) && /^binaries$/i.test(parent) && /^engine$/i.test(grand)) return path.dirname(path.dirname(path.dirname(dir)));
  if (/^(win64|win32)$/i.test(child) && /^binaries$/i.test(parent)) return path.dirname(path.dirname(dir));
  if (/^x64$/i.test(child) && /^bin$/i.test(parent)) return path.dirname(path.dirname(dir));
  return dir;
}
function manifestExecutables(value) {
  const result = [];
  const visit = item => {
    if (typeof item === 'string' && /\.exe$/i.test(item) && !AUXILIARY.test(path.basename(item))) result.push(path.basename(item));
    else if (item && typeof item === 'object') for (const v of Object.values(item)) visit(v);
  };
  visit(value); return [...new Set(result)].slice(0, 32);
}
module.exports = { parseVdf, walk, candidates, discoverSteam, manualScanRoot, manifestExecutables, ONLINE_IDS, AUXILIARY };
