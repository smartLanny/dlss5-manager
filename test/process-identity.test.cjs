'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {classifyProcesses}=require('../src/core/platform.cjs');
test('same EXE filename elsewhere and Manager within game directory do not fabricate GAME_RUNNING',()=>{
  const r=classifyProcesses([{id:1,name:'nba2k27',path:'D:\\other\\nba2k27.exe'},{id:2,name:'Manager',path:'D:\\po\\Manager.exe'},{id:3,name:'Manager',path:'D:\\po\\Manager.exe'}],'D:\\po','D:\\po\\nba2k27.exe',{pid:2,exe:'D:\\po\\Manager.exe'});
  assert.equal(r.verified,true);assert.deepEqual(r.running,[]);
});
test('actual game path, child executable and root boundaries are respected',()=>{
  const r=classifyProcesses([{id:1,name:'game',path:'d:\\PO\\NBA2K27.exe'},{id:2,name:'child',path:'D:\\po\\bin\\game.exe'},{id:3,name:'other',path:'D:\\poker\\game.exe'}],'D:\\po','D:\\po\\nba2k27.exe');
  assert.equal(r.verified,true);assert.deepEqual(r.running,['game','child']);
});
test('unreadable matching process remains unknown; unrelated protected processes do not block',()=>{
  const r=classifyProcesses([{id:1,name:'nba2k27',path:null},{id:2,name:'System',path:null}],'D:\\po','D:\\po\\nba2k27.exe');
  assert.equal(r.verified,false);assert.deepEqual(r.running,[]);assert.deepEqual(r.unknown,['nba2k27']);
  assert.equal(classifyProcesses([{id:2,name:'System',path:null}],'D:\\po','D:\\po\\nba2k27.exe').verified,true);
});
