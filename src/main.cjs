'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, protocol, net, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const { Engine } = require('./core/engine.cjs');
const { registerFeedback } = require('./feedback-ipc.cjs');
const { CATALOG, importPackage } = require('./core/packages.cjs');
const { discoverSteam, candidates, manualScanRoot } = require('./core/discovery.cjs');
const { scanGame } = require('./core/scanner.cjs');
const { peInfo, APIS } = require('./core/platform.cjs');
const { fail, validId, inside, assertGameRoot, friendlyError, durableWrite } = require('./core/safety.cjs');
const VERSION = require('../package.json').version;
const LINKS = Object.freeze({ bilibili: 'https://space.bilibili.com/941799', releases: 'https://github.com/smartLanny/dlss5-manager/releases', issues: 'https://github.com/smartLanny/dlss5-manager/issues', tutorial: 'https://space.bilibili.com/941799', reshade: 'https://reshade.me/' });
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();
let win, engine, operationBusy = false;
async function publicState() {
  return { version: VERSION, platform: process.platform, catalog: CATALOG, games: engine.state.games, packages: engine.state.packages, history: (await engine.history()).map(j => ({ id: j.id, gameId: j.gameId, version: j.version, createdAt: j.createdAt, restoredAt: j.restoredAt, status: j.status, operation: j.operation, fileCount: j.changes.length })), links: LINKS };
}
function senderAllowed(event) { return win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === 'app://ui/index.html'; }
function handle(name, fn, mutates = false) {
  ipcMain.handle(`manager:${name}`, async (event, payload) => {
    if (!senderAllowed(event)) return { ok: false, error: { code: 'IPC_DENIED', message: '请求来源无效。' } };
    if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length > 16384)) return { ok: false, error: { code: 'INPUT_INVALID', message: '请求参数无效。' } };
    if (mutates && operationBusy) return { ok: false, error: { code: 'BUSY', message: '已有操作正在进行。' } };
    if (mutates) operationBusy = true;
    try { return { ok: true, value: await fn(payload || {}) }; }
    catch (e) {
      const error = friendlyError(e);
      if (['apply', 'preview', 'recover', 'scan', 'import'].includes(name)) engine.lastEventCode = error.code;
      return { ok: false, error };
    }
    finally { if (mutates) operationBusy = false; }
  });
}
async function chooseExe(game) {
  const selected = await dialog.showOpenDialog(win, { title: '选择游戏真正运行的 EXE', defaultPath: game?.scanRoot, properties: ['openFile'], filters: [{ name: 'Windows 游戏程序', extensions: ['exe'] }] });
  if (selected.canceled) return null;
  const exe = selected.filePaths[0], pe = await peInfo(exe);
  if (!pe.valid || pe.dll) fail('EXE_INVALID', '这个文件不是有效的 Windows 游戏 EXE。');
  return { exe, pe };
}
function registerHandlers() {
  registerFeedback({ handle, engine, win, dialog, shell, clipboard });
  handle('state', publicState);
  handle('add-game', async () => {
    const chosen = await chooseExe(); if (!chosen) return null;
    const { exe, pe } = chosen, scanRoot = manualScanRoot(exe);
    await assertGameRoot(scanRoot, engine.root);
    const existing = engine.state.games.find(g => g.exe.toLowerCase() === exe.toLowerCase());
    if (existing) return existing.id;
    const g = { id: crypto.randomUUID(), name: path.basename(exe, '.exe').replace(/[-_]Win64[-_]Shipping/i, ''), scanRoot, exe, api: '', kind: 'unknown', environmentConfirmed: false, candidates: [{ path: exe, arch: pe.arch, apis: pe.apis }], installed: null };
    engine.state.games.push(g); await engine.save(); return g.id;
  }, true);
  handle('steam-scan', async ({ chooseFolder = false }) => {
    let roots = [];
    if (chooseFolder) {
      const pick = await dialog.showOpenDialog(win, { title: '选择包含 steamapps 的 Steam 库目录', properties: ['openDirectory'] });
      if (pick.canceled) return null; roots = pick.filePaths;
    }
    const found = await discoverSteam(roots); let added = 0;
    for (const g of found.games) if (!engine.state.games.some(x => x.scanRoot.toLowerCase() === g.scanRoot.toLowerCase())) { engine.state.games.push(g); added++; }
    await engine.save(); return { added, total: found.games.length, notes: found.notes };
  }, true);
  handle('candidates', async ({ gameId }) => {
    const game = engine.game(gameId);
    game.candidates = await candidates(game.scanRoot); await engine.save(); return game.candidates;
  }, true);
  handle('choose-exe', async ({ gameId }) => {
    const game = engine.game(gameId);
    if (game.installed || (await engine.pending(gameId)).length) fail('PATH_IN_USE', '请先卸载或恢复已管理的文件，再更改 EXE 路径。');
    const result = await chooseExe(game); if (!result) return null;
    if (!inside(game.scanRoot, result.exe)) fail('EXE_OUTSIDE', 'EXE 不在此游戏目录内，请作为新游戏添加。');
    game.exe = result.exe; game.api = ''; game.environmentConfirmed = false;
    game.candidates = [{ path: result.exe, arch: result.pe.arch, apis: result.pe.apis }];
    await engine.save(); return game;
  }, true);
  handle('configure', async ({ gameId, api, kind, environmentConfirmed, candidateIndex }) => {
    const game = engine.game(gameId);
    if (!['', ...APIS].includes(api) || !['unknown', 'offline', 'online'].includes(kind) || typeof environmentConfirmed !== 'boolean') fail('INPUT_INVALID', '请选择有效的游戏类型和图形 API。');
    if (candidateIndex !== undefined) {
      if (!Number.isInteger(candidateIndex) || !game.candidates[candidateIndex]) fail('EXE_REQUIRED', '请重新选择候选 EXE。');
      const exe = game.candidates[candidateIndex].path;
      if ((game.installed || (await engine.pending(gameId)).length) && game.exe !== exe) fail('PATH_IN_USE', '已有安装记录时不能改变目标目录，请先恢复或卸载。');
      if (!inside(game.scanRoot, exe)) fail('EXE_OUTSIDE', 'EXE 路径无效。');
      game.exe = exe;
    }
    game.api = api; game.kind = kind; game.environmentConfirmed = environmentConfirmed;
    await engine.save(); return game;
  }, true);
  handle('scan', async ({ gameId }) => scanGame(engine.game(gameId), engine.root), true);
  handle('import', async ({ version, api, expectedHash, acceptLocal }) => {
    if (typeof expectedHash !== 'string' || expectedHash.length > 64 || typeof version !== 'string' || !APIS.includes(api) || typeof acceptLocal !== 'boolean') fail('INPUT_INVALID', '导入信息无效。');
    const pick = await dialog.showOpenDialog(win, { title: '选择群内发布的 addon 或标准更新包', properties: ['openFile'], filters: [{ name: 'NR before SR 插件', extensions: ['addon64', 'dlss5pkg', 'zip'] }] });
    if (pick.canceled) return null;
    const keys = require('../config/trusted-keys.json');
    const pkg = await importPackage(pick.filePaths[0], { version, api, expectedHash: expectedHash.trim(), acceptLocal }, path.join(engine.root, 'packages'), keys);
    if (pkg.componentManifest && engine.state.schema === 1) {
      const answer = await dialog.showMessageBox(win, { type: 'warning', title: '确认升级组件库格式', message: '导入组件 v2 包后，需要使用 0.2 或更新的管理器。', detail: '会先备份旧版元数据，再升级本地组件库。0.1 将不能继续读取这个组件库，以免忽略新包的依赖和版本限制。游戏目录不会因导入而改变。正在测试 0.1 时建议取消，继续使用原始 addon 或 v1 包。', buttons: ['取消导入', '备份并升级组件库'], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response !== 1) return null;
    }
    engine.state.packages.push(pkg); await engine.save(); return pkg;
  }, true);
  handle('preview', async ({ gameId, packageId, operation }) => engine.preview(gameId, packageId, operation), true);
  handle('apply', async ({ planId, consent }) => engine.apply(planId, consent), true);
  handle('recover', async ({ gameId, transactionId }) => {
    validId(transactionId);
    const result = await dialog.showMessageBox(win, { type: 'question', title: '确认恢复', message: '恢复到这次操作之前？', detail: '只恢复有备份且哈希匹配的文件。玩家后来改动过的文件会被保留，并停止自动恢复。请先完全退出游戏。', buttons: ['取消', '恢复原状'], defaultId: 0, cancelId: 0, noLink: true });
    if (result.response !== 1) return null;
    return engine.recover(gameId, transactionId);
  }, true);
  handle('export', async () => {
    const picked = await dialog.showSaveDialog(win, { title: '导出脱敏诊断', defaultPath: 'DLSS5-Manager-Diagnostics.json', filters: [{ name: '诊断 JSON', extensions: ['json'] }] });
    if (picked.canceled) return null;
    await durableWrite(picked.filePath, await engine.diagnostic()); return true;
  }, true);
  handle('open-game-folder', async ({ gameId }) => {
    const game = engine.game(gameId);
    const folder = await assertGameRoot(game.exe ? path.dirname(game.exe) : game.scanRoot, engine.root);
    const error = await shell.openPath(folder);
    if (error) fail('OPEN_FOLDER_FAILED', '无法打开游戏文件夹，请检查目录是否仍然存在。');
    return true;
  });
  handle('copy-game-path', async ({ gameId }) => {
    const game = engine.game(gameId);
    await assertGameRoot(game.exe ? path.dirname(game.exe) : game.scanRoot, engine.root);
    clipboard.writeText(game.exe || game.scanRoot);
    return true;
  });
  handle('open-link', async ({ key }) => {
    if (!Object.hasOwn(LINKS, key)) fail('LINK_BLOCKED', '不允许打开此地址。');
    await shell.openExternal(LINKS[key]); return true;
  });
  handle('check-updates', async () => {
    // Metadata only: never downloads or executes code, and never silently changes the application.
    const res = await fetch('https://api.github.com/repos/smartLanny/dlss5-manager/releases?per_page=20', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Zhuangjizhai-DLSS5-Manager' }, signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!res.ok) fail('UPDATE_NETWORK', '暂时无法检查更新。离线导入与恢复功能不受影响。');
    const length = Number(res.headers.get('content-length') || 0); if (length > 1024 * 1024) fail('UPDATE_INVALID', '更新信息异常。');
    const body = await res.text(); if (body.length > 1024 * 1024) fail('UPDATE_INVALID', '更新信息过大。');
    const releases = JSON.parse(body);
    if (!Array.isArray(releases)) fail('UPDATE_INVALID', '更新信息格式错误。');
    const newest = releases.filter(r => !r.draft && /^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(r.tag_name || '')).sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0];
    return newest ? { version: newest.tag_name, prerelease: !!newest.prerelease, notes: String(newest.body || '').slice(0, 12000), publishedAt: newest.published_at, current: newest.tag_name.replace(/^v/, '') === VERSION } : { current: true, notes: '尚无公开更新。' };
  });
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
  if (!app.isPackaged && process.env.DLSS5_TEST_USER_DATA) app.setPath('userData', process.env.DLSS5_TEST_USER_DATA);
  engine = await new Engine(path.join(app.getPath('userData'), 'manager-data')).init();
  protocol.handle('app', request => {
    const u = new URL(request.url);
    const name = decodeURIComponent(u.pathname).replace(/^\//, '');
    if (u.hostname !== 'ui' || !['index.html', 'app.css', 'app.js', 'feedback.js', 'feedback.css'].includes(name)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(__dirname, 'ui', name)).toString());
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  win = new BrowserWindow({ width: 1320, height: 880, minWidth: 1040, minHeight: 720, title: '装机宅 DLSS5 安装器', backgroundColor: '#101418', autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#101418', symbolColor: '#e4e9ef', height: 38 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  win.on('close', e => { if (operationBusy || engine.busy) { e.preventDefault(); dialog.showMessageBox(win, { type: 'info', message: '正在保护游戏文件，请在当前操作结束后关闭。', buttons: ['返回'] }); } });
  registerHandlers();
  await win.loadURL('app://ui/index.html');
}).catch(e => { dialog.showErrorBox('装机宅 DLSS5 安装器', friendlyError(e).message + '\n备份数据已保留。'); app.exit(1); });
