'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { noLinks, durableWrite, validId } = require('./safety.cjs');
const { download } = require('./network.cjs');
const lastAttempt = new Map();
function posterUrls(id) {
  if (!/^[0-9]{1,12}$/.test(String(id))) return [];
  return ['library_600x900.jpg', 'header.jpg'].map(file => `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${id}/${file}`);
}
async function artwork(game, root, nativeImage, online = true) {
  const cache = path.join(root, 'artwork'), target = path.join(cache, validId(game.id) + '.jpg');
  await noLinks(target);
  try { if ((await fs.stat(target)).size <= 4 * 1024 * 1024) return await fs.readFile(target); } catch {}
  if ((lastAttempt.get(game.id) || 0) > Date.now() - 5 * 60 * 1000) return null;
  lastAttempt.set(game.id, Date.now());
  async function normalized(bytes) {
    if (bytes.length > 8 * 1024 * 1024) return null;
    const image = nativeImage.createFromBuffer(bytes), size = image.getSize();
    if (image.isEmpty() || size.width < 30 || size.height < 30 || size.width * size.height > 40000000) return null;
    const clean = image.resize({ width: Math.min(size.width, 450) }).toJPEG(85);
    await noLinks(cache); await fs.mkdir(cache, { recursive: true, mode: 0o700 });
    try { await durableWrite(target, clean, true); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    return clean;
  }
  if (game.steamRoot && /^[0-9]{1,12}$/.test(game.steamId || '')) {
    const file = path.join(game.steamRoot, 'appcache', 'librarycache', `${game.steamId}_library_600x900.jpg`);
    try { await noLinks(file); if ((await fs.stat(file)).size <= 8 * 1024 * 1024) { const b = await normalized(await fs.readFile(file)); if (b) return b; } } catch {}
  }
  if (!online) return null;
  for (const url of posterUrls(game.steamId)) { try { const b = await normalized(await download(url, { timeout: 8000 })); if (b) return b; } catch {} }
  return null;
}
module.exports = { posterUrls, artwork };
