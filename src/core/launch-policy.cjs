'use strict';
// Scoped configuration policy. It does not install an SR/FG/NR implementation.
const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, noLinks, sha256 } = require('./safety.cjs');
const compiler = require('./launch-profile-plan.cjs');
const ini = require('../vendor/swapper-ini.cjs');
const DRS = compiler.DRS;
const IDS = Object.freeze({ sr:[DRS.srOverride,DRS.srMode,DRS.srRatio,DRS.srPreset], fg:[DRS.fgMode,DRS.fgCount,DRS.fgDynamicMax,DRS.fgTarget] });
const FILES = Object.freeze({ optiscaler:'OptiScaler.ini', rtx40:'RTX40MFG-Universal.json', cet:path.join('plugins','cyber_engine_tweaks','mods','RTX40MFG','RTX40MFG-Universal.json') });
const CONTROL_KEYS = ['version','followGame','mode','multiplier','dynamicTargetFrameRate','dynamicExperimental56'];
const INI_KEYS = ['UpscaleRatioOverrideEnabled','UpscaleRatioOverrideValue'];
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);

function validateRequest(domain, input) {
  if (!Object.hasOwn(IDS,domain) || !input || typeof input !== 'object' || Array.isArray(input)) fail('SETTINGS_INPUT','图像设置请求无效。');
  const allowed = domain === 'sr' ? ['backend','quality','renderPercent','preset'] : ['backend','mode','multiplier','targetFps','experimental56'];
  if (Object.keys(input).some(k=>!allowed.includes(k))) fail('SETTINGS_INPUT','请求含不属于此设置域的字段。');
  if (domain === 'sr' && !['native','optiscaler'].includes(input.backend) || domain === 'fg' && !['nvidia','rtx40'].includes(input.backend)) fail('SETTINGS_BACKEND','请选择已安装的对应后端。');
  const request = structuredClone(input);
  if (domain === 'sr') {
    if (request.backend === 'native' && request.quality === 'preserve') {
      if (!['K','L','M'].includes(request.preset) || request.renderPercent !== undefined) fail('SETTINGS_INPUT','只改模型时请选择 K/L/M，不同时指定渲染比例。');
    } else if (request.backend === 'native') compiler.planNvidiaSr(withoutBackend(request));
    else compiler.planOptiScalerSr('', withoutBackend(request));
  } else if (request.backend === 'nvidia') nativeFg(request);
  else if(request.mode==='restore'){if(Object.keys(request).some(k=>!['backend','mode'].includes(k)))fail('SETTINGS_INPUT','恢复请求不能包含倍率。');}
  else compiler.planRtx40Mfg('{"version":11}', withoutBackend(request));
  return request;
}
function withoutBackend(request) { const {backend,...fields}=request; return fields; }
function isRestore(domain, request) { return domain === 'sr' ? request.quality === 'game' : request.mode === 'restore'; }
function nativeSr(request) {
  if (request.quality === 'preserve') return { operations:[{action:'set-dword',id:DRS.srOverride,value:1},{action:'set-dword',id:DRS.srPreset,value:{K:11,L:12,M:13}[request.preset]}] };
  return compiler.planNvidiaSr(withoutBackend(request));
}
function nativeFg(request) {
  if (!['restore','off','fixed','dynamic'].includes(request.mode)) fail('SETTINGS_INPUT','官方 FG 模式无效。');
  if (request.mode === 'restore') {
    if (Object.keys(request).some(k=>!['backend','mode'].includes(k))) fail('SETTINGS_INPUT','恢复请求不能包含倍率。');
    return {operations:[]};
  }
  if (request.mode !== 'fixed' && request.multiplier !== undefined || request.mode !== 'dynamic' && request.targetFps !== undefined || request.experimental56 !== undefined) fail('SETTINGS_INPUT','请只填写当前官方 FG 模式的参数。');
  if (request.mode === 'fixed' && (!Number.isInteger(request.multiplier)||request.multiplier<2||request.multiplier>6)) fail('SETTINGS_INPUT','总倍率请求范围为 2–6；不代表当前游戏已支持。');
  if (request.mode === 'dynamic' && (!Number.isInteger(request.targetFps)||request.targetFps<0||request.targetFps>1000)) fail('SETTINGS_INPUT','动态目标为 0（自动）或 1–1000 FPS。');
  const values = request.mode === 'off' ? [1,0,0,0] : request.mode === 'fixed'
    ? [2,request.multiplier-1,0,0] : [4,0,0,request.targetFps===0?0x01000000:request.targetFps];
  return {operations:IDS.fg.map((id,i)=>({action:'set-dword',id,value:values[i]})),runtimeVerified:false};
}
async function readText(file, allowMissing=false) {
  await noLinks(file);
  let data; try { data=await fs.readFile(file); } catch(e) { if(e.code==='ENOENT'&&allowMissing)return null; throw e; }
  if(data.length>1024*1024)fail('SETTINGS_SIZE','配置文件超过安全处理范围。');
  try { return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data); }
  catch { fail('SETTINGS_ENCODING','配置不是有效 UTF-8，保留原文件。'); }
}
async function controlPath(root, backend) {
  if(backend==='optiscaler')return FILES.optiscaler;
  if(process.env.RTX40_MFG_CONFIG_PATH)fail('SETTINGS_PATH_OVERRIDE','检测到社区后端自定义配置路径；请先在该后端确认路径，管理器不会猜测。');
  // The pinned universal backend gives CET priority, never writes both copies.
  const cetInit=path.join(root,path.dirname(FILES.cet),'init.lua');
  await noLinks(cetInit);
  try { if((await fs.stat(cetInit)).isFile()) return FILES.cet; } catch(e) { if(e.code!=='ENOENT')throw e; }
  return FILES.rtx40;
}
function validConfigName(name, backend) {
  return backend==='optiscaler' ? name===FILES.optiscaler : backend==='rtx40' && [FILES.rtx40,FILES.cet].includes(name);
}
function values(text, backend) {
  if(backend==='optiscaler') {
    compiler.planOptiScalerSr(text,{quality:'game'});
    return Object.fromEntries(INI_KEYS.map(k=>[k,ini.getIni(text,'UpscaleRatio',k)]));
  }
  compiler.planRtx40Mfg(text,{mode:'follow'}); // Includes duplicate-member checks.
  const data=JSON.parse(text.replace(/^\uFEFF/,''));
  return Object.fromEntries(CONTROL_KEYS.map(k=>[k,Object.hasOwn(data,k)?{value:data[k]}:null]));
}
function restoreText(current, original, afterValues, backend) {
  const now=values(current,backend), before=values(original,backend);
  for(const key of Object.keys(afterValues))if(!same(now[key],afterValues[key]))fail('SETTINGS_EXTERNAL_CHANGE','本工具修改的设置已被其他程序改变，保留当前配置和备份。');
  if(backend==='rtx40') {
    const data=JSON.parse(current.replace(/^\uFEFF/,''));
    for(const key of Object.keys(afterValues)) { if(before[key]===null)delete data[key];else data[key]=before[key].value; }
    return (current.startsWith('\uFEFF')?'\uFEFF':'')+JSON.stringify(data,null,2).replace(/\n/g,current.includes('\r\n')?'\r\n':'\n')+(current.includes('\r\n')?'\r\n':'\n');
  }
  let result=current;
  for(const key of Object.keys(afterValues)) {
    if(before[key]!==null) { const bom=result.startsWith('\uFEFF')?'\uFEFF':''; result=bom+ini.setIni(result,'UpscaleRatio',key,before[key]); }
    else {
      const newline=result.includes('\r\n')?'\r\n':'\n', bom=result.startsWith('\uFEFF')?'\uFEFF':'';
      const lines=result.replace(/^\uFEFF/,'').split(/\r?\n/), bounds=ini.sectionBounds(lines,'UpscaleRatio');
      result=bom+lines.filter((line,i)=>!(bounds&&i>bounds.start&&i<bounds.end&&line.match(/^\s*([^;#][^=]*?)\s*=/)?.[1].trim().toLowerCase()===key.toLowerCase())).join(newline);
    }
  }
  return result;
}
function compileFile(text, request) {
  const result=request.backend==='optiscaler' ? compiler.planOptiScalerSr(text,withoutBackend(request)) : compiler.planRtx40Mfg(text,withoutBackend(request));
  if(request.backend==='rtx40'&&Buffer.byteLength(result.content)>4096)fail('SETTINGS_SIZE','生成的配置超过社区后端实际 4096 字节读取上限，保留原文件。');
  return result;
}
module.exports={IDS,FILES,validateRequest,withoutBackend,isRestore,nativeSr,nativeFg,readText,controlPath,validConfigName,values,restoreText,compileFile,same,hash:sha256};
