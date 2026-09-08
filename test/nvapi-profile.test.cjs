'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ALLOWED_IDS, createNvapiProfileAdapter } = require('../src/core/nvapi-profile.cjs');

const EXE = 'C:\\Games\\Example\\game.exe';
const SR_OVERRIDE = 0x10E41E01;
const SR_RATIO = 0x10E41DF5;
const absent = () => ({ kind: 'absent', value: null, location: null, predefined: null });
const explicit = value => ({ kind: 'explicit', value, location: 0, predefined: false });
const inherited = value => ({ kind: 'inherited', value, location: 1, predefined: true });
const settings = (...pairs) => Object.fromEntries(pairs.map(([id, value]) => [id, value]));

test('read uses a normalized full path and returns explicit, inherited, and absent states intact', async () => {
  let request;
  const adapter = createNvapiProfileAdapter({ runner: async value => {
    request = value;
    return { ok: true, snapshot: {
      profile: { name: 'Game profile', appName: EXE, exclusive: true, owned: false },
      settings: settings([SR_OVERRIDE, explicit(1)], [SR_RATIO, inherited(0)])
    } };
  } });
  const result = await adapter.read('c:\\Games\\Example\\folder\\..\\game.exe', [SR_RATIO, SR_OVERRIDE, SR_RATIO]);
  assert.equal(request.exe, EXE);
  assert.deepEqual(request.ids, [SR_RATIO, SR_OVERRIDE].sort((a, b) => a - b));
  assert.equal(result.settings[SR_OVERRIDE].kind, 'explicit');
  assert.deepEqual(result.settings[SR_RATIO], inherited(0));
});

test('the public adapter rejects relative, network, and arbitrary driver-key requests before the runner', async () => {
  let calls = 0;
  const adapter = createNvapiProfileAdapter({ runner: async () => { calls++; } });
  for (const exe of ['game.exe', '\\\\server\\game.exe', '\\\\?\\C:\\game.exe'])
    await assert.rejects(adapter.read(exe, [SR_OVERRIDE]), e => e.code === 'INVALID_EXE');
  await assert.rejects(adapter.read(EXE, [0x12345678]), e => e.code === 'UNSUPPORTED_SETTING');
  assert.equal(calls, 0);
  assert.deepEqual(new Set(ALLOWED_IDS), new Set([
    0x10AFB768, 0x10E41E01, 0x10E41DF3, 0x10E41DF5,
    0x10308298, 0x104D6667, 0x10562D0F, 0x10CF4125
  ]));
});

test('write sends complete before/after snapshots and returns only validated readback', async () => {
  const profile = { name: 'Game profile', appName: EXE, exclusive: true, owned: false };
  const before = { profile, settings: settings([SR_OVERRIDE, inherited(0)], [SR_RATIO, absent()]) };
  const desired = { profile, settings: settings([SR_OVERRIDE, explicit(1)], [SR_RATIO, explicit(75)]) };
  let request;
  const adapter = createNvapiProfileAdapter({ runner: async value => {
    request = value;
    return { ok: true, snapshot: desired };
  } });
  assert.deepEqual(await adapter.write(EXE, before, desired), desired);
  assert.equal(request.op, 'write');
  assert.deepEqual(request.expectedSnapshot.settings[SR_OVERRIDE], inherited(0));
  assert.deepEqual(request.desiredSnapshot.settings[SR_RATIO], explicit(75));
});

test('zero is not confused with absent and inherited restore remains a delete intent', async () => {
  const profile = { name: 'Owned', appName: EXE, exclusive: true, owned: true };
  const expected = { profile, settings: settings([SR_OVERRIDE, explicit(0)]) };
  const desired = { profile, settings: settings([SR_OVERRIDE, inherited(0)]) };
  let sent;
  const adapter = createNvapiProfileAdapter({ runner: async value => {
    sent = value; return { ok: true, snapshot: desired };
  } });
  await adapter.write(EXE, expected, desired);
  assert.equal(sent.expectedSnapshot.settings[SR_OVERRIDE].kind, 'explicit');
  assert.equal(sent.expectedSnapshot.settings[SR_OVERRIDE].value, 0);
  assert.equal(sent.desiredSnapshot.settings[SR_OVERRIDE].kind, 'inherited');
});

test('a missing application profile can still report a global inherited zero', async () => {
  const inheritedOnly = { profile: null, settings: settings([SR_OVERRIDE, inherited(0)]) };
  const adapter = createNvapiProfileAdapter({ runner: async () => ({ ok: true, snapshot: inheritedOnly }) });
  assert.deepEqual(await adapter.read(EXE, [SR_OVERRIDE]), inheritedOnly);
});

test('restore returns the actual new inherited value and a retained owned profile', async () => {
  const profile = { name: 'Owned', appName: EXE, exclusive: true, owned: true };
  const expected = { profile, settings: settings([SR_OVERRIDE, explicit(1)]) };
  const desired = { profile: null, settings: settings([SR_OVERRIDE, inherited(10)]) };
  const actual = { profile, settings: settings([SR_OVERRIDE, inherited(20)]) };
  const adapter = createNvapiProfileAdapter({ runner: async request => {
    assert.deepEqual(request.expectedSnapshot, expected);
    assert.deepEqual(request.desiredSnapshot, desired);
    return { ok: true, snapshot: actual };
  } });
  assert.deepEqual(await adapter.write(EXE, expected, desired), actual);
});

test('native errors and malformed success responses can never become successful writes', async () => {
  const one = { profile: null, settings: settings([SR_OVERRIDE, absent()]) };
  const unavailable = createNvapiProfileAdapter({ runner: async () => ({ ok: false, code: 'NVAPI_UNAVAILABLE', error: 'no driver' }) });
  await assert.rejects(unavailable.read(EXE, [SR_OVERRIDE]), e => e.code === 'NVAPI_UNAVAILABLE' && /driver/.test(e.message));
  const conflict = createNvapiProfileAdapter({ runner: async () => ({ ok: false, code: 'NVAPI_CAS_MISMATCH', error: 'changed' }) });
  await assert.rejects(conflict.write(EXE, one, one), e => e.code === 'NVAPI_CAS_MISMATCH');
  const fake = createNvapiProfileAdapter({ runner: async () => ({ ok: true, snapshot: { profile: null, settings: {} } }) });
  await assert.rejects(fake.write(EXE, one, one), e => e.code === 'INVALID_SNAPSHOT');
});

test('PowerShell bridge validates restore predicates and pinned layouts without loading a profile', { skip: process.platform !== 'win32' }, () => {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(__dirname, '..', 'src', 'native', 'nvapi-profile.ps1');
  const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Action', 'selftest'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const result = JSON.parse(output.replace(/^\uFEFF/, '').trim());
  assert.equal(result.ok, true);
  assert.match(result.layout, /NVDRS_SETTING=12320;NVDRS_PROFILE=4116;NVDRS_APPLICATION_V4=20492/);
});
