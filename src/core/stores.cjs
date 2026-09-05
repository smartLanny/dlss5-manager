'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertGameRoot, noLinks, inside } = require('./safety.cjs');
async function discoverEpic(manifestRoot = process.platform === 'win32' && process.env.ProgramData ? path.join(process.env.ProgramData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests') : null) {
  if (!manifestRoot) return [];
  let names; try { await noLinks(manifestRoot); names = await fs.readdir(manifestRoot); } catch { return []; }
  const games = [];
  for (const name of names.filter(n => n.endsWith('.item')).slice(0, 1500)) {
    try {
      const file = path.join(manifestRoot, name); await noLinks(file); if ((await fs.stat(file)).size > 512 * 1024) continue;
      const j = JSON.parse(await fs.readFile(file, 'utf8'));
      if (typeof j.InstallLocation !== 'string' || typeof j.DisplayName !== 'string' || j.bIsIncompleteInstall) continue;
      const root = await assertGameRoot(j.InstallLocation); const exe = typeof j.LaunchExecutable === 'string' ? path.resolve(root, j.LaunchExecutable) : '';
      games.push({ id: crypto.randomUUID(), name: j.DisplayName.slice(0,160), scanRoot: root, exe: exe && inside(root,exe) ? exe : '', api: '', kind: 'unknown', source: 'epic', candidates: [], installed: null });
    } catch { /* An invalid manifest is ignored, never executed. */ }
  }
  return games;
}
module.exports = { discoverEpic };
