'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { noLinks, durableWrite, validId } = require('./safety.cjs');
const { download } = require('./network.cjs');

const lastAttempt = new Map();
const MAX_IMAGE = 8 * 1024 * 1024;
function artworkRoot(managerRoot) { return path.join(path.dirname(managerRoot), 'cache', 'artwork'); }
function cacheFile(game, managerRoot, kind = 'portrait') { return path.join(artworkRoot(managerRoot), `${validId(game.id)}-${kind}.jpg`); }
function steamUrls(id, kind = 'portrait') {
  if (!/^[0-9]{1,12}$/.test(String(id || ''))) return [];
  const files = kind === 'hero' ? ['library_hero.jpg', 'library_hero_2x.jpg', 'header.jpg'] : ['library_600x900_2x.jpg', 'library_600x900.jpg', 'library_600x900_2x.png', 'header.jpg'];
  const hosts = ['https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps', 'https://steamcdn-a.akamaihd.net/steam/apps'];
  return hosts.flatMap(host => files.map(file => `${host}/${id}/${file}`));
}
function posterUrls(id) { return steamUrls(id, 'portrait'); }
function heroUrls(id) { return steamUrls(id, 'hero'); }
function artworkTitle(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ''); }
async function exactSteamMatch(game, online) {
  if (!online || game.steamId || game.appId || game.source !== 'epic' || !game.name || game.artworkSearchAttempted) return null;
  game.artworkSearchAttempted = true;
  try {
    const query = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(game.name)}&l=english&cc=us`;
    const bytes = await download(query, { timeout: 8000, maxBytes: 2 * 1024 * 1024, headers: { Accept: 'application/json', 'User-Agent': 'Zhuangjizhai-DLSS5-Manager' } });
    const items = JSON.parse(bytes.toString('utf8'))?.items;
    const match = Array.isArray(items) && items.find(item => item?.type === 'app' && artworkTitle(item.name) === artworkTitle(game.name) && /^[0-9]{1,12}$/.test(String(item.id || '')));
    if (!match) return null;
    game.appId = String(match.id); return game.appId;
  } catch { return null; }
}

async function normalize(bytes, nativeImage, target, cache) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_IMAGE) return null;
  const image = nativeImage.createFromBuffer(bytes), size = image.getSize();
  if (image.isEmpty() || size.width < 30 || size.height < 30 || size.width * size.height > 40000000) return null;
  const clean = image.resize({ width: Math.min(size.width, 900) }).toJPEG(85);
  await noLinks(cache); await fs.mkdir(cache, { recursive: true, mode: 0o700 });
  try { await durableWrite(target, clean, true); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  return clean;
}

async function artworkInfo(game, managerRoot, nativeImage, online = true, kind = 'portrait') {
  const cache = artworkRoot(managerRoot), target = cacheFile(game, managerRoot, kind);
  await noLinks(target);
  try { const stat = await fs.stat(target); if (stat.size <= MAX_IMAGE) return { bytes: await fs.readFile(target), cached: true, source: game.artwork?.source || 'cache' }; } catch {}
  const key = `${game.id}:${kind}`;
  if ((lastAttempt.get(key) || 0) > Date.now() - 5 * 60 * 1000) return null;
  lastAttempt.set(key, Date.now());
  await exactSteamMatch(game, online);
  const urls = [];
  if (Array.isArray(game.artworkUrls) && kind === 'portrait') urls.push(...game.artworkUrls);
  if (game.steamId || game.appId) urls.push(...steamUrls(game.steamId || game.appId, kind));
  if (game.steamRoot && (game.steamId || game.appId)) {
    const id = game.steamId || game.appId;
    const names = kind === 'hero' ? [`${id}_library_hero.jpg`, `${id}_library_hero_2x.jpg`, `${id}_header.jpg`] : [`${id}_library_600x900_2x.jpg`, `${id}_library_600x900.jpg`, `${id}_library_600x900_2x.png`, `${id}_header.jpg`];
    const roots = [path.join(game.steamRoot, 'appcache', 'librarycache'), path.join(game.steamRoot, 'config', 'librarycache')];
    urls.unshift(...roots.flatMap(root => names.map(name => path.join(root, name))));
  }
  for (const source of urls) {
    try {
      const bytes = typeof source === 'string' && /^https:\/\//i.test(source) ? (online ? await download(source, { timeout: 8000, maxBytes: MAX_IMAGE }) : null) : await fs.readFile(source);
      const clean = await normalize(bytes, nativeImage, target, cache);
      if (clean) return { bytes: clean, cached: false, source: /^https:\/\//i.test(source) ? (game.source || 'official-cdn') : 'steam-cache', url: /^https:\/\//i.test(source) ? source : null };
    } catch { /* A missing artwork source only results in the safe placeholder. */ }
  }
  return null;
}

async function artwork(game, root, nativeImage, online = true, kind = 'portrait') {
  const result = await artworkInfo(game, root, nativeImage, online, kind);
  return result?.bytes || null;
}

module.exports = { artworkRoot, cacheFile, posterUrls, heroUrls, artworkTitle, exactSteamMatch, artworkInfo, artwork };
