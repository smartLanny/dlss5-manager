'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {temp}=require('./helpers.cjs');
const {atomicJson}=require('../src/core/safety.cjs');
test('brief metadata replace denial retries the same durable write and commits complete JSON',async t=>{
  const root=await temp(t),file=path.join(root,'state.json');await atomicJson(file,{before:1});
  const rename=fs.rename;let denied=true;
  fs.rename=async(from,to)=>{if(to===file&&denied){denied=false;throw Object.assign(new Error('sharing violation'),{code:'EPERM'});}return rename(from,to);};
  try{await atomicJson(file,{after:2});}finally{fs.rename=rename;}
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{after:2});assert.deepEqual(await fs.readdir(root),['state.json']);
});
test('persistent metadata denial preserves original state and surfaces failure',async t=>{
  const root=await temp(t),file=path.join(root,'state.json');await atomicJson(file,{before:1});const rename=fs.rename;
  fs.rename=async(from,to)=>{if(to===file)throw Object.assign(new Error('blocked'),{code:'EPERM'});return rename(from,to);};
  try{await assert.rejects(atomicJson(file,{after:2}),{code:'EPERM'});}finally{fs.rename=rename;}
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{before:1});assert.deepEqual(await fs.readdir(root),['state.json']);
});
