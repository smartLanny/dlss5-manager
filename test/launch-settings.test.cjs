'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setup, consent } = require('./helpers.cjs');
const { LaunchSettings } = require('../src/core/launch-settings.cjs');
const policy = require('../src/core/launch-policy.cjs');
const { DRS } = require('../src/core/launch-profile-plan.cjs');
const clone = structuredClone;
const explicit = value => ({kind:'explicit',value,location:0,predefined:false});
const absent = () => ({kind:'absent',value:null,location:null,predefined:null});
function driver(initial) {
  let current=initial||{profile:null,settings:Object.fromEntries([...policy.IDS.sr,...policy.IDS.fg].map(id=>[id,absent()]))};
  return {
    writes:0, read:async()=>clone(current), peek:()=>clone(current), set:value=>{current=clone(value);},
    async write(exe,expected,desired) {
      assert.deepEqual(current,expected,'native CAS'); this.writes++;
      current=clone(desired);
      if(current.profile===null&&Object.values(current.settings).some(s=>s.kind==='explicit'))current.profile={name:'owned test',appName:exe,exclusive:true,owned:true};
      return clone(current);
    }
  };
}
async function fixture(t,options={}) {
  const f=await setup(t,options.engine), native=driver(options.initial);
  const settings=new LaunchSettings(f.engine,{driver:native,hardware:async()=>({family:options.family||'RTX40',activeGameAdapterVerified:false})});
  const file=path.join(f.gameRoot,policy.FILES.rtx40), original='{"version":11,"followGame":true,"mode":"fixed","multiplier":2,"other":{"retain":1}}\n';
  await fs.writeFile(file,original);
  return {...f,settings,native,file,original,apply:async(domain,request)=>settings.apply((await settings.preview(f.game.id,domain,request)).id,{confirm:true})};
}
const fixed=n=>({backend:'rtx40',mode:'fixed',multiplier:n});
const sr={backend:'native',quality:'custom',renderPercent:75,preset:'M'};

test('RTX40 request, transaction, repeated launch, field-aware restore and undo share Engine history',async t=>{
  const f=await fixture(t);await f.settings.save(f.game.id,'fg',fixed(3));
  assert.equal(await fs.readFile(f.file,'utf8'),f.original);assert.equal(f.engine.state.schema,5);
  const result=await f.apply('fg',fixed(3));assert.equal(result.phase,'file-readback');
  const installed=JSON.parse(await fs.readFile(f.file,'utf8'));assert.equal(installed.multiplier,3);assert.deepEqual(installed.other,{retain:1});
  const repeat=await f.settings.beforeLaunch(f.game.id);assert.equal(repeat[0].unchanged,true);assert.equal((await f.engine.history()).length,1);
  installed.other.retain=99;installed.generatedOnlyDebug=true;await fs.writeFile(f.file,JSON.stringify(installed));
  const restored=await f.apply('fg',{backend:'rtx40',mode:'restore'});
  const now=JSON.parse(await fs.readFile(f.file,'utf8'));assert.equal(now.multiplier,2);assert.equal(now.other.retain,99);assert.equal(now.generatedOnlyDebug,true);assert.equal(f.game.launchApplied.fg,undefined);
  await f.engine.recover(f.game.id,restored.transactionId);
  assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).multiplier,3);assert.equal(f.game.launchApplied.fg.request.multiplier,3);
  await f.engine.recover(f.game.id,result.transactionId);
  const end=JSON.parse(await fs.readFile(f.file,'utf8'));assert.equal(end.multiplier,2);assert.equal(end.other.retain,99);assert.equal(f.game.launchApplied.fg,undefined);
});

test('owned-key external edits and damaged originals block without overwriting',async t=>{
  const f=await fixture(t);await f.apply('fg',fixed(3));
  const installed=await fs.readFile(f.file,'utf8'), data=JSON.parse(installed);data.multiplier=4;await fs.writeFile(f.file,JSON.stringify(data));
  await assert.rejects(f.apply('fg',{backend:'rtx40',mode:'restore'}),{code:'SETTINGS_EXTERNAL_CHANGE'});
  assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).multiplier,4);
  await fs.writeFile(f.file,installed);await fs.writeFile(f.engine.backupPath(f.game.launchApplied.fg.baseline),'damaged');
  await assert.rejects(f.apply('fg',{backend:'rtx40',mode:'restore'}),{code:'BACKUP_DAMAGED'});
  assert.equal(await fs.readFile(f.file,'utf8'),installed);
});

test('write fault restores file and retains saved next-start intent',async t=>{
  const f=await fixture(t,{engine:{afterWrite:async()=>{throw Object.assign(new Error('fault'),{code:'TEST_FAULT'});}}});
  await f.settings.save(f.game.id,'fg',fixed(3));
  await assert.rejects(f.apply('fg',fixed(3)),{code:'TEST_FAULT'});
  assert.equal(await fs.readFile(f.file,'utf8'),f.original);assert.equal(f.game.launchRequests.fg.request.multiplier,3);assert.deepEqual(f.game.launchApplied,{});assert.equal((await f.engine.pending()).length,0);
});

test('recovery preserves a foreign restore stage and resumes after it is removed',async t=>{
  const f=await fixture(t);const op=await f.apply('fg',fixed(3));const j=(await f.engine.history())[0];
  const stage=f.engine.stagePath(j,0,true);await fs.writeFile(stage,'foreign');
  await assert.rejects(f.engine.recover(f.game.id,op.transactionId),{code:'STAGE_CHANGED'});
  assert.equal(await fs.readFile(stage,'utf8'),'foreign');assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).multiplier,3);
  await fs.unlink(stage);await f.engine.recover(f.game.id,op.transactionId);assert.equal(await fs.readFile(f.file,'utf8'),f.original);
});

test('saved EXE binding, process unknown and running block writes but permit saving',async t=>{
  let env={verified:false,running:[],antiCheat:[]};const f=await fixture(t,{engine:{environment:async()=>env}});
  await f.settings.save(f.game.id,'fg',fixed(3));await assert.rejects(f.apply('fg',fixed(3)),{code:'SETTINGS_BLOCKED'});
  env={verified:true,running:['Game'],antiCheat:[]};await assert.rejects(f.apply('fg',fixed(3)),{code:'SETTINGS_BLOCKED'});
  f.game.exe=path.join(f.gameRoot,'Other.exe');const outcomes=await f.settings.beforeLaunch(f.game.id);assert.match(outcomes[0].reason,/EXE/);assert.equal(await fs.readFile(f.file,'utf8'),f.original);
});

test('missing, oversized and nonmatching backend never create a fake installation',async t=>{
  const f=await fixture(t);await fs.unlink(f.file);await assert.rejects(f.apply('fg',fixed(3)),{code:'SETTINGS_BACKEND_MISSING'});
  await fs.writeFile(f.file,JSON.stringify({version:11,other:'x'.repeat(4100)}));await assert.rejects(f.apply('fg',fixed(3)),{code:'SETTINGS_SIZE'});
  await fs.writeFile(f.file,'{"version":12}');await assert.rejects(f.apply('fg',fixed(3)),{code:'PROTOCOL_MISMATCH'});
});

test('CET path selection edits only the backend-selected configuration',async t=>{
  const f=await fixture(t);const cet=path.join(f.gameRoot,policy.FILES.cet);await fs.mkdir(path.dirname(cet),{recursive:true});await fs.writeFile(path.join(path.dirname(cet),'init.lua'),'-- synthetic');await fs.writeFile(cet,f.original);
  await f.apply('fg',fixed(3));assert.equal(JSON.parse(await fs.readFile(cet,'utf8')).multiplier,3);assert.equal(await fs.readFile(f.file,'utf8'),f.original);
});

test('OptiScaler remains explicit, restores just owned SR keys and leaves FG/NR untouched',async t=>{
  const f=await fixture(t);const file=path.join(f.gameRoot,policy.FILES.optiscaler);const original='[UpscaleRatio]\r\nUpscaleRatioOverrideEnabled=false\r\n[FG]\r\nEnabled=true\r\n[NR]\r\nMode=2\r\n';await fs.writeFile(file,original);
  await f.apply('sr',{backend:'optiscaler',quality:'custom',renderPercent:75});assert.equal(f.native.writes,0);
  await fs.appendFile(file,'UserKey=7\r\n');await f.apply('sr',{backend:'optiscaler',quality:'game'});
  const result=await fs.readFile(file,'utf8');assert.match(result,/UpscaleRatioOverrideEnabled=false/);assert.doesNotMatch(result,/UpscaleRatioOverrideValue/);assert.match(result,/Enabled=true/);assert.match(result,/Mode=2/);assert.match(result,/UserKey=7/);
});

test('SR writes only SR; restores explicit zero, inherited and absent distinctly',async t=>{
  const f=await fixture(t,{family:'RTX50'});const initial=f.native.peek();initial.profile={name:'user',appName:f.game.exe,exclusive:true,owned:false};initial.settings[DRS.srMode]=explicit(0);initial.settings[DRS.srPreset]={kind:'inherited',value:11,location:1,predefined:false};f.native.set(initial);
  await f.apply('sr',sr);assert.equal(f.native.peek().settings[DRS.srRatio].value,75);for(const id of policy.IDS.fg)assert.deepEqual(f.native.peek().settings[id],initial.settings[id]);
  await f.apply('sr',{backend:'native',quality:'game'});assert.deepEqual(f.native.peek(),initial);assert.equal(f.game.launchApplied.sr,undefined);
});

test('SR and official FG restore independently and remove only the last owned profile',async t=>{
  const f=await fixture(t,{family:'RTX50'});const initial=f.native.peek();await f.apply('sr',sr);await f.apply('fg',{backend:'nvidia',mode:'fixed',multiplier:4});
  assert.equal(f.native.peek().settings[DRS.fgCount].value,3);
  await f.apply('sr',{backend:'native',quality:'game'});assert.ok(f.native.peek().profile);assert.equal(f.native.peek().settings[DRS.fgCount].value,3);
  await f.apply('fg',{backend:'nvidia',mode:'restore'});assert.deepEqual(f.native.peek(),initial);
});

test('driver CAS protects external changes after preview and unrelated settings survive restore',async t=>{
  const f=await fixture(t,{family:'RTX50'});const p=await f.settings.preview(f.game.id,'sr',sr);const changed=f.native.peek();changed.settings[DRS.srMode]=explicit(0);f.native.set(changed);
  await assert.rejects(f.settings.apply(p.id,{confirm:true}),{code:'SETTINGS_EXTERNAL_CHANGE'});assert.equal(f.native.writes,0);
  await f.apply('sr',sr);const later=f.native.peek();later.settings[DRS.fgCount]=explicit(2);f.native.set(later);
  // A real adapter refuses profile deletion when external explicit keys remain.
  const restore=await f.settings.preview(f.game.id,'sr',{backend:'native',quality:'game'});
  const cached=f.engine.plans.get(restore.id);assert.deepEqual(cached.driver.after.settings[DRS.fgCount],explicit(2));
});

test('failed native write after save is recovered by the persisted intent',async t=>{
  const f=await fixture(t,{family:'RTX50'}), baseline=f.native.peek(), write=f.native.write.bind(f.native);let once=true;
  f.native.write=async(...args)=>{const result=await write(...args);if(once){once=false;throw Object.assign(new Error('response lost'),{code:'NVAPI_READBACK_FAILED'});}return result;};
  await f.settings.save(f.game.id,'sr',sr);await assert.rejects(f.apply('sr',sr),{code:'NVAPI_READBACK_FAILED'});assert.deepEqual(f.native.peek(),baseline);assert.deepEqual(f.game.launchRequests.sr.request,sr);assert.equal((await f.engine.pending()).length,0);
});

test('restore is a real metadata transaction even when a managed value equals its baseline',async t=>{
  const f=await fixture(t,{family:'RTX50'});const initial=f.native.peek();initial.profile={name:'user',appName:f.game.exe,exclusive:true,owned:false};for(const o of policy.nativeSr({quality:'quality',preset:'M'}).operations)initial.settings[o.id]=explicit(o.value);f.native.set(initial);await f.apply('sr',sr);await f.apply('sr',{backend:'native',quality:'quality',preset:'M'});
  const result=await f.apply('sr',{backend:'native',quality:'game'});assert.equal(result.applied,true);assert.equal(f.game.launchApplied.sr,undefined);
});

test('configuration and addon operations share reverse recovery order',async t=>{
  const f=await fixture(t);const pkg=await f.add('0.5.0');const plan=await f.engine.preview(f.game.id,pkg.id);const install=await f.engine.apply(plan.id,consent);const config=await f.apply('fg',fixed(3));
  await assert.rejects(f.engine.recover(f.game.id,install.transactionId),{code:'RECOVERY_ORDER'});
  await f.engine.recover(f.game.id,config.transactionId);assert.ok(f.game.installed);await f.engine.recover(f.game.id,install.transactionId);assert.equal(f.game.installed,null);
});

test('official FG policy uses total minus one and never treats follow as off',()=>{
  assert.throws(()=>policy.validateRequest('fg',{backend:'nvidia',mode:'restore',multiplier:4}));
  assert.throws(()=>policy.validateRequest('fg',{backend:'rtx40',mode:'off'}));
  assert.equal(policy.nativeFg({mode:'fixed',multiplier:6}).operations.find(o=>o.id===DRS.fgCount).value,5);
  assert.equal(policy.nativeFg({mode:'dynamic',targetFps:0}).operations.find(o=>o.id===DRS.fgTarget).value,0x01000000);
});
