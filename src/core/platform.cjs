'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { noLinks, fail } = require('./safety.cjs');
const AC = /easyanticheat|easyanticheat_eos|battleye|beservice|bedaisy|xigncode|xhunter|x3\.xem|xcorona|ace[-_ ]?(?:base|guard|service|driver|launcher)|anti.?cheat.?expert|anticheatexpert|tencentprotect|tensafe|vgc|vgk|vanguard|nprotect|gameguard|fairfight/i;
const PROXIES = new Set(['dxgi.dll', 'd3d12.dll', 'd3d11.dll', 'd3d9.dll', 'dinput8.dll', 'winmm.dll', 'version.dll', 'opengl32.dll', 'vulkan-1.dll']);
const APIS = ['DX11', 'DX12', 'Vulkan', 'OpenGL'];
async function peInfo(file) {
  await noLinks(file);
  const h = await fs.open(file, 'r');
  try {
    const size = (await h.stat()).size;
    const read = async (offset, count) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + count > size) throw new Error('Invalid PE bounds');
      const b = Buffer.alloc(count); const { bytesRead } = await h.read(b, 0, count, offset);
      if (bytesRead !== count) throw new Error('Truncated PE'); return b;
    };
    const dos = await read(0, 64);
    if (dos.toString('ascii', 0, 2) !== 'MZ') throw new Error('Not PE');
    const offset = dos.readUInt32LE(60);
    if (offset > 1024 * 1024) throw new Error('PE header too far');
    const head = await read(offset, 24);
    if (head.readUInt32LE(0) !== 0x4550) throw new Error('Not PE');
    const machine = head.readUInt16LE(4), count = head.readUInt16LE(6), optSize = head.readUInt16LE(20);
    if (count < 1 || count > 96 || optSize < 112 || optSize > 4096) throw new Error('Invalid sections');
    const opt = await read(offset + 24, optSize);
    const is64 = opt.readUInt16LE(0) === 0x20b;
    if (!is64 && opt.readUInt16LE(0) !== 0x10b) throw new Error('Invalid PE format');
    const sections = await read(offset + 24 + optSize, count * 40);
    const rvaOffset = rva => {
      for (let i = 0; i < count; i++) {
        const base = i * 40, va = sections.readUInt32LE(base + 12), rawSize = sections.readUInt32LE(base + 16), raw = sections.readUInt32LE(base + 20);
        if (rva >= va && rva - va < rawSize) return raw + rva - va;
      }
      throw new Error('Invalid RVA');
    };
    const imports = [];
    const dir = is64 ? 112 : 96;
    const parseDirectory = async (entry, stride, nameOffset, delayed) => {
      if (opt.length < dir + entry * 8 + 8) return;
      const rva = opt.readUInt32LE(dir + entry * 8), len = opt.readUInt32LE(dir + entry * 8 + 4);
      if (!rva || !len) return;
      const start = rvaOffset(rva);
      for (let i = 0; i < Math.min(Math.floor(len / stride), 512); i++) {
        const desc = await read(start + i * stride, stride);
        const nameRva = desc.readUInt32LE(nameOffset);
        if (!nameRva) break;
        if (delayed && !(desc.readUInt32LE(0) & 1)) continue;
        const p = rvaOffset(nameRva); const b = await read(p, Math.min(256, size - p));
        const end = b.indexOf(0); if (end < 1) throw new Error('Invalid import');
        imports.push(b.toString('ascii', 0, end).toLowerCase());
      }
    };
    await parseDirectory(1, 20, 12, false);
    await parseDirectory(13, 32, 4, true);
    const apis = [];
    if (imports.includes('d3d11.dll')) apis.push('DX11');
    if (imports.includes('d3d12.dll')) apis.push('DX12');
    if (imports.includes('vulkan-1.dll')) apis.push('Vulkan');
    if (imports.includes('opengl32.dll')) apis.push('OpenGL');
    return { valid: true, arch: machine === 0x8664 ? 'x64' : machine === 0x14c ? 'x86' : machine === 0xaa64 ? 'ARM64' : '未知', dll: !!(head.readUInt16LE(22) & 0x2000), imports: [...new Set(imports)], apis };
  } catch { return { valid: false, arch: '未知', dll: false, imports: [], apis: [] }; }
  finally { await h.close(); }
}
async function powershell(script, input = {}) {
  if (process.platform !== 'win32') return null;
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const bootstrap = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $q=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DLSS5_REQUEST)))|ConvertFrom-Json; ";
  const command = Buffer.from(bootstrap + script, 'utf16le').toString('base64');
  const { stdout } = await exec(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
    timeout: 25000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, DLSS5_REQUEST: Buffer.from(JSON.stringify(input), 'utf8').toString('base64') }
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || 'null');
}
async function environment(root, exe, diagnostic) {
  if (process.platform !== 'win32') return { verified: false, running: [], antiCheat: [], reason: '仅 Windows 版本支持实际安装。' };
  try {
    const value = await powershell(`
      $gameProcesses=@(); $ac=@();
      foreach($p in @(Get-Process -ErrorAction Stop)) {
        if($p.ProcessName -match $q.ac){$ac+=$p.ProcessName}
        $pp=$null; try{$pp=$p.Path}catch{}
        if($p.ProcessName -eq $q.stem -or ($pp -and $pp.StartsWith($q.prefix,[StringComparison]::OrdinalIgnoreCase))){$gameProcesses+=$p.ProcessName}
      }
      foreach($s in @(Get-Service -ErrorAction Stop)){if(($s.Name+' '+$s.DisplayName) -match $q.ac -and $s.Status -eq 'Running'){$ac+=$s.Name}}
      @{verified=$true;running=@($gameProcesses|Select-Object -Unique);antiCheat=@($ac|Select-Object -Unique)}|ConvertTo-Json -Compress
    `, { stem: path.basename(exe, path.extname(exe)), prefix: root + path.sep, ac: AC.source });
    return value;
  } catch (e) {
    // Optional test-only observation of a failed native probe; never exposed to renderer IPC.
    if (typeof diagnostic === 'function') diagnostic(e);
    return { verified: false, running: [], antiCheat: [], reason: '进程或服务检查失败，不能确认游戏已退出。' };
  }
}
async function metadata(files) {
  if (!files.length || process.platform !== 'win32') return {};
  try {
    const values = await powershell(`
      $result=@(); foreach($f in $q.files){
        $i=Get-Item -LiteralPath $f; $s=Get-AuthenticodeSignature -LiteralPath $f;
        $result+=@{path=$f;description=$i.VersionInfo.FileDescription;product=$i.VersionInfo.ProductName;version=$i.VersionInfo.FileVersion;signature=[string]$s.Status;signer=if($s.SignerCertificate){$s.SignerCertificate.Subject}else{''}}
      }; ConvertTo-Json -InputObject @($result) -Compress -Depth 4
    `, { files });
    return Object.fromEntries((Array.isArray(values) ? values : [values]).filter(Boolean).map(x => [x.path, x]));
  } catch { return {}; }
}
async function checkLocks(files) {
  if (process.platform !== 'win32') fail('WINDOWS_REQUIRED', '实际文件安装仅在 Windows 上开放。');
  try {
    const value = await powershell(`
      $handles=@(); try { foreach($f in $q.files){ if(Test-Path -LiteralPath $f){$handles+=[IO.File]::Open($f,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)} }; @{ok=$true}|ConvertTo-Json -Compress } finally {foreach($h in $handles){$h.Dispose()}}
    `, { files });
    if (!value?.ok) throw new Error('locked');
  } catch { fail('FILES_LOCKED', '文件被占用或无写入权限。请退出游戏、启动器和覆盖层后重试。'); }
}
async function steamRoots() {
  const roots = [];
  if (process.platform === 'win32') {
    try {
      const result = await powershell("$r=@(); foreach($p in @('HKCU:\\Software\\Valve\\Steam','HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam')){if(Test-Path $p){$i=Get-ItemProperty $p; if($i.SteamPath){$r+=$i.SteamPath}; if($i.InstallPath){$r+=$i.InstallPath}}}; ConvertTo-Json -InputObject @($r) -Compress");
      roots.push(...(Array.isArray(result) ? result : []));
    } catch { /* Conventional locations remain useful; result is not a safety verdict. */ }
    if (process.env['ProgramFiles(x86)']) roots.push(path.join(process.env['ProgramFiles(x86)'], 'Steam'));
  }
  return [...new Set(roots.map(x => path.resolve(x)))];
}
module.exports = { AC, PROXIES, APIS, peInfo, environment, metadata, checkLocks, steamRoots };
