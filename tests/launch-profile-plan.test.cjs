'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const p = require('../src/core/launch-profile-plan.cjs');
const ini = require('../src/vendor/swapper-ini.cjs');
const original = '\uFEFF; keep user tuning\r\n[UpscaleRatio]\r\nUpscaleRatioOverrideEnabled=auto\r\nUpscaleRatioOverrideValue=1.3\r\n[DLSSG]\r\nInterpolationCount=2\r\n[DlssNr]\r\nEnabled=false\r\n[DRS]\r\nEnabled=true\r\n';
const control = JSON.stringify({ version:11, followGame:true, mode:'follow', multiplier:2,
  dynamicTargetFrameRate:0, dynamicExperimental56:false, intervalLogging:false, custom:{keep:'玩家'} });
const now = 1788822000000;
const status = { heartbeat:now/1000, activeWrapperObserved:true, safeMaximumMultiplier:4,
  dynamicMfgSupportKnown:true, dynamicMfgSupported:true };
const isCode = code => e => e.code === code;
function previewOnly(x) { assert.equal(x.applied,false); assert.equal(x.runtimeVerified,false); assert.equal(x.phase,'preview-only'); }
test('native SR emits only the documented SR keys and leaves model untouched by default', () => {
  const x=p.planNvidiaSr({quality:'quality'}); previewOnly(x);
  assert.deepEqual(x.operations.map(o=>[o.id,o.value]), [[0x10E41E01,1],[0x10AFB768,2],[0x10E41DF5,0]]);
  assert.equal(x.operations.some(o=>o.id===p.DRS.fgMode),false);
});
test('native SR custom range and explicit model are independent', () => {
  const x=p.planNvidiaSr({quality:'custom',renderPercent:75,preset:'M'});
  assert.equal(x.operations.find(o=>o.id===p.DRS.srRatio).value,75);
  assert.equal(x.operations.find(o=>o.id===p.DRS.srPreset).value,13);
  for(const v of [NaN,Infinity,32,101,75.1,'75']) assert.throws(()=>p.planNvidiaSr({quality:'custom',renderPercent:v}),isCode('INVALID_RANGE'));
});
test('follow native requests restoration of owned keys, not profile deletion', () => {
  const x=p.planNvidiaSr({quality:'game'});previewOnly(x);
  assert.equal(x.operations[0].action,'restore-owned-settings');
  assert.throws(()=>p.planNvidiaSr({quality:'game',preset:'K'}),isCode('CONFLICTING_REQUEST'));
});
test('quality modes map explicitly and unknown fields cannot change the scope', () => {
  for(const [quality,value] of Object.entries({performance:0,balanced:1,quality:2,dlaa:4,ultraPerformance:5}))
    assert.equal(p.planNvidiaSr({quality}).operations[1].value,value);
  for(const quality of ['off','__proto__','constructor','latest']) assert.throws(()=>p.planNvidiaSr({quality}),isCode('UNKNOWN_QUALITY'));
  assert.throws(()=>p.planNvidiaSr({quality:'dlaa',fg:true}),isCode('UNKNOWN_FIELD'));
  assert.throws(()=>p.planNvidiaSr({quality:'quality',preset:'Z'}),isCode('UNKNOWN_PRESET'));
});
test('OptiScaler receives output/input ratio; unrelated NR/FG/DRS values survive', () => {
  const x=p.planOptiScalerSr(original,{quality:'custom',renderPercent:75}); previewOnly(x);
  assert.equal(ini.getIni(x.content,'UpscaleRatio','UpscaleRatioOverrideEnabled'),'true');
  assert.equal(ini.getIni(x.content,'UpscaleRatio','UpscaleRatioOverrideValue'),'1.333333333');
  assert.equal(ini.getIni(x.content,'DLSSG','InterpolationCount'),'2');
  assert.equal(ini.getIni(x.content,'DlssNr','Enabled'),'false');
  assert.equal(ini.getIni(x.content,'DRS','Enabled'),'true');
  assert.equal(x.content.startsWith('\uFEFF'),true); assert.equal(/(?<!\r)\n/.test(x.content),false);
  assert.notEqual(x.beforeSha256,x.afterSha256);
});
test('OptiScaler presets use its own numerical conventions and repeated edit is stable', () => {
  for(const [quality,ratio] of Object.entries({dlaa:1,quality:1.5,balanced:1.7,performance:2,ultraPerformance:3})) {
    const x=p.planOptiScalerSr(original,{quality});
    assert.equal(Number(ini.getIni(x.content,'UpscaleRatio','UpscaleRatioOverrideValue')),ratio);
    assert.equal(p.planOptiScalerSr(x.content,{quality}).afterSha256,x.afterSha256);
  }
});
test('ambiguous duplicate target keys/sections are not partly edited', () => {
  for(const x of ['[UpscaleRatio]\nUpscaleRatioOverrideValue=2\nupscaleratiooverridevalue=1.5\n',
                 '[UpscaleRatio]\n[UpscaleRatio]\n', '[UpscaleRatio] ; comment\n'])
    assert.throws(()=>p.planOptiScalerSr(x,{quality:'quality'}),isCode('AMBIGUOUS_INI'));
});
test('OptiScaler follow is a merge-restore request, not a hard-coded false value', () => {
  const x=p.planOptiScalerSr(original,{quality:'game'}); previewOnly(x);
  assert.equal(x.content,undefined);assert.equal(x.operations[0].action,'restore-owned-ini-keys');
});
test('text and scale bounds reject unsupported requests without input mutation', () => {
  for(const t of [null,'\u0000bad','bad\uFFFD','x'.repeat(1024*1024+1)])
    assert.throws(()=>p.planOptiScalerSr(t,{quality:'quality'}),isCode('INVALID_TEXT'));
  assert.throws(()=>p.planOptiScalerSr(original,{quality:'custom',renderPercent:33}),isCode('INVALID_RANGE'));
  assert.throws(()=>p.planOptiScalerSr(original,{quality:'quality',renderPercent:50}),isCode('CONFLICTING_REQUEST'));
});
test('RTX40 control preserves unknown settings but distinguishes request from runtime', () => {
  const x=p.planRtx40Mfg(control,{mode:'fixed',multiplier:3},status,now); previewOnly(x);
  const out=JSON.parse(x.content);assert.equal(out.mode,'fixed');assert.equal(out.followGame,false);
  assert.equal(out.multiplier,3); assert.equal(out.intervalLogging,false);assert.deepEqual(out.custom,{keep:'玩家'});
  assert.equal(x.feasibility,'within-reported-limit'); assert.equal(x.automaticApplicationAllowed,false);
  assert.equal(JSON.parse(control).mode,'follow');
});
test('no external off is invented, no protocol mismatch is overwritten', () => {
  assert.throws(()=>p.planRtx40Mfg(control,{mode:'off'}),isCode('UNKNOWN_MODE'));
  assert.throws(()=>p.planRtx40Mfg('{bad',{mode:'follow'}),isCode('INVALID_JSON'));
  assert.throws(()=>p.planRtx40Mfg('{"version":12}',{mode:'follow'}),isCode('PROTOCOL_MISMATCH'));
});
test('six-times request is preserved for review but never silently accepted as four', () => {
  const x=p.planRtx40Mfg(control,{mode:'fixed',multiplier:6},status,now);
  assert.equal(JSON.parse(x.content).multiplier,6);assert.equal(x.feasibility,'outside-reported-limit');
  assert.equal(x.automaticApplicationAllowed,false);
});
test('dynamic target and experimental56 are explicit separate inputs', () => {
  const x=p.planRtx40Mfg(control,{mode:'dynamic',targetFps:144,experimental56:true},status,now);
  assert.equal(JSON.parse(x.content).dynamicTargetFrameRate,144); assert.equal(x.feasibility,'outside-reported-limit');
  assert.throws(()=>p.planRtx40Mfg(control,{mode:'fixed',multiplier:4,targetFps:144}),isCode('CONFLICTING_REQUEST'));
  assert.throws(()=>p.planRtx40Mfg(control,{mode:'dynamic',targetFps:1001}),isCode('INVALID_RANGE'));
});
test('dynamic unsupported and missing/stale backend evidence remain explicit', () => {
  const x=p.planRtx40Mfg(control,{mode:'dynamic'},{...status,dynamicMfgSupported:false},now);
  assert.equal(x.feasibility,'dynamic-reported-unsupported');
  assert.equal(p.reviewMfgStatus(null,now).state,'unknown');
  assert.equal(p.reviewMfgStatus({...status,heartbeat:now/1000-6},now).state,'stale');
  assert.equal(p.reviewMfgStatus({...status,heartbeat:now/1000+6},now).state,'stale');
  assert.equal(p.reviewMfgStatus({...status,activeWrapperObserved:false},now).state,'unknown');
  assert.equal(p.reviewMfgStatus({...status,safeMaximumMultiplier:16},now).state,'unknown');
});
test('follow is not mislabelled as disabling game FG, debug values remain disclosed', () => {
  const x=p.planRtx40Mfg(JSON.stringify({...JSON.parse(control),generatedOnlyDebug:true}),{mode:'follow'});
  assert.equal(JSON.parse(x.content).followGame,true);assert.equal(x.feasibility,'follow-request');
  assert.equal(JSON.parse(x.content).generatedOnlyDebug,true);assert.ok(x.warnings.some(t=>t.includes('generatedOnlyDebug')));
});
test('CLI performs real stdin-to-preview translation, no path/file apply surface', () => {
  const exe=path.join(__dirname,'../scripts/preview-launch-profile.cjs');
  const r=spawnSync(process.execPath,[exe],{encoding:'utf8',input:JSON.stringify({backend:'optiscaler-sr',originalText:original,request:{quality:'performance'}})});
  assert.equal(r.status,0,r.stderr);const data=JSON.parse(r.stdout);previewOnly(data);
  assert.equal(ini.getIni(data.content,'UpscaleRatio','UpscaleRatioOverrideValue'),'2');
  const bad=spawnSync(process.execPath,[exe],{encoding:'utf8',input:JSON.stringify({backend:'nvapi-sr',request:{quality:'quality'},gamePath:'C:\\Game'})});
  assert.equal(bad.status,1);assert.equal(bad.stdout,'');assert.match(bad.stderr,/UNKNOWN_FIELD/);
});
test('CLI malformed JSON produces no partially valid plan', () => {
  const r=spawnSync(process.execPath,[path.join(__dirname,'../scripts/preview-launch-profile.cjs')],{encoding:'utf8',input:'{"backend":'});
  assert.equal(r.status,1);assert.equal(r.stdout,'');
});

test('unknown dynamic support is not classified as explicitly unsupported', () => {
  const x=p.planRtx40Mfg(control,{mode:'dynamic'},{...status,dynamicMfgSupportKnown:false},now);
  assert.equal(x.feasibility,'unknown');assert.equal(x.evidence.dynamicSupported,null);
  const y=p.planRtx40Mfg(control,{mode:'dynamic'},{...status,dynamicMfgSupported:'false'},now);
  assert.equal(y.feasibility,'unknown');
});
test('unknown JSON values and section syntax cannot be silently reinterpreted', () => {
  for(const raw of ['1e999','9007199254740993','-0'])
    assert.throws(()=>p.planRtx40Mfg('{"version":11,"custom":'+raw+'}',{mode:'follow'}),isCode('INVALID_JSON_VALUE'));
  assert.throws(()=>p.planOptiScalerSr('[UpscaleRatio]\n[Other] ; comment\nUpscaleRatioOverrideValue=2\n',{quality:'quality'}),isCode('AMBIGUOUS_INI'));
});


test('ambiguous INI section boundaries cannot rewrite an unrelated section', () => {
  const original = '[UpscaleRatio]\nUpscaleRatioOverrideEnabled=false\n[Other] trailing\nUpscaleRatioOverrideValue=77\n';
  assert.throws(() => p.planOptiScalerSr(original, {quality:'performance'}), {code:'AMBIGUOUS_INI'});
});

test('duplicate control members cannot select a different protocol or hide debug values', () => {
  for (const text of [
    '{"version":12,"version":11,"generatedOnlyDebug":true,"generatedOnlyDebug":false}',
    '{"version":11,"custom":{"x":1,"x":2}}',
    '{"version":11,"custom":{"x":1,"\\u0078":2}}'
  ]) assert.throws(() => p.planRtx40Mfg(text, {mode:'follow'}), {code:'DUPLICATE_JSON_KEY'});
});
