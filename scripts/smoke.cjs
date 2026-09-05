'use strict';
// Actual Electron UI and backend. All test game/NR files are synthetic and NEVER executed.
// OS pickers, external launches and clipboard are stubbed. The official ReShade cache is real.
const { _electron } = require('playwright');
const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');
const {pe}=require('../test/helpers.cjs');const {sha256,digestFile}=require('../src/core/safety.cjs');const {writeZip,readZip}=require('../src/core/packages.cjs');const {PIN,ensureReShade}=require('../src/core/reshade.cjs');
function bundle(v,seed){const addon=pe(seed),runtime=pe(7);return writeZip([['manifest.json',Buffer.from(JSON.stringify({manifest:{schema:1,component:'nr-before-sr',version:v,architecture:'x64',apis:['DX12'],files:[{path:'nr.addon64',role:'addon',sha256:sha256(addon)},{path:'nvngx_dlssnr.dll',role:'nr-runtime',sha256:sha256(runtime)}]}}))],['nr.addon64',addon],['nvngx_dlssnr.dll',runtime]]);}
async function main(){
 await fs.mkdir('test-results',{recursive:true});await fs.mkdir('output',{recursive:true});
 const root=await fs.realpath(await fs.mkdtemp(path.resolve('test-results/player-ui-'))),gameRoot=path.join(root,'synthetic-game'),userdata=path.join(root,'userdata');await fs.mkdir(gameRoot);
 const exe=path.join(gameRoot,'DemoGame.exe'),aFile=path.join(root,'0.3.3.4.dlss5pkg'),bFile=path.join(root,'0.4.1beta.dlss5pkg');
 const exeData=pe(0,false);Buffer.from('D3D12CreateDevice').copy(exeData,550);await fs.writeFile(exe,exeData);await fs.writeFile(aFile,bundle('0.3.3.4',1));await fs.writeFile(bFile,bundle('0.4.1beta',2));
 const settings=Buffer.from('[GENERAL]\nKeepMySettings=1\n');await fs.writeFile(path.join(gameRoot,'ReShade.ini'),settings);
 if(process.platform==='win32')await ensureReShade(path.join(userdata,'manager-data'));
 let application, page;
 try{
  application=await _electron.launch({args:[path.resolve('.')],env:{...process.env,DLSS5_TEST_USER_DATA:userdata},timeout:60000,chromiumSandbox:true});
  page=await application.firstWindow();page.setDefaultTimeout(90000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const idle=()=>page.waitForFunction(()=>window.manager&&document.body.getAttribute('aria-busy')!=='true');await idle();
  assert.equal(await page.title(),'装机宅 DLSS5');assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  const prefs=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
  assert.equal(await page.locator('#gameApi,#importApi,#importHash,#importVersion').count(),0);
  await page.screenshot({path:'output/ui-home-empty.png'});
  await application.evaluate(({dialog},filePaths)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths});},[exe]);await page.locator('#addGame').click();await idle();
  let s=await page.evaluate(async()=>(await window.manager.state()).value);assert.equal(s.games.length,1);assert.equal(s.games[0].api,'DX12');const gameId=s.games[0].id;
  await page.locator('.nav[data-page="versions"]').click();
  await application.evaluate(({dialog},filePaths)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths});},[aFile,bFile]);await page.locator('#importUpdate').click();await idle();
  s=await page.evaluate(async()=>(await window.manager.state()).value);assert.equal(s.packages.length,2);const a=s.packages.find(p=>p.manifest.version==='0.3.3.4'),b=s.packages.find(p=>p.manifest.version==='0.4.1beta');
  await page.screenshot({path:'output/ui-versions.png'});
  await page.locator('.nav[data-page="games"]').click();await page.locator('[data-game-action="install"]').click();await idle();
  if(process.platform==='win32'){
   assert.equal(await page.locator('#confirmApply').isVisible(),true);await page.locator('#confirmApply').click();await idle();
   assert.deepEqual(await fs.readFile(path.join(gameRoot,'nr.addon64')),pe(1));assert.equal(await digestFile(path.join(gameRoot,'dxgi.dll')),PIN.dll.sha256);
   assert.deepEqual(await fs.readFile(path.join(gameRoot,'nvngx_dlssnr.dll')),pe(7));assert.deepEqual(await fs.readFile(path.join(gameRoot,'ReShade.ini')),settings);
   // A/B controls use their actual UI rather than calling the engine directly.
   await page.locator(`[data-detail="${gameId}"]`).first().click();
   await page.locator('#gameDialog summary').first().click();
   await page.locator('#slotA').selectOption(a.id);await page.locator('#slotB').selectOption(b.id);await page.locator('#saveAB').click();await idle();
   await page.locator('[data-slot="B"]').click();await idle();if(await page.locator('#planDialog').evaluate(d=>d.open)){await page.locator('#confirmApply').click();await idle();}
   assert.deepEqual(await fs.readFile(path.join(gameRoot,'nr.addon64')),pe(2));
   await page.locator(`[data-detail="${gameId}"]`).first().click();await page.locator('[data-slot="A"]').click();await idle();if(await page.locator('#planDialog').evaluate(d=>d.open)){await page.locator('#confirmApply').click();await idle();}
   assert.deepEqual(await fs.readFile(path.join(gameRoot,'nr.addon64')),pe(1));
   const historyBefore=(await page.evaluate(async()=>(await window.manager.state()).value)).history.length;
   await page.locator(`[data-detail="${gameId}"]`).first().click();await page.locator('[data-slot="A"]').click();await idle();if(await page.locator('#planDialog').evaluate(d=>d.open)){await page.locator('#confirmApply').click();await idle();}
   s=await page.evaluate(async()=>(await window.manager.state()).value);assert.equal(s.history.length,historyBefore);
   assert.equal((await fs.readdir(gameRoot)).filter(n=>n.endsWith('.addon64')).length,1);
   await page.locator(`[data-detail="${gameId}"]`).first().click();await page.screenshot({path:'output/ui-ab.png'});await page.locator('[data-close="gameDialog"]').click();
  }else{assert.equal(await page.locator('#confirmApply').isVisible(),false);await page.locator('[data-close="planDialog"]').first().click();}
  const coreZip=path.join(root,'core.zip'),imageZip=path.join(root,'image.zip'),feedbackZip=path.join(root,'feedback-for-author.zip');
  await fs.writeFile(coreZip,writeZip([['runtime.log',Buffer.from('PRIVATE runtime log')]]));
  await fs.writeFile(imageZip,writeZip([['frame.bin',Buffer.from('test image payload')]]));
  await page.locator('.nav[data-page="feedback"]').click();await page.locator('#feedbackType').selectOption('image');
  await page.locator('#feedbackSymptom').fill('测试反馈：切换版本后画面闪烁。');
  await page.locator('.feedback-extra summary').click();
  await page.locator('#feedbackRuntimeSummary').fill('F8 completed\nC:\\Users\\private-user\\log.txt');
  await application.evaluate(({dialog},filePaths)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths});},[coreZip,imageZip]);
  await page.locator('#feedbackImport').click();await idle();assert.match(await page.locator('#feedbackAttachment').innerText(),/2 个反馈包/);
  await page.locator('#feedbackForm button[type="submit"]').click();await idle();
  assert.match(await page.locator('#feedbackReport').innerText(),/配对关系待验证/);
  assert.ok(!(await page.locator('#feedbackReport').innerText()).includes('private-user'));
  await application.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},feedbackZip);
  await page.locator('#feedbackInclude').check();await page.locator('#feedbackPrivate').click();await idle();
  const feedbackContents=readZip(await fs.readFile(feedbackZip));
  assert.deepEqual(feedbackContents.get('runtime-feedback-1.zip').bytes,await fs.readFile(coreZip));
  assert.deepEqual(feedbackContents.get('runtime-feedback-2.zip').bytes,await fs.readFile(imageZip));
  assert.ok((await page.locator('#feedbackReport').innerText()).includes('0.2.0-beta.3'));await page.screenshot({path:'output/ui-feedback.png'});
  await application.evaluate(({shell,clipboard})=>{shell.openExternal=async url=>{globalThis.__opened=url;};clipboard.writeText=text=>{globalThis.__copied=text;};});
  await page.locator('#feedbackOpen').click();await idle();const opened=await application.evaluate(()=>globalThis.__opened);assert.ok(opened.startsWith('https://github.com/smartLanny/dlss5-manager/issues/new?title='));assert.ok(!opened.includes('body='));
  const copied=await application.evaluate(()=>globalThis.__copied);assert.ok(!copied.includes(root));await page.locator('[data-close="feedbackDialog"]').click();
  await page.locator('.homepage').click();await idle();assert.equal(await application.evaluate(()=>globalThis.__opened),'https://space.bilibili.com/941799');
  assert.equal((await page.evaluate(()=>window.manager['open-link']({key:'file:///C:/Windows'}))).ok,false);
  if(process.platform==='win32'){
   await page.locator('.nav[data-page="games"]').click();await page.locator(`[data-detail="${gameId}"]`).first().click();
   await application.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:1});});
   const otherAddon=path.join(gameRoot,'OtherTool.addon64');await fs.writeFile(otherAddon,pe(8));await fs.unlink(exe);
   await page.locator('[data-game-action="uninstall"]').click();await idle();
   await assert.rejects(fs.stat(path.join(gameRoot,'nr.addon64')),{code:'ENOENT'});
   assert.equal(await digestFile(path.join(gameRoot,'dxgi.dll')),PIN.dll.sha256);
   assert.deepEqual(await fs.readFile(path.join(gameRoot,'nvngx_dlssnr.dll')),pe(7));
   assert.deepEqual(await fs.readFile(otherAddon),pe(8));
   assert.deepEqual(await fs.readFile(path.join(gameRoot,'ReShade.ini')),settings);
   s=await page.evaluate(async()=>(await window.manager.state()).value);assert.equal(s.games[0].installed,null);assert.equal(s.history[0].keptEnvironmentCount,2);
   await page.screenshot({path:'output/ui-uninstall-shared.png'});
   await page.locator('[data-close="gameDialog"]').click();
   await page.locator('.nav[data-page="recovery"]').click();await page.locator('[data-recover]').first().click();await idle();
   s=await page.evaluate(async()=>(await window.manager.state()).value);assert.ok(s.games[0].installed);
   // These are synthetic fixture files: remove unrelated fixtures before the clean-host case.
   await fs.writeFile(exe,exeData);await fs.unlink(otherAddon);await fs.unlink(path.join(gameRoot,'ReShade.ini'));
   await page.locator('.nav[data-page="games"]').click();await page.locator(`[data-detail="${gameId}"]`).first().click();
   await page.locator('[data-game-action="uninstall"]').click();await idle();
   for(const f of ['nr.addon64','nvngx_dlssnr.dll','dxgi.dll'])await assert.rejects(fs.stat(path.join(gameRoot,f)),{code:'ENOENT'});
   await page.locator('[data-close="gameDialog"]').click();
  }
  assert.deepEqual(errors,[]);
  // Screenshot-only seeded library, visibly labelled as demonstration data; not a game compatibility test.
  await page.locator('.nav[data-page="games"]').click();
  const demo=[['赛博朋克 2077','1091500'],['控制 · 终极版','870780'],['霍格沃茨之遗','990080'],['黑神话：悟空','2358720'],['巫师 3','292030'],['艾尔登法环','1245620']].map(([name,steamId])=>({id:crypto.randomUUID(),name,steamId,source:'steam',scanRoot:gameRoot,exe,api:'DX12',installed:null}));
  // Use a mocked state read only for screenshots after the real behavioral assertions above.
  await page.evaluate(d=>{state.games=d;state.preferences.onlineArtwork=true;renderGames();document.querySelector('#page-games .subtitle').textContent='界面演示数据 · 海报布局展示，不代表这些游戏已经通过兼容性验收。';},demo);
  // The cover protocol resolves real engine records only; request Steam art for the screenshot via trusted Node automation, not a shipped demo backdoor.
  const art=await application.evaluate(async({nativeImage},ids)=>{const out={};for(const id of ids){try{const r=await fetch(`https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${id}/library_600x900.jpg`,{signal:AbortSignal.timeout(6000)});if(!r.ok)continue;const b=Buffer.from(await r.arrayBuffer());if(b.length>8000000)continue;const im=nativeImage.createFromBuffer(b);if(!im.isEmpty())out[id]=im.resize({width:300}).toDataURL();}catch{}}return out;},demo.map(g=>g.steamId));
  await page.evaluate(({demo,art})=>{for(const g of demo){const im=document.querySelector(`[data-game-card="${g.id}"] img`);if(art[g.steamId]){im.src=art[g.steamId];im.hidden=false;}}},{demo,art});
  await page.waitForTimeout(800);await page.screenshot({path:'output/ui-home.png'});
  console.log('PLAYER UI PASSED: no API/hash form, automatic EXE/API, multi-version import, real pinned ReShade plus synthetic addon/runtime transaction, A/B/A, repeated install no-op, original settings preserved, missing-EXE uninstall preserves shared loader/runtime, undo uninstall, clean-host cleanup, two feedback ZIPs and pasted summary, Bilibili. All game files synthetic; no game executable was launched.');
 }catch(e){try{if(page)await page.screenshot({path:'output/ui-failure.png'});}catch{}throw e;}finally{if(application)await application.close();await fs.rm(root,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
