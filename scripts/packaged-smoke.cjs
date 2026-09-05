'use strict';
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
async function main() {
  const exe = process.argv[2]; if (!exe || process.platform !== 'win32') throw new Error('Windows packaged EXE path required.');
  const application = await _electron.launch({ executablePath: path.resolve(exe), args: [], timeout: 60000, chromiumSandbox: true });
  try {
    const page = await application.firstWindow();
    await page.waitForFunction(() => window.manager && document.body.getAttribute('aria-busy') !== 'true', null, { timeout: 60000 });
    assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
    const prefs = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
    // devTools is a BrowserWindow option, not a reliably returned last-web-preferences field.
    // Verify the documented security behavior rather than accepting an absent property.
    // https://www.electronjs.org/docs/latest/api/structures/web-preferences
    const devToolsOpened = await application.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.openDevTools({ mode: 'detach' });
      await new Promise(resolve => setTimeout(resolve, 500));
      return contents.isDevToolsOpened();
    });
    assert.equal(devToolsOpened, false, 'Packaged application must not allow DevTools to open.');
    const state = await page.evaluate(async () => (await window.manager.state()).value);
    assert.equal(state.version, require('../package.json').version); assert.equal(state.platform, 'win32');
    assert.equal(state.catalog.length, 3); assert.equal(state.packages.length, 0);
    await page.locator('.nav-item[data-page="versions"]').click(); assert.equal(await page.locator('.version-card').count(), 3);
    const userData = await application.evaluate(({ app }) => app.getPath('userData'));
    const sentinel = path.join(userData, 'manager-data', 'ci-preserve-backup-sentinel.txt');
    await fs.writeFile(sentinel, 'Synthetic CI sentinel: uninstall must preserve manager recovery data.');
    await fs.writeFile('test-results/install-evidence.json', JSON.stringify({ sentinel, packagedLaunch: true, sandbox: true, devTools: false }));
    console.log('Installed packaged EXE launch passed: version, local protocol UI, empty private-plugin catalog, sandbox, disabled devtools.');
  } finally { await application.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
