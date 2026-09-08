'use strict';
// Read-only executable discovery. A single supported API is evidence, not proof of NR compatibility.
const fs = require('node:fs/promises');
const path = require('node:path');
const { peInfo } = require('./platform.cjs');
const { candidates, AUXILIARY } = require('./discovery.cjs');
const { assertGameRoot, noLinks, inside, digestFile } = require('./safety.cjs');
const API_DLL = { 'd3d11.dll': 'DX11', 'd3d12.dll': 'DX12', 'vulkan-1.dll': 'Vulkan', 'opengl32.dll': 'OpenGL' };
const MARKERS = { D3D11CreateDevice: 'DX11', D3D12CreateDevice: 'DX12', D3D12SDKVersion: 'DX12', vkCreateInstance: 'Vulkan', wglCreateContext: 'OpenGL' };
const EXCLUDED_DEP = /^(?:nvngx|sl\.|dxgi|d3d\d|dinput8|version|winmm|reshade|nvapi|amd|ati)/i;
async function markers(file) {
  await noLinks(file); const h = await fs.open(file, 'r');
  try {
    const st = await h.stat(); if (!st.isFile() || st.size > 256 * 1024 * 1024) return [];
    const found = new Set(), chunk = Buffer.alloc(1024 * 1024 + 64); let carry = 0, pos = 0;
    while (pos < Math.min(st.size, 64 * 1024 * 1024)) {
      const { bytesRead } = await h.read(chunk, carry, 1024 * 1024, pos); if (!bytesRead) break;
      const view = chunk.subarray(0, carry + bytesRead);
      for (const [needle, api] of Object.entries(MARKERS)) if (view.includes(Buffer.from(needle))) found.add(api);
      carry = Math.min(64, view.length); view.copy(chunk, 0, view.length - carry); pos += bytesRead;
    }
    return [...found];
  } finally { await h.close(); }
}
async function detectExecutable(file, root) {
  if (!inside(root, file)) return { api: '', candidates: [], source: 'outside-root', confident: false };
  const pe = await peInfo(file);
  if (!pe.valid || pe.dll || pe.arch !== 'x64' || AUXILIARY.test(path.basename(file))) return { api: '', candidates: [], source: 'not-game', confident: false, arch: pe.arch };
  const direct = new Set(pe.imports.map(n => API_DLL[n]).filter(Boolean));
  const entryMarkers = await markers(file);
  let choices = [...new Set([...direct,...entryMarkers])], source = direct.size ? 'import-table' : 'entry-point-markers';
  const engineApis = new Set();
  {
    // Inspect only engine DLLs directly imported by this EXE, not addons, drivers, or arbitrary trees.
    const names = await fs.readdir(path.dirname(file)); const wanted = pe.imports.filter(n => !EXCLUDED_DEP.test(n)).slice(0, 24);
    for (const n of wanted) {
      const match = names.find(v => v.toLowerCase() === n); if (!match) continue;
      const dep = path.join(path.dirname(file), match); if (!inside(root, dep)) continue;
      const info = await peInfo(dep); if (!info.valid || info.arch !== 'x64') continue;
      for (const a of info.apis) engineApis.add(a);
    }
    if(engineApis.size){source=choices.length?'combined-static':'imported-engine-dll';choices=[...new Set([...choices,...engineApis])];}
  }
  // A DX11 bootstrapper can dynamically choose a different engine renderer.
  // A sole EXE clue therefore cannot opt the player into the DX11 carrier.
  const api = choices.length === 1 && (choices[0]!=='DX11'||engineApis.has('DX11')) ? choices[0] : '';
  return { api, candidates: choices.sort(), source: choices.length ? source : 'unresolved', confident: !!api, runtimeVerified:false, arch: pe.arch, exeHash: await digestFile(file) };
}
async function detectGame(game, storeRoot) {
  await assertGameRoot(game.scanRoot, storeRoot);
  let exe = game.exe;
  // A managed target may never be silently relocated after a game update.
  if (!exe) {
    const choices = await candidates(game.scanRoot); game.candidates = choices;
    const checked = [];
    for (const c of choices.slice(0, 16)) { const evidence = await detectExecutable(c.path, game.scanRoot); checked.push({ ...c, evidence }); }
    const renderers = checked.filter(c => c.evidence.confident);
    if (renderers.length === 1) exe = renderers[0].path;
    else if (checked.length === 1 && checked[0].arch === 'x64') exe = checked[0].path;
    else return { state: 'choose-exe', message: '找到多个运行程序，请启动一次游戏后点“识别运行中的游戏”。', candidates: checked.length };
  }
  const evidence = await detectExecutable(exe, game.scanRoot);
  game.exe = exe;
  // A user choice belongs to the executable path, not a binary hash. Game updates
  // must not turn an explicit DX12 choice back into a weak EXE-only DX11 guess.
  const preference=game.apiPreference;
  const bound=preference&&typeof preference.exe==='string'&&path.resolve(preference.exe).toLowerCase()===path.resolve(exe).toLowerCase()&&Object.values(API_DLL).includes(preference.api);
  if(bound){game.api=preference.api;game.apiEvidence={...evidence,api:game.api,source:'manual',confident:false,runtimeVerified:false,exe,checkedAt:new Date().toISOString()};return {state:'selected',message:'使用为这个 EXE 保存的 API 选择；游戏内兼容性待验证。',...game.apiEvidence};}
  if (game.apiEvidence?.source === 'runtime-modules' && (!game.apiEvidence.exe||game.apiEvidence.exe.toLowerCase()===exe.toLowerCase()) && evidence.exeHash === game.apiEvidence.exeHash) return { state: 'identified', message: '已读取上次运行模块证据', ...game.apiEvidence };
  const keepManual = !preference && game.apiEvidence?.source === 'manual' && (!game.apiEvidence.exe||game.apiEvidence.exe.toLowerCase()===exe.toLowerCase()) && evidence.exeHash && evidence.exeHash === game.apiEvidence.exeHash;
  if (!keepManual) game.api = evidence.api;
  game.apiEvidence = { ...evidence, ...(keepManual ? { source: 'manual', api: game.api, confident: false } : {}), exe, checkedAt: new Date().toISOString() };
  return { state: game.api ? 'identified' : 'needs-observation', message: game.api ? '已识别 API 线索，实际运行方式待验证。' : 'API 待确认：可指定游戏使用的 API，或启动游戏后读取模块线索。', ...game.apiEvidence };
}
module.exports = { API_DLL, markers, detectExecutable, detectGame };
