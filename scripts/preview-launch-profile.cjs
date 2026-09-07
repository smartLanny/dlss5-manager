#!/usr/bin/env node
'use strict';
// Maintainer-only offline preview: stdin -> stdout. No game paths, no writes,
// no NVAPI calls, no shell execution. Do not wire this to an Apply button.
const { planNvidiaSr, planOptiScalerSr, planRtx40Mfg } = require('../src/core/launch-profile-plan.cjs');
let chunks = [], bytes = 0, rejected = false;
function reject(code, message) {
  if (rejected) return;
  rejected = true; chunks = []; process.exitCode = 1;
  process.stderr.write(`${code}: ${message}\n`);
}
process.stdin.on('data', chunk => {
  bytes += chunk.length;
  if (bytes > 2 * 1024 * 1024) return reject('INPUT_TOO_LARGE', '输入超过 2 MiB');
  if (!rejected) chunks.push(chunk);
});
process.stdin.on('error', () => reject('INPUT_ERROR', '无法读取请求'));
process.stdin.on('end', () => {
  if (rejected) return;
  try {
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('请求必须是对象'), {code:'INVALID_INPUT'});
    const allowed = ['backend', 'request', 'originalText', 'status'];
    if (Object.keys(data).some(k => !allowed.includes(k))) throw Object.assign(new Error('存在未知字段'), {code:'UNKNOWN_FIELD'});
    let result;
    if (data.backend === 'nvapi-sr' && data.originalText === undefined && data.status === undefined) result = planNvidiaSr(data.request);
    else if (data.backend === 'optiscaler-sr' && data.status === undefined) result = planOptiScalerSr(data.originalText, data.request);
    else if (data.backend === 'rtx40-mfg') result = planRtx40Mfg(data.originalText, data.request, data.status);
    else throw Object.assign(new Error('未知后端或不适用字段'), {code:'UNKNOWN_BACKEND'});
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (e) { reject(e.code || 'INVALID_INPUT', e.code ? e.message : '请求解析失败，未输出计划'); }
});
