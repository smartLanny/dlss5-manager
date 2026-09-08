'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {setup,pe,consent}=require('./helpers.cjs');
const {detectExecutable,detectGame}=require('../src/core/detection.cjs');
const {PlayerService}=require('../src/core/player.cjs');
function imports(names,dll=false){const b=pe(0,dll);b.writeUInt32LE(0x1000,272);b.writeUInt32LE((names.length+1)*20,276);for(let i=0;i<names.length;i++){b.writeUInt32LE(0x1000+188+i*40,524+i*20);b.write(names[i]+'\0',700+i*40);}return b;}
test('Watch Dogs Legion DXGI case remains pending; explicit DX12 survives rescans and EXE updates',async t=>{
  const f=await setup(t),player=new PlayerService(f.engine);await fs.writeFile(f.game.exe,imports(['dxgi.dll']));
  const detection=await detectGame(f.game,f.engine.root);assert.equal(detection.state,'needs-observation');assert.equal(f.game.api,'');assert.match(detection.message,/API 待确认/);
  await player.setApi(f.game.id,'DX12');assert.equal(f.game.api,'DX12');assert.equal(f.game.apiEvidence.source,'manual');assert.equal(f.game.apiEvidence.runtimeVerified,false);
  await fs.writeFile(f.game.exe,imports(['d3d11.dll']));await player.identify(f.game.id);assert.equal(f.game.api,'DX12');assert.deepEqual(f.game.apiEvidence.candidates,['DX11']);
  const pkg=await f.add('0.5.0');await f.engine.apply((await f.engine.preview(f.game.id,pkg.id)).id,consent);assert.equal(f.game.installed.version,'0.5.0');
});
test('direct DX11 imports do not suppress DX12 imported engine evidence',async t=>{
  const f=await setup(t);await fs.writeFile(f.game.exe,imports(['d3d11.dll','engine.dll']));await fs.writeFile(path.join(f.gameRoot,'engine.dll'),imports(['d3d12.dll'],true));
  const evidence=await detectExecutable(f.game.exe,f.gameRoot);assert.equal(evidence.api,'');assert.deepEqual(evidence.candidates,['DX11','DX12']);assert.equal(evidence.source,'combined-static');
});
test('API preference does not leak to a different EXE and automatic selection can be restored',async t=>{
  const f=await setup(t),p=new PlayerService(f.engine);await fs.writeFile(f.game.exe,imports(['d3d11.dll']));await p.setApi(f.game.id,'DX12');
  const other=path.join(f.gameRoot,'Other.exe');await fs.copyFile(f.game.exe,other);f.game.exe=other;await p.identify(f.game.id);assert.equal(f.game.api,'');assert.deepEqual(f.game.apiEvidence.candidates,['DX11']);assert.notEqual(f.game.apiEvidence.source,'manual');
  await p.setApi(f.game.id,'DX12');await p.setApi(f.game.id,'auto');assert.equal(f.game.api,'');assert.equal(f.game.apiPreference,null);
});
test('runtime module observation preserves explicit API and does not claim active rendering',async t=>{
  const f=await setup(t),p=new PlayerService(f.engine,{running:async()=>[{exe:f.game.exe,modules:['d3d11.dll']}]});await p.setApi(f.game.id,'DX12');await p.observe(f.game.id);
  assert.equal(f.game.api,'DX12');assert.equal(f.game.apiEvidence.source,'manual');assert.equal(f.game.apiEvidence.runtimeVerified,false);
});
test('API choice cannot make a helper EXE, x86 or unknown enum installable',async t=>{
  const f=await setup(t),p=new PlayerService(f.engine);await assert.rejects(p.setApi(f.game.id,'DXGI'),{code:'API_INVALID'});await fs.writeFile(f.game.exe,pe(0,false,false));await assert.rejects(p.setApi(f.game.id,'DX12'),{code:'EXE_INVALID'});
});
