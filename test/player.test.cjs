'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setup, pe, temp, consent, cleanScan } = require('./helpers.cjs');
const { sha256, digestFile } = require('../src/core/safety.cjs');
const { Engine } = require('../src/core/engine.cjs');
const { PlayerService } = require('../src/core/player.cjs');
const { detectExecutable, detectGame } = require('../src/core/detection.cjs');
const { unpackOfficial, ensureReShade, validateLoaderFile, PIN } = require('../src/core/reshade.cjs');
const { importPackage, writeZip, guessVersion } = require('../src/core/packages.cjs');
const { download } = require('../src/core/network.cjs');
const { addonLocation } = require('../src/core/loader-config.cjs');
const { waitForGame } = require('../src/core/wait.cjs');
const rejects = c => e => e.code === c;
function apiPE(api, dll = false) { const b=pe(0,dll);Buffer.from(api).copy(b,550);return b; }
function importPE(name,dll=false) { const b=pe(0,dll);b.writeUInt32LE(0x1000,272);b.writeUInt32LE(40,276);b.writeUInt32LE(0x10bc,524);b.write(name+'\0',700);return b; }

test('automatic recognition uses one API; multiple APIs remain unresolved rather than guessed',async t=>{
 const root=await temp(t),file=path.join(root,'Game.exe');
 for(const [marker,api] of [['D3D12CreateDevice','DX12'],['D3D11CreateDevice','DX11'],['vkCreateInstance','Vulkan'],['wglCreateContext','OpenGL']]){
  await fs.writeFile(file,apiPE(marker));const r=await detectExecutable(file,root);assert.equal(r.api,api);assert.ok(r.confident);assert.equal(r.source,'entry-point-markers');
 }
 const b=apiPE('D3D12CreateDevice');Buffer.from('vkCreateInstance').copy(b,650);await fs.writeFile(file,b);
 const r=await detectExecutable(file,root);assert.equal(r.api,'');assert.deepEqual(r.candidates,['DX12','Vulkan']);
});
test('ordinary imports and linked engine DLL evidence are recognized without reading addons',async t=>{
 const root=await temp(t),file=path.join(root,'Game.exe');await fs.writeFile(file,importPE('d3d12.dll'));assert.equal((await detectExecutable(file,root)).source,'import-table');
 await fs.writeFile(file,importPE('engine.dll'));await fs.writeFile(path.join(root,'engine.dll'),importPE('d3d11.dll',true));
 const r=await detectExecutable(file,root);assert.equal(r.api,'DX11');assert.equal(r.source,'imported-engine-dll');
 await fs.writeFile(file,importPE('nvngx_dlssnr.dll'));await fs.writeFile(path.join(root,'nvngx_dlssnr.dll'),importPE('d3d12.dll',true));
 assert.equal((await detectExecutable(file,root)).api,'');
});
test('automatic identification excludes helper executables, x86 and changed runtime evidence',async t=>{
 const {game,engine,gameRoot}=await setup(t);await fs.writeFile(game.exe,apiPE('D3D12CreateDevice'));
 await detectGame(game,engine.root);assert.equal(game.api,'DX12');
 game.api='Vulkan';game.apiEvidence={source:'runtime-modules',api:'Vulkan',exeHash:await digestFile(game.exe)};
 await detectGame(game,engine.root);assert.equal(game.api,'Vulkan');
 await fs.writeFile(game.exe,apiPE('D3D11CreateDevice'));await detectGame(game,engine.root);assert.equal(game.api,'DX11');
 const helper=path.join(gameRoot,'CrashReporter.exe');await fs.writeFile(helper,apiPE('D3D12CreateDevice'));assert.equal((await detectExecutable(helper,gameRoot)).confident,false);
 await fs.writeFile(game.exe,pe(0,false,false));assert.equal((await detectExecutable(game.exe,gameRoot)).confident,false);
});
test('bare addon import automatically labels version and has no user API or hash requirement',async t=>{
 const {engine,sourceRoot}=await setup(t),p=new PlayerService(engine),file=path.join(sourceRoot,'NR-0.4.2Beta.addon64');await fs.writeFile(file,pe(6));
 const pkg=await p.import(file);assert.equal(pkg.manifest.version,'0.4.2beta');assert.equal(pkg.manifest.apiPolicy,'detect-target');assert.deepEqual(pkg.manifest.apis,[]);
 assert.equal((await p.import(file)).id,pkg.id);assert.equal(engine.state.packages.length,1);assert.equal(engine.state.schema,3);
 assert.equal(guessVersion('something-without-version'),null);
 const reopened=await new Engine(engine.root).init();assert.equal(reopened.state.packages.length,1);
});
test('single addon ZIP is supported but extra executable and graphics proxies are not silently imported',async t=>{
 const root=await temp(t),file=path.join(root,'v0.4.2beta.zip');await fs.writeFile(file,writeZip([['nr.addon64',pe()]]));
 const p=await importPackage(file,{acceptLocal:true},path.join(root,'cache'));assert.equal(p.manifest.version,'0.4.2beta');
 for(const name of ['setup.exe','dxgi.dll','mod.asi']){
  await fs.writeFile(file,writeZip([['nr.addon64',pe()],[name,pe()]]));await assert.rejects(importPackage(file,{acceptLocal:true},path.join(root,'cache')),rejects('EXTRA_PAYLOAD'));
 }
});
test('A/B slots accept future versions without changing the initial backup; A/B/A is exact',async t=>{
 const {engine,game,gameRoot,add}=await setup(t),p=new PlayerService(engine),a=await add('0.3.3.4',1),b=await add('0.9.9beta',2);
 const original=pe(8);await fs.writeFile(path.join(gameRoot,'nr.addon64'),original);await p.assign(game.id,a.id,b.id);
 assert.equal(p.preferred(game,'B').id,b.id);
 await engine.apply((await engine.preview(game.id,a.id)).id,consent);const baseline=structuredClone(game.installed.files[0].baseline);
 await engine.apply((await engine.preview(game.id,b.id)).id,consent);
 await engine.apply((await engine.preview(game.id,a.id)).id,{...consent,downgrade:true});
 const n=(await engine.history()).length;const result=await engine.apply((await engine.preview(game.id,a.id)).id,consent);assert.equal(result.noOp,true);assert.equal((await engine.history()).length,n);assert.deepEqual(game.installed.files[0].baseline,baseline);
 await engine.apply((await engine.preview(game.id,null,'uninstall')).id,consent);assert.deepEqual(await fs.readFile(path.join(gameRoot,'nr.addon64')),original);
});
test('online and anti-cheat signals require warning consent, not a blanket prohibition',async t=>{
 const {engine,game,add}=await setup(t);const a=await add('0.3.3.4');
 engine.deps.scan=async g=>({...await cleanScan(g),riskWarnings:[{code:'ANTI_CHEAT_FILES',message:'测试反作弊提醒'},{code:'ONLINE_GAME',message:'测试联网提醒'}]});
 const plan=await engine.preview(game.id,a.id);assert.equal(plan.blockers.length,0);
 await assert.rejects(engine.apply(plan.id,consent),rejects('RISK_CONFIRMATION'));
 await engine.apply((await engine.preview(game.id,a.id)).id,{...consent,riskCodes:['ANTI_CHEAT_FILES','ONLINE_GAME']});assert.equal(game.installed.version,'0.3.3.4');
});
test('a changed proxy with the same warning code cannot reuse stale consent',async t=>{
 const {engine,game,gameRoot,add}=await setup(t);const a=await add('0.3.3.4');let hash='1'.repeat(64);
 engine.deps.scan=async g=>({...await cleanScan(g),files:[{name:'dxgi.dll',path:path.join(gameRoot,'dxgi.dll'),proxy:true,sha256:hash}],riskWarnings:[{code:'UNKNOWN_PROXY',message:'保持原样'}]});
 const p=await engine.preview(game.id,a.id);hash='2'.repeat(64);
 await assert.rejects(engine.apply(p.id,{...consent,riskCodes:['UNKNOWN_PROXY']}),rejects('RISK_CHANGED'));assert.equal((await engine.history()).length,0);
});
test('changing the real EXE after preview stops installation',async t=>{
 const {engine,game,add}=await setup(t);const a=await add('0.3.3.4'),p=await engine.preview(game.id,a.id);await fs.writeFile(game.exe,pe(5,false));
 await assert.rejects(engine.apply(p.id,consent),rejects('EXE_CHANGED'));
});
test('unknown graphics proxies are preserved for addon-only updates, never overwritten by prepared ReShade',async t=>{
 const {engine,game,gameRoot,add}=await setup(t);const a=await add('0.3.3.4'),target=path.join(gameRoot,'dxgi.dll');await fs.writeFile(target,pe(4));
 engine.deps.scan=async g=>({...await cleanScan(g),files:[{name:'dxgi.dll',path:target,proxy:true,sha256:sha256(pe(4))}],riskWarnings:[{code:'UNKNOWN_PROXY',message:'保留未知代理'}]});
 await engine.apply((await engine.preview(game.id,a.id)).id,{...consent,riskCodes:['UNKNOWN_PROXY']});assert.deepEqual(await fs.readFile(target),pe(4));
 assert.throws(()=>validateLoaderFile({role:'reshade-loader',name:'dxgi.dll',before:sha256(pe(4)),after:PIN.dll.sha256}),rejects('PROTECTED_FILE'));
});
test('externally modified managed addon can be captured and switched without discarding the external version',async t=>{
 const {engine,game,gameRoot,add}=await setup(t),a=await add('0.3.3.4',1),b=await add('0.4.2beta',2),target=path.join(gameRoot,'nr.addon64');
 await fs.writeFile(target,pe(9));await engine.apply((await engine.preview(game.id,a.id)).id,consent);await fs.writeFile(target,pe(5));
 const drift=await engine.preview(game.id,b.id);assert.ok(drift.blockers.length);assert.equal(drift.driftFiles[0].capturable,true);
 await assert.rejects(engine.captureAddon(game.id,false),rejects('CAPTURE_CONFIRMATION'));
 const captured=await engine.captureAddon(game.id,true);assert.deepEqual(await fs.readFile(target),pe(5));assert.equal(engine.package(captured.packageId).manifest.files[0].sha256,sha256(pe(5)));
 const r=await engine.apply((await engine.preview(game.id,b.id)).id,{...consent,downgrade:true});assert.deepEqual(await fs.readFile(target),pe(2));
 await engine.recover(game.id,r.transactionId);assert.deepEqual(await fs.readFile(target),pe(5));
 await engine.recover(game.id,captured.transactionId);assert.deepEqual(await fs.readFile(target),pe(1));
 await engine.apply((await engine.preview(game.id,null,'uninstall')).id,consent);assert.deepEqual(await fs.readFile(target),pe(9));
 assert.equal(await digestFile(path.join(engine.root,'packages',captured.packageId,'nr.addon64')),sha256(pe(5)));
});
test('drift capture refuses missing files, unknown files, runtime changes and corrupted prior cache',async t=>{
 const {engine,game,gameRoot,add}=await setup(t),a=await add('0.3.3.4'),target=path.join(gameRoot,'nr.addon64');
 await engine.apply((await engine.preview(game.id,a.id)).id,consent);await fs.unlink(target);
 await assert.rejects(engine.captureAddon(game.id,true),rejects('CAPTURE_UNSAFE'));
 await fs.writeFile(target,pe(5));await fs.writeFile(path.join(engine.root,'packages',a.id,'nr.addon64'),pe(3));
 await assert.rejects(engine.captureAddon(game.id,true),rejects('CACHE_TAMPERED'));assert.deepEqual(await fs.readFile(target),pe(5));
});
test('wait for exit supports retry, cancellation and finite timeout; never writes a file',async()=>{
 let n=0;const check=async()=>({verified:true,running:++n<3?['game']:[]});assert.equal((await waitForGame(check,{delay:async()=>{},attempts:4})).ready,true);
 const c=new AbortController();c.abort();assert.equal((await waitForGame(check,{signal:c.signal})).cancelled,true);
 assert.equal((await waitForGame(async()=>({verified:true,running:['game']}),{delay:async()=>{},attempts:2})).timeout,true);
 await assert.rejects(waitForGame(async()=>({verified:false,running:[]})),rejects('PROCESS_CHECK_FAILED'));
});
test('custom ReShade AddonPath is detected and never overwritten',async t=>{
 const root=await temp(t),file=path.join(root,'ReShade.ini');assert.equal((await addonLocation(root)).state,'default');
 await fs.writeFile(file,'[ADDON]\nAddonPath=mods\n');assert.equal((await addonLocation(root)).state,'custom');assert.equal(await fs.readFile(file,'utf8'),'[ADDON]\nAddonPath=mods\n');
 await fs.writeFile(file,Buffer.concat([Buffer.from([255,254]),Buffer.from('[ADDON]\r\nAddonPath=.\r\n','utf16le')]));assert.equal((await addonLocation(root)).state,'default');
});
test('official runtime extractor requires exact transport and payload hashes; verified cache reused offline',async t=>{
 const root=await temp(t),dll=apiPE('Searching for add-ons',true),zip=writeZip([['ReShade64.dll',dll],['ReShade64.json',Buffer.from('{}')]]),bytes=Buffer.concat([Buffer.alloc(180),zip]);
 const pin={version:'0.0-test',url:'https://example.invalid/test',size:bytes.length,sha256:sha256(bytes),dll:{name:'ReShade64.dll',size:dll.length,sha256:sha256(dll)}};
 assert.deepEqual(unpackOfficial(bytes,pin),dll);
 const changed=Buffer.from(bytes);changed[1]=1;assert.throws(()=>unpackOfficial(changed,pin),rejects('RESHADE_CHECKSUM'));
 await ensureReShade(root,()=>{},{pin,download:async()=>bytes});await ensureReShade(root,()=>{},{pin,download:async()=>{throw new Error('Must reuse verified cache');}});
});
test('network download refuses failed or oversized responses before file installation',async()=>{
 await assert.rejects(download('https://example.invalid',{maxBytes:3},async()=>new Response('abcdef')),rejects('DOWNLOAD_SIZE'));
 await assert.rejects(download('https://example.invalid',{},async()=>new Response('bad',{status:403})),rejects('DOWNLOAD_FAILED'));
 assert.equal((await download('https://example.invalid',{},async()=>new Response('okay'))).toString(),'okay');
});
test('unreadable directory does not permit automatically adding a new loader',async t=>{
 const {engine,game,add}=await setup(t);const a=await add('0.3.3.4');
 engine.deps.scan=async g=>({...await cleanScan(g),riskWarnings:[{code:'SCAN_PARTIAL',message:'incomplete'}]});
 const p=new PlayerService(engine,{detect:async()=>({}),runtime:async()=>{throw new Error('Must not prepare a loader from incomplete evidence');}});
 const plan=await p.prepare(game.id,a.id);assert.equal(plan.kind,'blocked');
});
test('new risks in a same-version check still require explicit consent',async t=>{
 const {engine,game,add}=await setup(t);const a=await add('0.3.3.4');await engine.apply((await engine.preview(game.id,a.id)).id,consent);
 engine.deps.scan=async g=>({...await cleanScan(g),riskWarnings:[{code:'ANTI_CHEAT_SERVICE',message:'new signal'}]});
 const p=await engine.preview(game.id,a.id);assert.equal(p.noOp,true);await assert.rejects(engine.apply(p.id,consent),rejects('RISK_CONFIRMATION'));
});
