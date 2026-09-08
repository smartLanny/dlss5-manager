'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');

const ALLOWED_IDS = Object.freeze([
  0x10AFB768, 0x10E41E01, 0x10E41DF3, 0x10E41DF5,
  0x10308298, 0x104D6667, 0x10562D0F, 0x10CF4125
]);
const ALLOWED = new Set(ALLOWED_IDS);

function fail(code, message, cause) {
  const error = Object.assign(new Error(message), { code });
  if (cause) error.cause = cause;
  throw error;
}

function exePath(value) {
  if (typeof value !== 'string' || value.includes('\0') || !/^[a-z]:\\/i.test(value) ||
      value.startsWith('\\\\') || value.startsWith('\\\\?\\') || path.win32.extname(value).toLowerCase() !== '.exe')
    fail('INVALID_EXE', 'EXE 必须是本机驱动器上的完整 .exe 路径。');
  const normalized = path.win32.normalize(value);
  return normalized[0].toUpperCase() + normalized.slice(1);
}

function ids(value) {
  if (!Array.isArray(value) || value.length === 0) fail('INVALID_IDS', '至少需要一个受支持的 NVAPI 设置 ID。');
  const result = [];
  for (const id of value) {
    if (!Number.isInteger(id) || !ALLOWED.has(id)) fail('UNSUPPORTED_SETTING', `不支持的 NVAPI 设置 ID：${id}`);
    if (!result.includes(id)) result.push(id);
  }
  return result.sort((a, b) => a - b);
}

function plain(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    fail('INVALID_SNAPSHOT', `${name} 必须是普通对象。`);
  return value;
}

function profile(value) {
  if (value === null) return null;
  plain(value, 'profile');
  const expected = ['name', 'appName', 'exclusive', 'owned'];
  if (Object.keys(value).some(k => !expected.includes(k)) || typeof value.name !== 'string' ||
      typeof value.appName !== 'string' || typeof value.exclusive !== 'boolean' || typeof value.owned !== 'boolean')
    fail('INVALID_SNAPSHOT', 'profile 字段无效。');
  return { name: value.name, appName: value.appName, exclusive: value.exclusive, owned: value.owned };
}

function setting(value, name) {
  plain(value, name);
  const expected = ['kind', 'value', 'location', 'predefined'];
  if (Object.keys(value).some(k => !expected.includes(k)) || !['explicit', 'inherited', 'absent'].includes(value.kind))
    fail('INVALID_SNAPSHOT', `${name} 的状态无效。`);
  const absent = value.kind === 'absent';
  if ((!absent && (!Number.isInteger(value.value) || value.value < 0 || value.value > 0xffffffff)) ||
      (absent && value.value !== null) || (absent && value.location !== null) ||
      (absent && value.predefined !== null) ||
      (!absent && (!Number.isInteger(value.location) || value.location < 0 || value.location > 3)) ||
      (!absent && typeof value.predefined !== 'boolean') ||
      (value.kind === 'explicit' && (value.location !== 0 || value.predefined !== false)))
    fail('INVALID_SNAPSHOT', `${name} 的值或来源无效。`);
  return { kind: value.kind, value: value.value, location: value.location, predefined: value.predefined };
}

function snapshot(value, expectedIds) {
  plain(value, 'snapshot');
  if (Object.keys(value).some(k => !['profile', 'settings'].includes(k))) fail('INVALID_SNAPSHOT', 'snapshot 存在未知字段。');
  const source = plain(value.settings, 'settings');
  const keys = Object.keys(source).sort((a, b) => Number(a) - Number(b));
  const wanted = expectedIds.map(String).sort((a, b) => Number(a) - Number(b));
  if (keys.length !== wanted.length || keys.some((key, i) => key !== wanted[i]))
    fail('INVALID_SNAPSHOT', 'snapshot 必须完整覆盖同一组受支持设置。');
  const settings = {};
  for (const id of expectedIds) settings[id] = setting(source[id], `settings[${id}]`);
  return { profile: profile(value.profile), settings };
}

function errorFrom(result, fallback) {
  const code = typeof result?.code === 'string' ? result.code : fallback;
  const message = typeof result?.error === 'string' && result.error ? result.error : 'NVAPI profile 操作失败。';
  fail(code, message);
}

async function nativeRunner(request) {
  if (process.platform !== 'win32') fail('WINDOWS_REQUIRED', 'NVAPI profile 仅支持 Windows。');
  const root = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(__dirname, '..', 'native', 'nvapi-profile.ps1');
  try {
    const source = await fs.readFile(script, 'utf8');
    const { stdout } = await new Promise((resolve, reject) => {
      const command = '$source=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($source))';
      const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PSModulePath: process.env.PSModulePath || '',
          DLSS5_NVAPI_REQUEST: Buffer.from(JSON.stringify(request), 'utf8').toString('base64') }
      });
      const output = [], errors = []; let outputBytes = 0, errorBytes = 0, settled = false;
      const timer = setTimeout(() => { child.kill(); }, 30000);
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      child.once('error', cause => finish(cause));
      child.stdout.on('data', chunk => { outputBytes += chunk.length; if (outputBytes > 4 * 1024 * 1024) child.kill(); else output.push(chunk); });
      child.stderr.on('data', chunk => { errorBytes += chunk.length; if (errorBytes > 1024 * 1024) child.kill(); else errors.push(chunk); });
      child.once('close', (code, signal) => {
        const stdout = Buffer.concat(output).toString('utf8'), stderr = Buffer.concat(errors).toString('utf8');
        if (code === 0) finish(null, { stdout });
        else finish(Object.assign(new Error('NVAPI helper process failed.'), {
          code: signal || code, killed: signal !== null, stdout, stderr
        }));
      });
      child.stdin.on('error', cause => finish(cause));
      child.stdin.end(source, 'utf8');
    });
    let result;
    try { result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()); }
    catch (cause) { fail('NVAPI_INVALID_RESPONSE', 'NVAPI helper 未返回有效 JSON。', cause); }
    return result;
  } catch (cause) {
    if (cause?.code && String(cause.code).startsWith('NVAPI_')) throw cause;
    const stdout = typeof cause?.stdout === 'string' ? cause.stdout.replace(/^\uFEFF/, '').trim() : '';
    if (stdout) {
      try { const result = JSON.parse(stdout); errorFrom(result, 'NVAPI_HELPER_FAILED'); } catch (parsed) {
        if (parsed?.code && parsed.code !== 'NVAPI_HELPER_FAILED') throw parsed;
      }
    }
    fail(cause?.killed ? 'NVAPI_TIMEOUT' : 'NVAPI_HELPER_FAILED', 'NVAPI helper 无法完成操作。', cause);
  }
}

function createNvapiProfileAdapter({ runner = nativeRunner } = {}) {
  if (typeof runner !== 'function') fail('INVALID_RUNNER', 'runner 必须是函数。');
  async function read(exe, requestedIds) {
    const normalizedExe = exePath(exe), normalizedIds = ids(requestedIds);
    const result = await runner({ op: 'read', exe: normalizedExe, ids: normalizedIds });
    if (!result?.ok) errorFrom(result, 'NVAPI_READ_FAILED');
    return snapshot(result.snapshot, normalizedIds);
  }
  async function write(exe, expectedSnapshot, desiredSnapshot) {
    const normalizedExe = exePath(exe);
    const settingIds = ids(Object.keys(plain(expectedSnapshot?.settings, 'expectedSnapshot.settings')).map(Number));
    const expected = snapshot(expectedSnapshot, settingIds);
    const desired = snapshot(desiredSnapshot, settingIds);
    const result = await runner({ op: 'write', exe: normalizedExe, ids: settingIds,
      expectedSnapshot: expected, desiredSnapshot: desired });
    if (!result?.ok) errorFrom(result, 'NVAPI_WRITE_FAILED');
    return snapshot(result.snapshot, settingIds);
  }
  return Object.freeze({ read, write });
}

module.exports = { ALLOWED_IDS, createNvapiProfileAdapter };
