'use strict';
// A configuration operation inside Engine's existing history, lock and recovery
// system. There is no second journal or independent recovery ordering.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {fail,validId,HASH,inside,noLinks,assertGameRoot,digestFile,durableWrite,atomicJson}=require('./safety.cjs');
const policy=require('./launch-policy.cjs');
const clone=x=>structuredClone(x);
const DRIVER_IDS=[...policy.IDS.sr,...policy.IDS.fg];
const envCheck=env=>{if(!env.verified)fail('PROCESS_UNKNOWN','进程检查失败，无法确认游戏已退出。请求可以保存，但暂不应用。');if(env.running.length)fail('GAME_RUNNING','游戏仍在运行；请求已保留，请退出游戏后应用。');};
function subset(snapshot,ids){return Object.fromEntries(ids.map(id=>[id,snapshot.settings[id]]));}
function defaultRequest(domain,backend){return domain==='sr'?{backend,quality:'game'}:{backend,mode:'restore'};}
class LaunchSettings {
  constructor(engine,dependencies={}){this.engine=engine;engine.launchSettings=this;this.driver=dependencies.driver;this.hardware=dependencies.hardware||require('./platform.cjs').hardware;this.deps=dependencies;}
  nvapi(){return this.driver||(this.driver=require('./nvapi-profile.cjs').createNvapiProfileAdapter());}
  async checkOwnership(g){const last=(await this.engine.history(g.id)).find(j=>j.operation==='launch-settings'&&j.status==='committed');if(!policy.same(g.launchApplied||{},last?.afterLaunch||{}))fail('SETTINGS_OWNERSHIP','启动设置归属与已提交事务不一致，请先到恢复中心处理。');}
  async ensureState(){await this.engine.ensureSettingsState();}
  async save(gameId,domain,request){return this.engine.serialize(async()=>{const g=this.engine.game(gameId);if(!g.exe)fail('EXE_REQUIRED','先选择游戏真正运行的程序。');const r=policy.validateRequest(domain,request);await this.ensureState();const previous=g.launchRequests;g.launchRequests={...(previous||{}),[domain]:{exe:g.exe,request:r,savedAt:new Date().toISOString()}};try{await this.engine.save();}catch(error){g.launchRequests=previous;throw error;}return {saved:true,applied:false,nextLaunch:true};});}
  async inspect(gameId){const g=this.engine.game(gameId),hardware=await this.hardware();return {hardware,requests:g.launchRequests||{},applied:g.launchApplied||{},runtimeVerified:false,note:'保存、配置读回和游戏实际采用分别记录；此处不声明实际渲染尺寸或生成帧数。'};}
  async preview(gameId,domain,request){
    const e=this.engine,g=e.game(gameId);if(!g.exe||!inside(g.scanRoot,g.exe))fail('EXE_REQUIRED','先选择游戏目录中真正运行的程序。');
    const r=policy.validateRequest(domain,request||g.launchRequests?.[domain]?.request),root=await assertGameRoot(path.dirname(g.exe),e.root);
    if((await e.pending(g.id)).length)fail('RECOVERY_FIRST','请先恢复上次未完成的操作。');
    await this.checkOwnership(g);
    if(g.launchRequests?.[domain]?.exe&&g.launchRequests[domain].exe!==g.exe&&!request)fail('SETTINGS_EXE_CHANGED','请求属于另一个 EXE，请重新保存选择。');
    const old=g.launchApplied?.[domain]||null;
    if(old&&old.exe!==g.exe)fail('SETTINGS_EXE_CHANGED','先恢复原 EXE 的配置，再接管新的程序。');
    if(old&&old.backend!==r.backend&&!policy.isRestore(domain,r))fail('SETTINGS_RESTORE_FIRST','先恢复当前设置后端，再切换到另一后端，避免多套覆盖互相竞争。');
    const env=await e.deps.environment(root,g.exe),hardware=await this.hardware(),warnings=[];
    const restoring=policy.isRestore(domain,r),backend=restoring&&old?old.backend:r.backend;
    const p={id:crypto.randomUUID(),kind:'launch-settings',expires:Date.now()+120000,gameId,domain,request:r,backend,root,exe:g.exe,exeHash:await digestFile(g.exe),restoring,old:clone(old),warnings,blockers:[],changes:[],driver:null,hardware,environment:{verified:env.verified,running:env.running},fingerprint:JSON.stringify({exe:g.exe,installed:g.installed||null,applied:g.launchApplied||{}})};
    if(!env.verified)p.blockers.push('无法确认游戏已退出；仍可保存下一次启动请求。');else if(env.running.length)p.blockers.push('游戏正在运行，退出后才能应用。');
    if(!p.exeHash&&!restoring)p.blockers.push('游戏 EXE 已不存在，不能应用新设置。');
    if(!restoring&&p.exeHash){
      let exeInfo;try{exeInfo=await require('./platform.cjs').peInfo(g.exe);}catch{}
      if(!exeInfo?.valid||exeInfo.dll||exeInfo.arch!=='x64'||require('./discovery.cjs').AUXILIARY.test(path.basename(g.exe)))p.blockers.push('游戏 EXE 已改变或是辅助程序，请重新选择真正的 Windows x64 游戏程序。');
    }
    if(restoring&&!old){p.noOp=true;e.plans.set(p.id,p);return this.publicPlan(p);}
    if(backend==='native'||backend==='nvidia'){
      if(backend==='nvidia'&&!restoring&&hardware.family!=='RTX50')p.blockers.push('当前没有确认 RTX 50 硬件；官方 MFG 请求仅保存，暂不写驱动。');
      const before=await this.nvapi().read(g.exe,DRIVER_IDS),after=clone(before);
      const operations=restoring?[]:(backend==='native'?policy.nativeSr(r):policy.nativeFg(r)).operations;
      const ids=restoring?old.ids:[...new Set([...(old?.ids||[]),...operations.map(o=>o.id)])];
      if(old&&!policy.same(subset(before,old.ids),old.lastValues))fail('SETTINGS_EXTERNAL_CHANGE','这些驱动设置已被 NVIDIA App 或其他工具改变；保留现状，请先检查。');
      const baseline=clone(old?.baseline||before);
      for(const id of ids)if(!old?.ids.includes(id))baseline.settings[id]=clone(before.settings[id]);
      if(restoring){for(const id of ids)after.settings[id]=clone(baseline.settings[id]);const other=Object.entries(g.launchApplied||{}).some(([d,v])=>d!==domain&&['native','nvidia'].includes(v.backend));if(!other&&!g.launchDriverOriginalProfile&&!Object.values(after.settings).some(s=>s.kind==='explicit'))after.profile=null;}
      else for(const op of operations)after.settings[op.id]={kind:'explicit',value:op.value,location:0,predefined:false};
      p.driver={before,after,ids,baseline};p.noOp=!restoring&&policy.same(subset(before,ids),subset(after,ids));
      warnings.push('仅写当前 EXE 的驱动设置请求；读回成功也不代表游戏已采用对应分辨率或插帧倍率。');
      if(backend==='nvidia')warnings.push('倍数是总帧倍率请求，实际生成帧数与支持上限需要游戏/驱动运行证据；不据头文件开放 16X。');
    }else{
      const name=old?.name||await policy.controlPath(root,backend),file=path.join(root,name);
      let before=await policy.readText(file,true);
      if(before===null&&!old)fail('SETTINGS_BACKEND_MISSING','没有找到该后端的现有配置。请求已保留；请先安装并初始化对应后端，不会通过创建配置冒充已安装。');
      if(before===null)fail('SETTINGS_EXTERNAL_CHANGE','已接管的配置文件被删除，保留恢复记录。');
      if(backend==='rtx40'&&!restoring&&hardware.family!=='RTX40')p.blockers.push('没有确认 RTX 40 硬件；社区 MFG 请求暂不应用。');
      const currentValues=policy.values(before,backend);
      if(old&&!policy.same(Object.fromEntries(Object.keys(old.lastValues).map(k=>[k,currentValues[k]])),old.lastValues))fail('SETTINGS_EXTERNAL_CHANGE','本工具接管的配置键已被外部修改，请先检查。');
      let content,originalRef=old?.baseline||null;
      if(restoring){const original=await this.backupText(originalRef);content=policy.hash(before)===old.lastHash?original:policy.restoreText(before,original,old.lastValues,backend);}
      else {const result=policy.compileFile(before,r);content=result.content;warnings.push(...result.warnings);}
      const afterValues=policy.values(content,backend),keys=Object.keys(afterValues).filter(k=>!policy.same(currentValues[k],afterValues[k]));
      const ownedKeys=[...new Set([...Object.keys(old?.lastValues||{}),...keys])];
      p.changes=[{name,role:'launch-config',backend,before:policy.hash(before),after:policy.hash(content),content,keys,afterValues:Object.fromEntries(keys.map(k=>[k,afterValues[k]])),allAfterValues:Object.fromEntries(ownedKeys.map(k=>[k,afterValues[k]])),baseline:originalRef}];
      p.noOp=!restoring&&p.changes[0].before===p.changes[0].after;
      if(backend==='rtx40')warnings.push('只管理已经安装的社区 control v11；不会给没有 FG 的游戏注入帧生成，也不声称当前 wrapper 已支持这个倍率。');
    }
    if(env.antiCheat?.length)warnings.push('检测到反作弊服务；这里不绕过游戏策略，也不修改或注入运行中的游戏。');
    e.plans.set(p.id,p);return this.publicPlan(p);
  }
  publicPlan(p){return {id:p.id,kind:p.kind,gameId:p.gameId,domain:p.domain,backend:p.backend,request:p.request,blockers:p.blockers,warnings:p.warnings,noOp:p.noOp,changes:p.changes.map(c=>({name:c.name,before:c.before,after:c.after})),driverSettings:p.driver?.ids||[],phase:'preview',applied:false,runtimeVerified:false};}
  async backupText(ref){if(!ref||!HASH.test(ref.hash||''))fail('BACKUP_INVALID','配置原件记录损坏。');const file=this.engine.backupPath(ref);if(await digestFile(file)!==ref.hash)fail('BACKUP_DAMAGED','配置原件备份损坏，保留现状。');return policy.readText(file);}
  async apply(planId,consent={}){return this.engine.serialize(async()=>{
    const e=this.engine;validId(planId);const p=e.plans.get(planId);e.plans.delete(planId);
    if(!p||p.kind!=='launch-settings'||p.expires<Date.now())fail('PLAN_EXPIRED','配置预览已过期，请重新预览。');
    if(consent.confirm!==true)fail('CONFIRM_REQUIRED','请确认本次配置变更和实际生效边界。');
    if(p.blockers.length)fail('SETTINGS_BLOCKED',p.blockers.join('\n'));
    const g=e.game(p.gameId);if(p.fingerprint!==JSON.stringify({exe:g.exe,installed:g.installed||null,applied:g.launchApplied||{}}))fail('PLAN_CHANGED','游戏或配置记录已改变，请重新预览。');
    await assertGameRoot(p.root,e.root);envCheck(await e.deps.environment(p.root,p.exe));
    if(!p.restoring&&await digestFile(g.exe)!==p.exeHash)fail('EXE_CHANGED','EXE 在预览后改变，请重新选择。');
    if((await e.pending(g.id)).length)fail('RECOVERY_FIRST','请先恢复上次操作。');
    await e.checkOwnership(g,p.root);
    await this.checkOwnership(g);
    await e.deps.locks(p.changes.map(c=>path.join(p.root,c.name)));
    for(const c of p.changes)if(await digestFile(path.join(p.root,c.name))!==c.before)fail('FILE_CHANGED','配置在预览后改变，请重新预览。');
    if(p.driver&&!policy.same(await this.nvapi().read(p.exe,DRIVER_IDS),p.driver.before))fail('SETTINGS_EXTERNAL_CHANGE','驱动配置在预览后改变，未写入。');
    if(p.noOp){await this.ensureState();const previous=g.launchRequests;g.launchRequests={...(previous||{}),[p.domain]:{exe:g.exe,request:p.request,savedAt:new Date().toISOString()}};try{await e.save();}catch(error){g.launchRequests=previous;throw error;}return {unchanged:true,applied:false,runtimeVerified:false};}
    await this.ensureState();
    const id=crypto.randomUUID(),dir=e.txDir(id);await noLinks(dir);await fs.mkdir(dir,{recursive:true});
    const j={schema:2,id,gameId:g.id,root:p.root,exe:p.exe,operation:'launch-settings',domain:p.domain,backend:p.backend,version:null,createdAt:new Date().toISOString(),status:'preparing',beforeInstalled:clone(g.installed||null),afterInstalled:clone(g.installed||null),beforeLaunch:clone(g.launchApplied||{}),beforeRequests:clone(g.launchRequests||{}),afterLaunch:null,changes:p.changes.map(({content,...c})=>c),driver:clone(p.driver),beforeDriverOriginal:g.launchDriverOriginalProfile??null};
    const persist=()=>atomicJson(e.journalPath(id),j);await persist();
    try{
      const {copyDurable}=require('./engine.cjs');
      for(let i=0;i<p.changes.length;i++)await copyDurable(path.join(p.root,p.changes[i].name),e.backupPath({tx:id,index:i}),p.changes[i].before);
      j.status='prepared';await persist();
      for(let i=0;i<p.changes.length;i++)await durableWrite(e.stagePath(j,i),p.changes[i].content,true);
      j.status='applying';await persist();
      for(let i=0;i<p.changes.length;i++){const c=p.changes[i],target=path.join(p.root,c.name);await noLinks(target);if(await digestFile(target)!==c.before)fail('FILE_CHANGED','写入前配置改变。');await fs.rename(e.stagePath(j,i),target);if(await digestFile(target)!==c.after)fail('WRITE_VERIFY_FAILED','配置读回不一致。');if(e.deps.afterWrite)await e.deps.afterWrite(i,j);}
      if(j.driver){j.driver.after=await this.nvapi().write(p.exe,j.driver.before,j.driver.after);await persist();}
      const next=clone(g.launchApplied||{});
      if(p.restoring)delete next[p.domain];
      else if(j.driver){next[p.domain]={exe:p.exe,backend:p.backend,request:p.request,ids:p.driver.ids,baseline:p.driver.baseline,lastValues:subset(j.driver.after,p.driver.ids),phase:'driver-readback',runtimeVerified:false};if(!Object.values(g.launchApplied||{}).some(v=>['native','nvidia'].includes(v.backend)))g.launchDriverOriginalProfile=clone(j.driver.before.profile);}
      else {const c=j.changes[0];next[p.domain]={exe:p.exe,backend:p.backend,request:p.request,name:c.name,baseline:p.old?.baseline||{tx:id,index:0,hash:c.before},lastValues:c.allAfterValues,lastHash:c.after,phase:'file-readback',runtimeVerified:false};}
      j.afterLaunch=next;g.launchApplied=clone(next);g.launchRequests={...(g.launchRequests||{}),[p.domain]:{exe:g.exe,request:p.request,savedAt:new Date().toISOString()}};await e.save();j.status='committed';await persist();return {transactionId:id,applied:true,phase:j.driver?'driver-readback':'file-readback',runtimeVerified:false};
    }catch(error){j.errorCode=error.code||'SETTINGS_FAILED';if(j.status==='preparing'){j.status='aborted';await persist();throw error;}try{await this.restore(j,g,{keepRequest:true});}catch{j.status='recovery-needed';await persist();fail('RECOVERY_NEEDED','配置应用失败且恢复未完成；原件已保存，请到恢复中心处理。');}throw error;}
  });}
  validate(j,g){
    if(j.schema!==2||j.operation!=='launch-settings'||j.gameId!==g.id||typeof j.exe!=='string'||!path.isAbsolute(j.exe)||j.root!==path.dirname(j.exe)||!inside(g.scanRoot,j.exe)||!['sr','fg'].includes(j.domain)||!Array.isArray(j.changes)||j.changes.length>1)fail('JOURNAL_INVALID','启动配置恢复记录无效。');
    validId(j.id);
    if(!(j.domain==='sr'?['native','optiscaler']:['nvidia','rtx40']).includes(j.backend)||(['native','nvidia'].includes(j.backend)?!j.driver||j.changes.length:!!j.driver||j.changes.length!==1))fail('JOURNAL_INVALID','配置后端与恢复类型不匹配。');
    for(const c of j.changes)if(!policy.validConfigName(c.name,j.backend)||!HASH.test(c.before||'')||!HASH.test(c.after||''))fail('JOURNAL_INVALID','配置路径或校验值无效。');
    if(j.driver&&(!Array.isArray(j.driver.ids)||!j.driver.ids.length||new Set(j.driver.ids).size!==j.driver.ids.length||j.driver.ids.some(id=>!policy.IDS[j.domain].includes(id))))fail('JOURNAL_INVALID','驱动配置恢复范围无效。');
  }
  async restore(j,g,{keepRequest=false}={}){
    const e=this.engine;this.validate(j,g);await assertGameRoot(j.root,e.root);envCheck(await e.deps.environment(j.root,j.exe));await e.deps.locks(j.changes.map(c=>path.join(j.root,c.name)));
    const staged=[];
    for(let i=0;i<j.changes.length;i++){
      const c=j.changes[i],target=path.join(j.root,c.name),backup=await this.backupText({tx:j.id,index:i,hash:c.before}),current=await policy.readText(target);
      let text=current;if(policy.hash(current)!==c.before){
        const now=policy.values(current,j.backend),original=policy.values(backup,j.backend);
        const alreadyRestored=Object.keys(c.afterValues).every(k=>policy.same(now[k],original[k]));
        if(policy.hash(current)===c.after)text=backup;else if(!alreadyRestored)text=policy.restoreText(current,backup,c.afterValues,j.backend);
      }
      staged.push({target,text,expected:policy.hash(current)});
    }
    let driverCurrent,driverDesired;
    if(j.driver){driverCurrent=await this.nvapi().read(j.exe,DRIVER_IDS);driverDesired=clone(driverCurrent);const ids=j.driver.ids;
      if(!policy.same(subset(driverCurrent,ids),subset(j.driver.before,ids))&&!policy.same(subset(driverCurrent,ids),subset(j.driver.after,ids)))fail('SETTINGS_EXTERNAL_CHANGE','驱动设置已被外部修改，保留待恢复记录。');
      for(const id of ids)driverDesired.settings[id]=clone(j.driver.before.settings[id]);driverDesired.profile=clone(j.driver.before.profile);
      if(driverDesired.profile===null&&Object.values(driverDesired.settings).some(s=>s.kind==='explicit'))driverDesired.profile=clone(driverCurrent.profile);
    }
    j.status='restoring';await atomicJson(e.journalPath(j.id),j);
    if(j.driver&&!policy.same(driverCurrent,driverDesired))await this.nvapi().write(j.exe,driverCurrent,driverDesired);
    for(let i=staged.length-1;i>=0;i--){const row=staged[i];if(await digestFile(row.target)!==row.expected)fail('FILE_CHANGED','恢复过程中配置变化。');const temp=e.stagePath(j,i,true),existing=await digestFile(temp),wanted=policy.hash(row.text);if(existing&&existing!==wanted)fail('STAGE_CHANGED','恢复临时文件已改变，保留待恢复记录。');if(!existing)await durableWrite(temp,row.text,true);await noLinks(row.target);if(await digestFile(row.target)!==row.expected)fail('FILE_CHANGED','恢复写入前配置变化。');await fs.rename(temp,row.target);if(await digestFile(row.target)!==wanted)fail('WRITE_VERIFY_FAILED','恢复读回失败。');}
    g.launchApplied=clone(j.beforeLaunch||{});g.launchDriverOriginalProfile=clone(j.beforeDriverOriginal);
    g.launchRequests=keepRequest?clone(j.beforeRequests||{}):{...(g.launchRequests||{}),[j.domain]:{exe:j.exe,request:clone(g.launchApplied[j.domain]?.request||defaultRequest(j.domain,j.backend)),savedAt:new Date().toISOString()}};
    await e.save();j.status='reverted';j.restoredAt=new Date().toISOString();await atomicJson(e.journalPath(j.id),j);
    for(let i=0;i<j.changes.length;i++){const stage=e.stagePath(j,i);const h=await digestFile(stage);if(h&&h===j.changes[i].after)await fs.unlink(stage);}
  }
  async beforeLaunch(gameId){
    const g=this.engine.game(gameId),outcomes=[];
    for(const [domain,row] of Object.entries(g.launchRequests||{})){
      if(row.exe!==g.exe){outcomes.push({domain,applied:false,reason:'EXE 已改变，请重新保存请求。'});continue;}
      try{const p=await this.preview(gameId,domain,row.request);const result=await this.apply(p.id,{confirm:true});outcomes.push({domain,...result});}
      catch(error){outcomes.push({domain,applied:false,code:error.code,reason:error.message});}
    }
    return outcomes;
  }
}
module.exports={LaunchSettings};
