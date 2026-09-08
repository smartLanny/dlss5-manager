'use strict';
// Focused Electron smoke. Every game file is synthetic and the EXE is never executed.
// Driver writes use an in-memory adapter; Steam launch and process checks are stubbed.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Engine } = require('../src/core/engine.cjs');
const { pe } = require('../test/helpers.cjs');

const clone = value => structuredClone(value);
async function main() {
  await fs.mkdir('test-results', { recursive:true }); await fs.mkdir('output', { recursive:true });
  const root = await fs.realpath(await fs.mkdtemp(path.resolve('test-results/launch-settings-ui-')));
  const gameRoot = path.join(root, 'synthetic-game'), userdata = path.join(root, 'userdata');
  const exe = path.join(gameRoot, 'LaunchSettingsFixture.exe'), control = path.join(gameRoot, 'RTX40MFG-Universal.json');
  const receiptPath = path.resolve('test-results/launch-settings-ui-smoke.json');
  const screenshotPath = path.resolve('output/launch-settings-ui.png');
  const ids = [0x10AFB768,0x10E41E01,0x10E41DF3,0x10E41DF5,0x10308298,0x104D6667,0x10562D0F,0x10CF4125];
  const baselineControl = JSON.stringify({version:11,followGame:true,mode:'follow',multiplier:2,custom:{keep:'unrelated'}}, null, 2) + '\n';
  await fs.mkdir(gameRoot); await fs.writeFile(exe, pe(71, false)); await fs.writeFile(control, baselineControl);
  const engine = await new Engine(path.join(userdata, 'manager-data')).init(), gameId = crypto.randomUUID();
  engine.state.games.push({ id:gameId, name:'启动设置合成游戏', scanRoot:gameRoot, exe, api:'', apiPreference:null,
    apiEvidence:null, kind:'unknown', source:'steam', steamId:'900000001', candidates:[], installed:null });
  await engine.save();
  const bootstrap = path.join(root, 'launch-settings-bootstrap.cjs');
  const modulePath = name => JSON.stringify(path.resolve(name));
  await fs.writeFile(bootstrap, `
    const clone=x=>structuredClone(x),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    const ids=${JSON.stringify(ids)};
    globalThis.__launchDriverWrites=0;globalThis.__failLaunchDriver=false;globalThis.__opened=[];
    let snapshot={profile:null,settings:Object.fromEntries(ids.map(id=>[id,{kind:'absent',value:null,location:null,predefined:null}]))};
    const driver={
      async read(exe,requested){if(globalThis.__failLaunchDriver){const e=Object.assign(new Error('Synthetic driver read failed.'),{code:'NVAPI_TEST_FAILURE'});throw e;}return clone(snapshot);},
      async write(exe,expected,desired){if(!same(snapshot,expected)){const e=Object.assign(new Error('Synthetic CAS mismatch.'),{code:'NVAPI_CAS_MISMATCH'});throw e;}snapshot=clone(desired);if(!snapshot.profile&&Object.values(snapshot.settings).some(x=>x.kind==='explicit'))snapshot.profile={name:'synthetic-owned-profile',appName:exe,exclusive:true,owned:true};globalThis.__launchDriverWrites++;return clone(snapshot);}
    };
    const platform=require(${modulePath('src/core/platform.cjs')});platform.hardware=async()=>({names:['NVIDIA GeForce RTX 4080'],family:'RTX40',activeGameAdapterVerified:false});platform.environment=async()=>({verified:true,running:[],antiCheat:[]});platform.checkLocks=async()=>{};
    const launch=require(${modulePath('src/core/launch-settings.cjs')}),Base=launch.LaunchSettings;launch.LaunchSettings=class extends Base{constructor(engine){super(engine,{driver,hardware:platform.hardware});}};
    const electron=require('electron');electron.shell.openExternal=async url=>{globalThis.__opened.push(url);};
    require(${modulePath('src/main.cjs')});
  `, 'utf8');
  let application, page; const evidence = { schema:1, version:require('../package.json').version, gameFiles:'synthetic', driver:'memory', checks:[] };
  try {
    application = await _electron.launch({ args:[bootstrap], env:{...process.env,DLSS5_TEST_USER_DATA:userdata}, timeout:60000, chromiumSandbox:true });
    page = await application.firstWindow(); page.setDefaultTimeout(45000); const pageErrors=[]; page.on('pageerror', e=>pageErrors.push(e.message));
    const idle = () => page.waitForFunction(()=>window.manager && document.body.getAttribute('aria-busy') !== 'true');
    const state = () => page.evaluate(async()=>(await window.manager.state()).value);
    await idle(); await page.locator(`[data-detail="${gameId}"]`).first().click(); await page.locator('#srBackend').waitFor();
    assert.match(await page.locator('.detail-title .tag').innerText(), /API 待确认/);
    assert.equal(await page.locator('#gameApiChoice').inputValue(), 'auto');
    await page.locator('#gameApiChoice').selectOption('DX12'); await idle();
    assert.equal((await state()).games[0].apiPreference.api, 'DX12'); evidence.checks.push('API DX12 preference saved');

    await page.locator('#srQuality').selectOption('balanced'); await page.locator('[data-launch-save="sr"]').click(); await idle();
    assert.equal((await state()).games[0].launchSettings.requests.sr.request.quality, 'balanced');
    await page.locator('[data-launch-preview="sr"]').click(); await idle(); assert.equal(await page.locator('#launchPlanDialog').evaluate(d=>d.open), true);
    await page.locator('#applyLaunchPlan').click(); await idle(); assert.equal((await state()).games[0].launchSettings.applied.sr.runtimeVerified, false);
    await page.locator('[data-launch-restore="sr"]').click(); await idle(); assert.equal(await page.locator('#srQuality').inputValue(), 'balanced');
    assert.match(await page.locator('#launchPlanContent').innerText(), /运行时仍未验证/); await page.locator('#applyLaunchPlan').click(); await idle();
    assert.equal((await state()).games[0].launchSettings.applied.sr, undefined); evidence.checks.push('SR save/preview/apply/restore');

    await page.locator('#fgBackend').selectOption('rtx40'); await page.locator('#fgMode').selectOption('fixed'); await page.locator('#fgMultiplier').fill('3');
    await page.locator('[data-launch-save="fg"]').click(); await idle(); await page.locator('[data-launch-preview="fg"]').click(); await idle();
    await page.locator('#applyLaunchPlan').click(); await idle(); let json=JSON.parse(await fs.readFile(control,'utf8'));
    assert.deepEqual(json.custom,{keep:'unrelated'}); assert.equal(json.multiplier,3);
    await page.screenshot({path:screenshotPath,fullPage:true});
    await page.locator('[data-launch-restore="fg"]').click(); await idle(); await page.locator('#applyLaunchPlan').click(); await idle();
    assert.equal(await fs.readFile(control,'utf8'), baselineControl); evidence.checks.push('RTX40 v11 save/preview/apply/restore preserves unknown JSON');

    await page.reload(); await idle(); await page.locator(`[data-detail="${gameId}"]`).first().click(); await page.locator('#gameApiChoice').waitFor();
    assert.equal(await page.locator('#gameApiChoice').inputValue(),'DX12'); evidence.checks.push('API preference survives reload');

    await page.locator('#srQuality').selectOption('quality'); await page.locator('[data-launch-save="sr"]').click(); await idle();
    const writesBefore = await application.evaluate(()=>globalThis.__launchDriverWrites);
    assert.equal((await page.evaluate(async id=>window.manager.launch({gameId:id}),gameId)).ok,true);
    assert.ok((await application.evaluate(()=>globalThis.__launchDriverWrites))>writesBefore);
    assert.deepEqual(await application.evaluate(()=>globalThis.__opened),['steam://run/900000001']); evidence.checks.push('Steam launch calls beforeLaunch');

    await application.evaluate(({dialog})=>{globalThis.__failLaunchDriver=true;dialog.showMessageBox=async()=>({response:1});});
    const continued=await page.evaluate(async id=>window.manager.launch({gameId:id}),gameId);assert.equal(continued.ok,true);
    assert.equal((await application.evaluate(()=>globalThis.__opened)).length,2); evidence.checks.push('ordinary settings failure can continue after prompt');
    await application.evaluate(()=>{globalThis.__failLaunchDriver=false;});
    const tx=crypto.randomUUID(),dir=path.join(userdata,'manager-data','transactions',tx);await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,'journal.json'),JSON.stringify({id:tx,gameId,status:'recovery-needed',createdAt:new Date().toISOString(),changes:[]}));
    const blocked=await page.evaluate(async id=>window.manager.launch({gameId:id}),gameId);assert.equal(blocked.ok,false);assert.equal(blocked.error.code,'RECOVERY_FIRST');
    assert.equal((await application.evaluate(()=>globalThis.__opened)).length,2); evidence.checks.push('pending recovery blocks Steam launch');
    assert.deepEqual(pageErrors,[]); evidence.ok=true;
  } catch(error) { evidence.ok=false;evidence.error={message:error.message,stack:error.stack};throw error; }
  finally { evidence.finishedAt=new Date().toISOString();await fs.writeFile(receiptPath,JSON.stringify(evidence,null,2)+'\n');if(application)await application.close();await fs.rm(root,{recursive:true,force:true}); }
  console.log(`LAUNCH SETTINGS UI PASSED: ${receiptPath}; screenshot: ${screenshotPath}`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
