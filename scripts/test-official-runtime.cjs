'use strict';
const fs=require('node:fs/promises');const path=require('node:path');const assert=require('node:assert/strict');
const {ensureReShade,PIN}=require('../src/core/reshade.cjs');const {digestFile}=require('../src/core/safety.cjs');
async function main(){
 const root=path.resolve('test-results/official-runtime');await fs.mkdir(root,{recursive:true});
 const result=await ensureReShade(root);assert.equal(await digestFile(result.source),PIN.dll.sha256);
 const reused=await ensureReShade(root,()=>{},{download:async()=>{throw new Error('Cached environment must not need another download.');}});
 assert.equal(reused.source,result.source);
 console.log('Official ReShade 6.8 full Add-on: HTTPS pinned executable verified, ZIP extraction and x64/full-addon payload verified, offline cache reuse passed. No binary is published.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
