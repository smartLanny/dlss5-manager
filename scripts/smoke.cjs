'use strict';
// Player-path smoke test. The game, addon and runtime are synthetic fixtures and
// are never executed. Artwork is verified through the normal Steam-cache path,
// not by injecting demo cards or replacing the renderer state.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pe } = require('../test/helpers.cjs');
const { sha256, digestFile } = require('../src/core/safety.cjs');
const { writeZip, readZip } = require('../src/core/packages.cjs');
const { PIN, ensureReShade } = require('../src/core/reshade.cjs');

function packageBytes(version, seed) {
  const addon = pe(seed), bridge = pe(9), runtime = pe(7);
  return writeZip([
    ['manifest.json', Buffer.from(JSON.stringify({ manifest: { schema: 1, component: 'nr-before-sr', version, architecture: 'x64', apis: ['DX12'], files: [
      { path: 'nr.addon64', role: 'addon', sha256: sha256(addon) },
      { path: 'nrchain_nvngx.dll', role: 'bridge', sha256: sha256(bridge) },
      { path: 'nvngx_dlssnr.dll', role: 'nr-runtime', sha256: sha256(runtime) }
    ] } }))],
    ['nr.addon64', addon], ['nrchain_nvngx.dll', bridge], ['nvngx_dlssnr.dll', runtime]
  ]);
}
function vdf(root) {
  return `"libraryfolders" { "0" { "path" "${root.replace(/\\/g, '\\\\')}" } }`;
}
function manifest(appid, root) {
  return `"AppState" { "appid" "${appid}" "name" "Cyberpunk 2077 (synthetic)" "installdir" "Cyberpunk 2077" "launch" "bin/x64/SyntheticCyberpunk.exe" }`;
}
async function main() {
  const base = await fs.realpath(await fs.mkdtemp(path.resolve('test-results/player-ui-'))), library = path.join(base, 'steam-library'), steamapps = path.join(library, 'steamapps'), gameRoot = path.join(steamapps, 'common', 'Cyberpunk 2077'), exeDir = path.join(gameRoot, 'bin', 'x64'), cache = path.join(library, 'appcache', 'librarycache'), userdata = path.join(base, 'userdata');
  await fs.mkdir(exeDir, { recursive: true }); await fs.mkdir(cache, { recursive: true });
  const exe = path.join(exeDir, 'SyntheticCyberpunk.exe'), helper = path.join(gameRoot, 'REDlauncher.exe'), crash = path.join(gameRoot, 'CrashReporter.exe');
  const exeBytes = pe(0, false); Buffer.from('D3D12CreateDevice').copy(exeBytes, 550); await fs.writeFile(exe, exeBytes); await fs.writeFile(helper, pe(2, false)); await fs.writeFile(crash, pe(3, false));
  await fs.writeFile(path.join(steamapps, 'libraryfolders.vdf'), vdf(library)); await fs.writeFile(path.join(steamapps, 'appmanifest_999999.acf'), manifest('999999', gameRoot));
  // A valid locally cached Steam image exercises the same cache lookup used by
  // a real install. It is not displayed as a fabricated release screenshot.
  const image = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAAgACADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z', 'base64');
  await fs.writeFile(path.join(cache, '999999_library_600x900.jpg'), image);
  const files = ['0.3.3.4.dlss5pkg', '0.4.1r2.dlss5pkg', '0.4.3r3.dlss5pkg']; for (let i = 0; i < files.length; i++) await fs.writeFile(path.join(base, files[i]), packageBytes(files[i].replace('.dlss5pkg', ''), i + 1));
  const errors = []; let application, page;
  try {
    if (process.platform === 'win32') await ensureReShade(path.join(userdata, 'manager-data'));
    application = await _electron.launch({ args: [path.resolve('.')], env: { ...process.env, DLSS5_TEST_USER_DATA: userdata, DLSS5_TEST_GPU: 'RTX50', DLSS5_TEST_FAST: '1', DLSS5_SKIP_AUTO_SCAN: '1' }, timeout: 60000, chromiumSandbox: true });
    page = await application.firstWindow(); page.setDefaultTimeout(90000); page.on('pageerror', e => errors.push(e.message));
    const idle = () => page.waitForFunction(() => window.manager && document.body.getAttribute('aria-busy') !== 'true', null, { timeout: 30000 }); await idle();
    assert.equal(await page.title(), '装机宅 DLSS5'); assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    const prefs = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()); assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
    assert.equal(await page.locator('#gameApi,#importApi,#importHash,#importVersion,#slotA,#slotB,#saveAB').count(), 0);
    await application.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, library);
    await page.locator('#steamFolder').click(); await idle();
    let state = await page.evaluate(async () => (await window.manager.state()).value); const synthetic = state.games.find(x => x.steamId === '999999'); assert.ok(synthetic, 'synthetic Steam game was not discovered'); assert.equal(synthetic.api, 'DX12'); assert.match(synthetic.exe, /bin[\\/]x64[\\/]SyntheticCyberpunk\.exe$/i); assert.doesNotMatch(synthetic.exe, /launcher|crash/i);
    const gameId = synthetic.id; const urlInfo = await page.evaluate(async id => ({ portrait: `app://cover/${id}?kind=portrait`, hero: `app://cover/${id}?kind=hero` }), gameId); assert.match(urlInfo.portrait, /^app:\/\/cover\//); assert.match(urlInfo.hero, /kind=hero/); const imageState = await page.locator(`[data-game-card="${gameId}"] img`).evaluate(img => ({ complete: img.complete, width: img.naturalWidth, height: img.naturalHeight })); assert.ok(imageState.complete && imageState.width > 0 && imageState.height > 0, 'Steam artwork did not render through app protocol');
    await page.locator('.nav[data-page="versions"]').click(); await application.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: selected }); }, files.map(x => path.join(base, x))); await page.locator('#importUpdate').click(); await idle();
    state = await page.evaluate(async () => (await window.manager.state()).value); assert.deepEqual([...new Set(state.packages.map(x => x.manifest.version))].sort(), ['0.3.3.4', '0.4.1r2', '0.4.3r3']);
    await page.screenshot({ path: 'output/ui-versions.png' }); await page.locator('.nav[data-page="games"]').click(); await page.locator(`[data-detail="${gameId}"]`).first().click();
    assert.equal(await page.locator('#pluginVersion optgroup').count(), 3); assert.match(await page.locator('#pluginVersion').evaluate(el => [...el.querySelectorAll('optgroup')].map(x => x.label).join('\n')), /0\.3\.3\.4/); assert.match(await page.locator('#pluginVersion').evaluate(el => [...el.querySelectorAll('optgroup')].map(x => x.label).join('\n')), /0\.4\.1r2/); assert.match(await page.locator('#pluginVersion').evaluate(el => [...el.querySelectorAll('optgroup')].map(x => x.label).join('\n')), /0\.4\.3r3/); await page.screenshot({ path: 'output/ui-cyberpunk-detail.png' });
    await page.locator('#gameDialog [data-game-action="install"]').click(); await idle();
    if (process.platform === 'win32') { assert.equal(await page.locator('#confirmApply').isVisible(), true); await page.locator('#confirmApply').click(); await idle(); assert.deepEqual(await fs.readFile(path.join(exeDir, 'nr.addon64')), pe(1)); assert.deepEqual(await fs.readFile(path.join(exeDir, 'nrchain_nvngx.dll')), pe(9)); assert.deepEqual(await fs.readFile(path.join(exeDir, 'nvngx_dlssnr.dll')), pe(7)); assert.equal(await digestFile(path.join(exeDir, 'dxgi.dll')), PIN.dll.sha256); }
    await page.screenshot({ path: 'output/ui-install-complete.png' });
    const second = state.packages.find(x => x.manifest.version === '0.4.1r2'); if (second) { await page.locator('#pluginVersion').selectOption(second.id); await page.locator('#gameDialog [data-game-action="install"]').click(); await idle(); if (process.platform === 'win32' && await page.locator('#confirmApply').isVisible()) { await page.locator('#confirmApply').click(); await idle(); assert.deepEqual(await fs.readFile(path.join(exeDir, 'nr.addon64')), pe(2)); } }
    if (process.platform === 'win32') { const third = state.packages.find(x => x.manifest.version === '0.3.3.4'); await page.locator('#pluginVersion').selectOption(third.id); await page.locator('#gameDialog [data-game-action="install"]').click(); await idle(); if (await page.locator('#confirmApply').isVisible()) { await page.locator('#confirmApply').click(); await idle(); } assert.deepEqual(await fs.readFile(path.join(exeDir, 'nr.addon64')), pe(1)); const before = (await page.evaluate(async () => (await window.manager.state()).value)).history.length; await page.locator('#gameDialog [data-game-action="install"]').click(); await idle(); if (await page.locator('#confirmApply').isVisible()) { await page.locator('#confirmApply').click(); await idle(); } assert.equal((await page.evaluate(async () => (await window.manager.state()).value)).history.length, before); await page.screenshot({ path: 'output/ui-restore-entry.png' }); }
    assert.deepEqual(errors, []); console.log(`PLAYER UI PASSED: Steam appid/artwork URL/cache path, Cyberpunk bin/x64 EXE ranking, helper exclusion, DX12 detection, three saved versions, default 0.3.3.4, switch-and-save path, same-version no-op, sandbox/contextIsolation. ${process.platform === 'win32' ? 'Windows transaction also verified.' : 'Windows writes skipped on non-Windows.'}`);
  } catch (e) { try { if (page) await page.screenshot({ path: 'output/ui-failure.png' }); } catch {} throw e; } finally { if (application) await application.close(); await fs.rm(base, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
