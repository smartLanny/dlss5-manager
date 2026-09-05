'use strict';
// Real Electron UI + real backend. Only OS file pickers and browser launching are stubbed.
// All game files are synthetic, never executed, isolated under test-results, and removed afterwards.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pe } = require('../test/helpers.cjs');
const { sha256 } = require('../src/core/safety.cjs');
async function main() {
  const parent = path.resolve('test-results'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'ui-'))), gameRoot = path.join(root, 'game');
  await fs.mkdir(gameRoot); await fs.mkdir('output', { recursive: true });
  const addon = path.join(root, 'nr.addon64'), exe = path.join(gameRoot, 'DemoGame.exe');
  await fs.writeFile(addon, pe(4)); await fs.writeFile(exe, pe(8, false));
  let application;
  try {
    application = await _electron.launch({ args: [path.resolve('.')], env: { ...process.env, DLSS5_TEST_USER_DATA: path.join(root, 'userdata') }, timeout: 45000, chromiumSandbox: true });
    const page = await application.firstWindow(); page.setDefaultTimeout(60000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(() => window.manager && document.body.getAttribute('aria-busy') !== 'true');
    assert.equal(await page.title(), '装机宅 DLSS5 安装器');
    assert.equal(await page.locator('.empty-state h3').first().textContent(), '从添加第一个游戏开始');
    const prefs = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    await page.screenshot({ path: 'output/ui-home.png' });
    await page.locator('.nav-item[data-page="versions"]').click();
    assert.equal(await page.locator('.version-card').count(), 3);
    await page.screenshot({ path: 'output/ui-versions.png' });
    const previewImage = await application.evaluate(({ nativeImage }, file) => nativeImage.createFromPath(file).resize({ width: 850 }).toJPEG(65).toString('base64'), path.resolve('output/ui-versions.png'));
    await fs.writeFile('output/ui-preview.jpg', Buffer.from(previewImage, 'base64'));
    await application.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, [addon]);
    await page.locator('[data-import-version="0.3.3.4"]').click();
    await page.locator('#importHash').fill(sha256(pe(4))); await page.locator('#acceptLocal').check();
    await page.locator('#importSubmit').click(); await page.waitForFunction(() => !document.querySelector('#importDialog').open && document.body.getAttribute('aria-busy') !== 'true');
    let s = await page.evaluate(async () => (await window.manager.state()).value);
    assert.equal(s.packages.length, 1); assert.equal(s.packages[0].trust, 'checksum-matched'); assert.equal(s.games.length, 0);
    await page.locator('.nav-item[data-page="games"]').click();
    await application.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, [exe]);
    await page.locator('#addGame').click(); await page.waitForFunction(() => !!document.querySelector('#gameApi') && document.body.getAttribute('aria-busy') !== 'true');
    await application.evaluate(({ shell, clipboard }) => {
      shell.openPath = async folder => { globalThis.__smokeFolder = folder; return ''; };
      clipboard.writeText = text => { globalThis.__smokeClipboard = text; };
    });
    await page.locator('[data-action="open-folder"]').click(); await page.waitForFunction(() => document.body.getAttribute('aria-busy') !== 'true');
    assert.equal(await application.evaluate(() => globalThis.__smokeFolder), gameRoot);
    await page.locator('[data-action="copy-path"]').click(); await page.waitForFunction(() => document.body.getAttribute('aria-busy') !== 'true');
    assert.equal(await application.evaluate(() => globalThis.__smokeClipboard), exe);
    await page.locator('#gameApi').selectOption('DX12'); await page.waitForFunction(() => document.body.getAttribute('aria-busy') !== 'true');
    await page.locator('#gameKind').selectOption('offline'); await page.waitForFunction(() => document.body.getAttribute('aria-busy') !== 'true');
    await page.locator('#environmentConfirmed').check(); await page.waitForFunction(() => document.body.getAttribute('aria-busy') !== 'true');
    await page.locator('[data-action="preview"]').click(); await page.waitForFunction(() => document.querySelector('#planDialog').open && document.body.getAttribute('aria-busy') !== 'true');
    if (process.platform === 'win32') {
      const blocked = await page.locator('#planContent .notice.danger').count();
      if (blocked) {
        const nativeEvidence = await page.evaluate(() => ({ environment: activePlan.report.environment, directorySignals: activePlan.report.antiCheat }));
        throw new Error('Windows synthetic install unexpectedly blocked: ' + await page.locator('#planContent .notice.danger').innerText() + '\nIsolated CI evidence: ' + JSON.stringify(nativeEvidence));
      }
      await page.locator('#confirmCompatibility').check(); await page.locator('#confirmPlan').check();
      await page.locator('#confirmApply').click();
      await page.waitForFunction(() => !document.querySelector('#planDialog').open && document.body.getAttribute('aria-busy') !== 'true');
      assert.deepEqual(await fs.readFile(path.join(gameRoot, 'nr.addon64')), pe(4));
      await page.locator('.nav-item[data-page="recovery"]').click();
      await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
      await page.locator('[data-recover]').first().click();
      await page.waitForFunction(() => document.body.getAttribute('aria-busy') !== 'true');
      await assert.rejects(fs.stat(path.join(gameRoot, 'nr.addon64')), { code: 'ENOENT' });
      s = await page.evaluate(async () => (await window.manager.state()).value);
      assert.equal(s.history[0].status, 'reverted');
    } else {
      assert.ok(await page.locator('#planContent').innerText().then(x => x.includes('Windows')));
      assert.equal(await page.locator('#confirmApply').isDisabled(), true);
      await page.locator('#planDialog [data-close]').first().click();
    }
    await application.evaluate(({ shell }) => { shell.openExternal = async url => { globalThis.__smokeOpened = url; }; });
    await page.locator('.homepage').click(); await page.waitForFunction(() => document.body.getAttribute('aria-busy') !== 'true');
    assert.equal(await application.evaluate(() => globalThis.__smokeOpened), 'https://space.bilibili.com/941799');
    const blockedLink = await page.evaluate(() => window.manager['open-link']({ key: 'file:///C:/Windows' }));
    assert.equal(blockedLink.ok, false);
    const diagnostic = path.join(root, 'diagnostic.json');
    await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, diagnostic);
    await page.locator('.nav-item[data-page="recovery"]').click(); await page.locator('#exportLog').click();
    await page.waitForFunction(() => document.body.getAttribute('aria-busy') !== 'true');
    const exported = await fs.readFile(diagnostic, 'utf8'); assert.ok(!exported.includes(gameRoot)); assert.ok(!exported.includes('DemoGame'));
    assert.deepEqual(errors, []);
    console.log('Electron smoke passed: real local UI, sandbox/IPC isolation, three version entries, SHA-256 import, game configuration, ' + (process.platform === 'win32' ? 'real Windows file installation and rollback' : 'non-Windows write gate') + ', exact Bilibili URL, private diagnostics.');
  } finally {
    if (application) await application.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
