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
  let choices = [...direct], source = 'import-table';
  if (!choices.length) { choices = await markers(file); source = 'entry-point-markers'; }
  if (!choices.length) {
    // Inspect only engine DLLs directly imported by this EXE, not addons, drivers, or arbitrary trees.
    const names = await fs.readdir(path.dirname(file)); const wanted = pe.imports.filter(n => !EXCLUDED_DEP.test(n)).slice(0, 24);
    const engineApis = new Set();
    for (const n of wanted) {
      const match = names.find(v => v.toLowerCase() === n); if (!match) continue;
      const dep = path.join(path.dirname(file), match); if (!inside(root, dep)) continue;
      const info = await peInfo(dep); if (!info.valid || info.arch !== 'x64') continue;
      for (const a of info.apis) engineApis.add(a);
    }
    choices = [...engineApis]; source = 'imported-engine-dll';
  }
  const api = choices.length === 1 ? choices[0] : '';
  return { api, candidates: choices.sort(), source: choices.length ? source : 'unresolved', confident: !!api, arch: pe.arch, exeHash: await digestFile(file) };
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
  if (game.apiEvidence?.source === 'runtime-modules' && evidence.exeHash === game.apiEvidence.exeHash) return { state: 'identified', message: '已读取上次运行证据', ...game.apiEvidence };
  // Manual legacy overrides remain available in advanced details, never presented as automatic evidence.
  const keepManual = game.apiEvidence?.source === 'manual' && evidence.exeHash && evidence.exeHash === game.apiEvidence.exeHash;
  if (!keepManual) game.api = evidence.api;
  game.apiEvidence = { ...evidence, ...(keepManual ? { source: 'manual', api: game.api, confident: true } : {}), checkedAt: new Date().toISOString() };
  return { state: game.api ? 'identified' : 'needs-observation', message: game.api ? '已自动识别游戏' : '暂未确定运行方式，请启动一次游戏后识别。', ...game.apiEvidence };
}
module.exports = { API_DLL, markers, detectExecutable, detectGame };
