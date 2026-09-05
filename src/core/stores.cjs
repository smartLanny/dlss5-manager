'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertGameRoot, noLinks, inside } = require('./safety.cjs');
const IMAGE_KEYS = ['BackgroundImageUrl', 'BackgroundImageUrlWide', 'BackgroundImageUrlTall', 'VerticalImageUrl', 'DisplayImageUrl', 'ImageUrl'];
function imageUrls(value) { return IMAGE_KEYS.map(k => value?.[k]).filter(x => typeof x === 'string' && /^https:\/\//i.test(x)).slice(0, 4); }
function launcherEntries(value) {
  if (!Array.isArray(value?.InstallationList)) return [];
  return value.InstallationList.filter(x => x && typeof x.InstallLocation === 'string' && typeof (x.DisplayName || x.AppName) === 'string');
}
async function discoverEpic(manifestRoot = process.platform === 'win32' && process.env.ProgramData ? path.join(process.env.ProgramData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests') : null) {
  if (!manifestRoot) return [];
  let names; try { await noLinks(manifestRoot); names = await fs.readdir(manifestRoot); } catch { names = []; }
  const games = [];
  for (const name of names.filter(n => n.endsWith('.item')).slice(0, 1500)) {
    try {
      const file = path.join(manifestRoot, name); await noLinks(file); if ((await fs.stat(file)).size > 512 * 1024) continue;
      const j = JSON.parse(await fs.readFile(file, 'utf8'));
      if (typeof j.InstallLocation !== 'string' || typeof j.DisplayName !== 'string' || j.bIsIncompleteInstall) continue;
      const root = await assertGameRoot(j.InstallLocation); const exe = typeof j.LaunchExecutable === 'string' ? path.resolve(root, j.LaunchExecutable) : '';
      games.push({ id: crypto.randomUUID(), name: j.DisplayName.slice(0,160), scanRoot: root, exe: exe && inside(root,exe) ? exe : '', api: '', kind: 'unknown', source: 'epic', catalogId: String(j.CatalogItemId || j.AppName || '').slice(0, 160), epicAppName: String(j.AppName || '').slice(0, 160), launchExecutables: j.LaunchExecutable ? [path.basename(j.LaunchExecutable)] : [], artworkUrls: imageUrls(j), candidates: [], installed: null });
    } catch { /* An invalid manifest is ignored, never executed. */ }
  }
  const launcherFile = path.join(path.dirname(manifestRoot), 'LauncherInstalled.dat');
  try {
    await noLinks(launcherFile); if ((await fs.stat(launcherFile)).size <= 2 * 1024 * 1024) {
      const rows = launcherEntries(JSON.parse(await fs.readFile(launcherFile, 'utf8')));
      for (const j of rows) {
        try {
          const root = await assertGameRoot(j.InstallLocation);
          if (games.some(g => g.scanRoot.toLowerCase() === root.toLowerCase())) continue;
          const exe = typeof j.LaunchExecutable === 'string' ? path.resolve(root, j.LaunchExecutable) : '';
          games.push({ id: crypto.randomUUID(), name: String(j.DisplayName || j.AppName).slice(0, 160), scanRoot: root, exe: exe && inside(root, exe) ? exe : '', api: '', kind: 'unknown', source: 'epic', catalogId: String(j.AppName || '').slice(0, 160), epicAppName: String(j.AppName || '').slice(0, 160), launchExecutables: j.LaunchExecutable ? [path.basename(j.LaunchExecutable)] : [], artworkUrls: imageUrls(j), candidates: [], installed: null });
        } catch { /* An invalid launcher record is ignored. */ }
      }
    }
  } catch { /* LauncherInstalled.dat is optional on Epic installations. */ }
  return games;
}
module.exports = { discoverEpic };
