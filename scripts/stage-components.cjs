'use strict';
// Publisher-only build helper. Reads explicitly authorized release packages, never another repository.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { leaf, noLinks, digestFile, atomicJson } = require('../src/core/safety.cjs');
const { importPackage } = require('../src/core/packages.cjs');
async function main() {
  const input = process.argv[2]; if (!input) throw new Error('提供已经获准随包分发的组件目录：npm run pack:distribution -- <目录>。不会查找私有仓库或源码。');
  const root = path.resolve(input); await noLinks(root);
  const spec = JSON.parse(await fs.readFile(path.join(root,'distribution.json'),'utf8'));
  if (spec.redistributionApproved !== true || !Array.isArray(spec.packages) || spec.packages.length > 20) throw new Error('需要发行方确认有权分发的 distribution.json。');
  const tmp = await fs.mkdtemp(path.join(os.tmp(),'manager-bundle-')); const result = [];
  try {
    for (const item of spec.packages) {
      const name = leaf(item.file); if (!name.endsWith('.dlss5pkg')) throw new Error('只接收标准组件包。');
      const file = path.join(root,name); const pkg = await importPackage(file,{expectedHash:item.sha256,acceptLocal:true},tmp);
      if (pkg.componentManifest?.license.redistribution === 'not-allowed') throw new Error('组件清单禁止再分发。');
      result.push({ file:name,sha256:await digestFile(file),version:pkg.manifest.version,source:file });
    }
    for (const expected of ['0.3.3.4','0.4.2beta']) if (!result.some(p=>p.version.toLowerCase()===expected)) throw new Error(`完整发行包需要 ${expected}，不能用空入口冒充已内置。`);
    const dest=path.resolve('resources/components');await noLinks(dest);await fs.mkdir(dest,{recursive:true});
    for(const p of result) await fs.copyFile(p.source,path.join(dest,p.file));
    await atomicJson(path.join(dest,'catalog.json'),{schema:1,packages:result.map(({source,...p})=>p)});
    console.log(`已准备 ${result.length} 个授权发行组件。可执行 npm run build:win，源码不包含组件实现。`);
  } finally { await fs.rm(tmp,{recursive:true,force:true}); }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
