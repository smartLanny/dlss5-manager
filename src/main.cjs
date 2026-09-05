'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, protocol, net, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { Engine } = require('./core/engine.cjs');
const { PlayerService } = require('./core/player.cjs');
const { registerFeedback } = require('./feedback-ipc.cjs');
const { CATALOG } = require('./core/packages.cjs');
const { discoverSteam, manualScanRoot } = require('./core/discovery.cjs');
const { discoverEpic } = require('./core/stores.cjs');
const { artwork } = require('./core/artwork.cjs');
const { download } = require('./core/network.cjs');
const { peInfo } = require('./core/platform.cjs');
const { fail, validId, inside, noLinks, assertGameRoot, friendlyError, durableWrite } = require('./core/safety.cjs');
const VERSION = require('../package.json').version;
const LINKS = Object.freeze({ bilibili: 'https://space.bilibili.com/941799', releases: 'https://github.com/smartLanny/dlss5-manager/releases', issues: 'https://github.com/smartLanny/dlss5-manager/issues', tutorial: 'https://space.bilibili.com/941799', reshade: 'https://reshade.me/' });
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();
let win, engine, player, operationBusy = false, bundleError = null, waitController = null;
function progress(message) { if (win && !win.isDestroyed()) win.webContents.send('manager:progress', String(message).slice(0, 150)); }
async function publicState() {
  const history = await engine.history();
  return { version: VERSION, platform: process.platform, catalog: CATALOG, games: engine.state.games, packages: engine.state.packages, history: history.map(j => ({ id: j.id, gameId: j.gameId, version: j.version, createdAt: j.createdAt, restoredAt: j.restoredAt, status: j.status, operation: j.operation, fileCount: j.changes.length })), links: LINKS, bundleError, preferences: engine.state.preferences || {}, bundledCount: engine.state.packages.filter(p => p.distribution === 'bundled').length };
}
function senderAllowed(event) { return win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === 'app://ui/index.html'; }
function handle(name, fn, mutates = false) {
  ipcMain.handle(`manager:${name}`, async (event, payload) => {
    if (!senderAllowed(event)) return { ok: false, error: { code: 'IPC_DENIED', message: '请求来源无效。' } };
    if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length > 16384)) return { ok: false, error: { code: 'INPUT_INVALID', message: '请求参数无效。' } };
    if (mutates && operationBusy) return { ok: false, error: { code: 'BUSY', message: '正在处理，请稍候。' } };
    if (mutates) operationBusy = true;
    try { return { ok: true, value: await fn(payload || {}) }; }
    catch (e) { const error = friendlyError(e); if (!name.startsWith('feedback-')) engine.lastEventCode = error.code; return { ok: false, error }; }
    finally { if (mutates) operationBusy = false; }
  });
}
async function addFile(exe) {
  await noLinks(exe); const pe = await peInfo(exe);
  if (!pe.valid || pe.dll || pe.arch !== 'x64') fail('EXE_INVALID', '请选择 Windows x64 游戏程序。');
  const scanRoot = manualScanRoot(exe); await assertGameRoot(scanRoot, engine.root);
  const existing = engine.state.games.find(g => g.exe?.toLowerCase() === exe.toLowerCase());
  if (existing) { existing.hidden = false; await engine.save(); return existing.id; }
  const g = { id: crypto.randomUUID(), name: path.basename(exe, path.extname(exe)).replace(/[-_]Win64[-_]Shipping/i, ''), scanRoot, exe, api: '', kind: 'unknown', source: 'manual', candidates: [], installed: null };
  engine.state.games.push(g); await player.identify(g.id); return g.id;
}
async function scanLibrary(chooseFolder = false) {
  let roots = [];
  if (chooseFolder) { const p = await dialog.showOpenDialog(win, { title: '选择包含 steamapps 的游戏库', properties: ['openDirectory'] }); if (p.canceled) return null; roots = p.filePaths; }
  progress('正在查找游戏');
  const steam = await discoverSteam(roots), epic = await discoverEpic(); let added = 0;
  for (const g of [...steam.games, ...epic]) if (!engine.state.games.some(x => x.scanRoot.toLowerCase() === g.scanRoot.toLowerCase())) { engine.state.games.push(g); added++; }
  await engine.save();
  // Do not spend minutes parsing every game before showing its poster; identify on first selection/install.
  return { added, total: steam.games.length + epic.length, notes: steam.notes };
}
function registerHandlers() {
  registerFeedback({ handle, engine, win, dialog, shell, clipboard });
  handle('state', publicState);
  handle('add-game', async () => {
    const pick = await dialog.showOpenDialog(win, { title: '添加游戏：选择游戏程序', properties: ['openFile'], filters: [{ name: '游戏程序', extensions: ['exe'] }] });
    return pick.canceled ? null : addFile(pick.filePaths[0]);
  }, true);
  handle('scan-library', ({ chooseFolder = false }) => scanLibrary(chooseFolder === true), true);
  handle('identify', ({ gameId }) => player.identify(gameId), true);
  handle('observe', ({ gameId }) => player.observe(gameId), true);
  handle('import', async () => {
    const pick = await dialog.showOpenDialog(win, { title: '选择装机宅发布的插件或更新包', properties: ['openFile', 'multiSelections'], filters: [{ name: '插件 / 更新包', extensions: ['addon64', 'dlss5pkg', 'zip'] }] });
    if (pick.canceled) return null;
    if (pick.filePaths.length > 20) fail('IMPORT_LIMIT', '一次最多导入 20 个版本。');
    const results = [];
    for (const file of pick.filePaths) { progress('正在导入插件'); results.push(await player.import(file)); }
    return results;
  }, true);
  handle('prepare', ({ gameId, packageId, slot }) => {
    if (slot !== undefined && !['A', 'B'].includes(slot)) fail('SLOT_INVALID', '版本槽位无效。');
    return player.prepare(gameId, packageId, slot, progress);
  }, true);
  handle('wait-game', async ({ gameId }) => {
    const g = engine.game(gameId); if (!g.exe) fail('EXE_REQUIRED', '请先识别游戏。');
    waitController = new AbortController();
    try { return await require('./core/wait.cjs').waitForGame(() => engine.deps.environment(path.dirname(g.exe), g.exe), { signal: waitController.signal, progress }); }
    finally { waitController = null; }
  }, true);
  handle('cancel-wait', async () => { waitController?.abort(); return true; });
  handle('capture-addon', async ({ gameId }) => {
    const answer = await dialog.showMessageBox(win, { type: 'question', message: '保存当前外部修改的 addon？', detail: '保存为新的本地版本，并保留原受管版本和最初备份。此步骤不改写游戏文件；完成后再点击 A 或 B 切换。', buttons:['取消','保存当前版本'], defaultId:0,cancelId:0,noLink:true });
    return answer.response === 1 ? engine.captureAddon(gameId, true) : null;
  }, true);
  handle('apply', ({ planId, consent }) => { progress('正在备份并安装'); return player.apply(planId, consent); }, true);
  handle('assign-ab', ({ gameId, a, b }) => player.assign(gameId, a, b), true);
  handle('details', async ({ gameId }) => { await player.identify(gameId); return engine.deps.scan(engine.game(gameId), engine.root); }, true);
  handle('uninstall', async ({ gameId }) => {
    const p = await engine.preview(gameId, null, 'uninstall');
    if (p.blockers.length) fail('UNINSTALL_BLOCKED', p.blockers.join('\n'));
    const answer = await dialog.showMessageBox(win, { type: 'question', message: '恢复这个游戏的原始文件？', detail: '仅撤销管理器安装的文件，保留游戏设置、存档和其他模组。\n' + p.riskWarnings.map(w=>w.message).join('\n'), buttons: ['取消', '恢复原版'], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1) return null;
    return player.apply(p.id, { confirm: true, compatibility: true, downgrade: true, adoptNames: [], riskCodes: p.riskWarnings.map(w => w.code) });
  }, true);
  handle('recover', async ({ gameId, transactionId }) => {
    const record = transactionId ? (await engine.history(gameId)).find(h => h.id === transactionId) : (await engine.history(gameId)).find(h => !['reverted', 'aborted'].includes(h.status));
    if (!record) fail('NO_RECOVERY', '没有需要恢复的操作。');
    const answer = await dialog.showMessageBox(win, { type: 'question', message: '回到这次操作之前？', detail: '请先退出游戏。恢复只处理有记录的文件，其他文件不会删除。', buttons: ['取消', '恢复'], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1) return null;
    const result = await engine.recover(gameId, record.id); engine.game(gameId).readiness = null; await engine.save(); return result;
  }, true);
  handle('launch', async ({ gameId }) => {
    const g = engine.game(gameId); await assertGameRoot(g.scanRoot, engine.root);
    if ((await engine.pending(g.id)).length) fail('RECOVERY_FIRST', '请先恢复上次未完成的操作。');
    if (g.source === 'steam' && /^[0-9]{1,12}$/.test(g.steamId || '')) { await shell.openExternal(`steam://run/${g.steamId}`); return true; }
    if (!g.exe || !inside(g.scanRoot, g.exe)) fail('EXE_REQUIRED', '请先识别游戏运行程序。');
    const pe = await peInfo(g.exe); if (!pe.valid || pe.dll || pe.arch !== 'x64') fail('EXE_CHANGED', '游戏程序已经变化，请重新添加。');
    await new Promise((resolve, reject) => { const p = spawn(g.exe, [], { cwd: path.dirname(g.exe), detached: true, stdio: 'ignore', shell: false }); p.once('error', reject); p.once('spawn', () => { p.unref(); resolve(); }); }); return true;
  }, true);
  handle('hide-game', async ({ gameId, hidden }) => { if (typeof hidden !== 'boolean') fail('INPUT_INVALID', '操作无效。'); engine.game(gameId).hidden = hidden; await engine.save(); return true; }, true);
  handle('open-game-folder', async ({ gameId }) => { const g = engine.game(gameId); const folder = await assertGameRoot(g.exe ? path.dirname(g.exe) : g.scanRoot, engine.root); if (await shell.openPath(folder)) fail('OPEN_FOLDER_FAILED', '无法打开游戏目录。'); return true; });
  handle('copy-game-path', async ({ gameId }) => { const g = engine.game(gameId); clipboard.writeText(g.exe || g.scanRoot); return true; });
  handle('poster', async ({ gameId }) => {
    engine.game(gameId);
    const p = await dialog.showOpenDialog(win, { title: '选择游戏海报', properties: ['openFile'], filters: [{ name: '海报图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    if (p.canceled) return null;
    const file = p.filePaths[0]; await noLinks(file); if ((await fs.stat(file)).size > 8 * 1024 * 1024) fail('IMAGE_SIZE', '图片太大，请选择 8 MB 以内的海报。');
    const image = nativeImage.createFromBuffer(await fs.readFile(file)), size = image.getSize();
    if (image.isEmpty() || size.width * size.height > 40000000) fail('IMAGE_INVALID', '无法读取这张图片。');
    const dir = path.join(engine.root, 'artwork'); await noLinks(dir); await fs.mkdir(dir, { recursive: true }); await durableWrite(path.join(dir, validId(gameId) + '.jpg'), image.resize({ width: 450 }).toJPEG(85)); return true;
  }, true);
  handle('preferences', async ({ onlineArtwork, showHidden }) => {
    if (typeof onlineArtwork !== 'boolean' || typeof showHidden !== 'boolean') fail('INPUT_INVALID', '设置无效。');
    engine.state.preferences = { onlineArtwork, showHidden }; await engine.save(); return true;
  }, true);
  handle('open-link', async ({ key }) => { if (!Object.hasOwn(LINKS, key)) fail('LINK_BLOCKED', '地址不受支持。'); await shell.openExternal(LINKS[key]); return true; });
  handle('export', async () => { const p = await dialog.showSaveDialog(win, { title: '保存诊断报告', defaultPath: 'DLSS5-Diagnostics.json' }); if (p.canceled) return null; if (engine.state.games.some(g => inside(g.scanRoot, p.filePath)) || inside(engine.root, p.filePath)) fail('EXPORT_PATH', '请将诊断保存到游戏目录以外。'); await durableWrite(p.filePath, await engine.diagnostic()); return true; }, true);
  handle('check-updates', async () => {
    const bytes = await download('https://api.github.com/repos/smartLanny/dlss5-manager/releases?per_page=10', { maxBytes: 1024 * 1024, headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DLSS5-Manager' } });
    const rows = JSON.parse(bytes.toString('utf8')); if (!Array.isArray(rows)) fail('UPDATE_INVALID', '更新信息暂时不可用。');
    const { compareVersions } = require('./core/components.cjs');
    const newest = rows.filter(r => !r.draft && /^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(r.tag_name || '')).sort((a,b)=>compareVersions(b.tag_name.replace(/^v/,''), a.tag_name.replace(/^v/,'')) || 0)[0];
    return newest ? { version: newest.tag_name, notes: String(newest.body || '').slice(0, 10000), current: (compareVersions(newest.tag_name.replace(/^v/, ''), VERSION) ?? 0) <= 0 } : { current: true, notes: '暂无更新。' };
  });
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
  if (!app.isPackaged && process.env.DLSS5_TEST_USER_DATA) app.setPath('userData', process.env.DLSS5_TEST_USER_DATA);
  engine = await new Engine(path.join(app.getPath('userData'), 'manager-data')).init(); player = new PlayerService(engine);
  try { await player.bundled(app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources')); } catch (e) { bundleError = friendlyError(e).message; }
  protocol.handle('app', async request => {
    try {
      const u = new URL(request.url);
      if (u.hostname === 'cover') { const g = engine.game(u.pathname.slice(1)); const b = await artwork(g, engine.root, nativeImage, engine.state.preferences?.onlineArtwork !== false); return b ? new Response(b, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' } }) : new Response('', { status: 404 }); }
      const file = decodeURIComponent(u.pathname).slice(1);
      if (u.hostname !== 'ui' || !['index.html', 'app.css', 'app.js', 'feedback.js', 'feedback.css'].includes(file)) return new Response('', { status: 404 });
      return net.fetch(pathToFileURL(path.join(__dirname, 'ui', file)).toString());
    } catch { return new Response('', { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false)); session.defaultSession.setPermissionCheckHandler(() => false);
  win = new BrowserWindow({ width: 1320, height: 900, minWidth: 960, minHeight: 680, title: '装机宅 DLSS5', backgroundColor: '#101418', autoHideMenuBar: true, titleBarStyle: 'hidden', titleBarOverlay: { color: '#101418', symbolColor: '#e4e9ef', height: 38 }, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); win.webContents.on('will-navigate', e => e.preventDefault()); win.webContents.on('will-attach-webview', e => e.preventDefault());
  win.on('close', e => { if (operationBusy || engine.busy) { e.preventDefault(); dialog.showMessageBox(win, { type: 'info', message: '正在处理游戏文件，请完成后再关闭。', buttons: ['返回'] }); } });
  registerHandlers(); await win.loadURL('app://ui/index.html');
}).catch(e => { dialog.showErrorBox('装机宅 DLSS5', friendlyError(e).message + '\n备份仍保留在本机。'); app.exit(1); });
