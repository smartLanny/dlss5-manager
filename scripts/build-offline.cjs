'use strict';
// Publisher-only command. It consumes an explicitly supplied payload directory.
// It never searches for, copies, or builds NR private source code.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { writeZip, validateManifest, importPackage, guessVersion, peBytes } = require('../src/core/packages.cjs');
const { leaf, noLinks, sha256, atomicJson, durableWrite } = require('../src/core/safety.cjs');
const { RUNTIME_PROFILES } = require('../src/core/runtime.cjs');

const REQUIRED = ['0.2.0-beta.2', '0.3.3.4', '0.4.1r2', '0.4.3r3'];
const PROFILE_KEYS = Object.keys(RUNTIME_PROFILES);
const normalizeVersion = value => String(value || '').toLowerCase().replace(/-r(?=\d)/g, 'r').replace(/^v/, '');
const languageOf = name => /\.en(?:[-.]|$)/i.test(name) || /english/i.test(name) ? 'en' : 'zh-CN';
const channelOf = version => normalizeVersion(version) === '0.3.3.4' ? 'stable' : 'beta';

function argv() {
  const a = process.argv.slice(2), out = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--components') out.components = a[++i];
    else if (a[i] === '--no-build') out.noBuild = true;
    else throw new Error('仅支持：npm run build:offline -- --components "D:\\DLSS5-Full-Payload"');
  }
  if (!out.components) throw new Error('请提供已经获准分发的本地组件目录。不会查找私有仓库或源码。');
  return out;
}
async function filesUnder(root) {
  const result = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file); else if (entry.isFile()) result.push(file);
    }
  }
  await visit(root); return result;
}
async function specFiles(root) {
  try {
    const spec = JSON.parse(await fs.readFile(path.join(root, 'distribution.json'), 'utf8'));
    if (spec.redistributionApproved !== true) throw new Error('distribution.json 必须明确 redistributionApproved: true。');
    return spec;
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('离线构建必须提供 distribution.json，并明确核对第三方组件再分发许可。');
    throw e;
  }
}
async function readEntry(root, item, suffixes) {
  const given = item?.file || item?.path;
  if (!given) return null;
  const file = path.resolve(root, given);
  if (!file.startsWith(root + path.sep) && file !== root) throw new Error('组件路径必须位于 --components 目录内。');
  await noLinks(file); const st = await fs.stat(file);
  if (!st.isFile()) throw new Error('组件输入不是普通文件。');
  if (!suffixes.some(x => file.toLowerCase().endsWith(x))) throw new Error(`不支持的组件输入：${leaf(file)}`);
  return file;
}
async function makePackage(root, item, bridge) {
  const addon = await readEntry(root, item, ['.addon64']);
  if (!addon) return null;
  const bytes = await fs.readFile(addon), version = item.version || guessVersion(path.basename(addon));
  if (!version) throw new Error(`无法从 ${leaf(addon)} 识别版本，请在 distribution.json 写明 version。`);
  if (!peBytes(bytes)) throw new Error(`${leaf(addon)} 不是 Windows x64 addon。`);
  if (!item.sha256) throw new Error(`${leaf(addon)} 缺少发布者 SHA-256，不能进入离线发行包。`);
  if (sha256(bytes) !== item.sha256.toLowerCase()) throw new Error(`${leaf(addon)} 校验失败。`);
  if (!bridge) throw new Error(`${leaf(addon)} 缺少已核验的 nrchain_nvngx.dll。`);
  const entries = [[leaf(addon), bytes]], files = [{ path: leaf(addon), role: 'addon', sha256: sha256(bytes), size: bytes.length }];
  if (bridge) {
    const b = await fs.readFile(bridge.file), name = 'nrchain_nvngx.dll';
    if (!bridge.sha256) throw new Error('nrchain_nvngx.dll 缺少发布者 SHA-256，不能进入离线发行包。');
    if (sha256(b) !== bridge.sha256.toLowerCase()) throw new Error('nrchain_nvngx.dll 校验失败。');
    if (!peBytes(b)) throw new Error('bridge 不是 Windows x64 文件。');
    entries.push([name, b]); files.push({ path: name, role: 'bridge', sha256: sha256(b), size: b.length });
  }
  const config = item.config ? await readEntry(root, { file: item.config }, ['.ini']) : null;
  if (config && path.basename(config).toLowerCase() !== 'nr_before_sr.ini') throw new Error('NR 配置文件必须命名为 nr_before_sr.ini。');
  if (config) {
    const c = await fs.readFile(config); if (c.length > 64 * 1024) throw new Error('nr_before_sr.ini 超过 64 KiB。');
    if (!item.configSha256 || sha256(c) !== item.configSha256.toLowerCase()) throw new Error('nr_before_sr.ini 缺少或未通过发布者 SHA-256。');
    entries.push(['nr_before_sr.ini', c]); files.push({ path: 'nr_before_sr.ini', role: 'nr-config', sha256: sha256(c), size: c.length });
  }
  const manifest = validateManifest({ schema: 1, component: 'nr-before-sr', version, architecture: 'x64', apis: ['DX12'], files });
  const outputName = `dlss5-nr-before-sr-${normalizeVersion(version)}-${languageOf(path.basename(addon))}.dlss5pkg`;
  return { bytes: writeZip([['manifest.json', Buffer.from(JSON.stringify({ manifest }, null, 2))], ...entries]), version: manifest.version, language: item.language || languageOf(path.basename(addon)), channel: item.channel || channelOf(manifest.version), displayName: item.displayName || `装机宅 ${manifest.version}`, source: addon, file: outputName };
}
async function collectPackages(root, spec, tmp) {
  const explicit = Array.isArray(spec.packages) ? spec.packages : [];
  const all = await filesUnder(root);
  const items = explicit.length ? explicit : all.filter(x => /\.addon64$/i.test(x)).map(file => ({ file: path.relative(root, file) }));
  const bridgeItem = spec.bridge || all.find(x => path.basename(x).toLowerCase() === 'nrchain_nvngx.dll');
  const bridgeSpec = typeof bridgeItem === 'string' ? { file: bridgeItem } : bridgeItem;
  const bridge = bridgeSpec ? { file: await readEntry(root, bridgeSpec, ['.dll']), sha256: bridgeSpec.sha256 } : null;
  const out = [];
  for (const item of items) {
    const file = await readEntry(root, typeof item === 'string' ? { file: item } : item, ['.addon64', '.dlss5pkg']);
    if (path.extname(file).toLowerCase() === '.dlss5pkg') {
      const expectedHash = typeof item === 'object' ? item.sha256 : undefined;
      if (!expectedHash) throw new Error(`${leaf(file)} 缺少发布者 SHA-256，不能进入离线发行包。`);
      const pkg = await importPackage(file, { expectedHash, acceptLocal: true }, tmp);
      out.push({ file: path.basename(file), version: pkg.manifest.version, language: item.language || languageOf(file), channel: item.channel || channelOf(pkg.manifest.version), displayName: item.displayName || `装机宅 ${pkg.manifest.version}`, bytes: await fs.readFile(file), source: file });
    } else {
      const pkg = await makePackage(root, typeof item === 'string' ? { file: item } : item, bridge);
      out.push(pkg);
    }
  }
  const have = new Set(out.map(x => normalizeVersion(x.version)));
  for (const need of REQUIRED) if (!have.has(need)) throw new Error(`完整发行包缺少 ${need} 的真实成品，不能用空入口或其他版本冒充。`);
  return out;
}
async function collectRuntimes(root, spec, dir) {
  const configured = new Map();
  for (const item of Array.isArray(spec.runtimes) ? spec.runtimes : []) configured.set(item.profile || item.id, item);
  const all = await filesUnder(root);
  for (const key of PROFILE_KEYS) if (!configured.has(key)) {
    const hit = all.find(x => path.basename(x).toLowerCase() === 'nvngx_dlssnr.dll' && new RegExp(key.replace('-', '[ -]?'), 'i').test(x));
    if (hit) configured.set(key, { file: path.relative(root, hit), profile: key });
  }
  const result = {};
  for (const key of PROFILE_KEYS) {
    const item = configured.get(key); if (!item) continue;
    const file = await readEntry(root, item, ['.dll']); const bytes = await fs.readFile(file);
    if (!peBytes(bytes)) throw new Error(`${key} runtime 不是 Windows x64 DLL。`);
    if (path.basename(file).toLowerCase() !== 'nvngx_dlssnr.dll') throw new Error(`${key} runtime 必须命名为 nvngx_dlssnr.dll。`);
    if (item.sha256 && sha256(bytes) !== item.sha256.toLowerCase()) throw new Error(`${key} runtime 校验失败。`);
    if (!item.sha256) throw new Error(`${key} runtime 缺少发布者 SHA-256，不能进入离线发行包。`);
    const bundleFile = `runtime-${key}.dll`; await fs.writeFile(path.join(dir, bundleFile), bytes);
    result[key] = { ...RUNTIME_PROFILES[key], bundleFile, bundleSha256: sha256(bytes), mode: 'bundled' };
  }
  return result;
}
async function main() {
  const options = argv(), root = path.resolve(options.components); await noLinks(root);
  const spec = await specFiles(root), stage = await fs.mkdtemp(path.join(os.tmpdir(), 'dlss5-offline-')), packageDir = path.join(stage, 'components'); await fs.mkdir(packageDir);
  try {
    const packages = await collectPackages(root, spec, stage), runtimes = await collectRuntimes(root, spec, packageDir);
    const catalog = { schema: 2, product: 'zhuangjizhai-dlss5-manager', packageMode: 'offline-full', packages: [], runtimeProfiles: runtimes, reshade: { mode: 'online', version: require('../config/reshade.json').version, note: '官方 Add-on 安装包仅作为数据读取，下载、整体校验、提取并缓存，不执行安装器。' } };
    for (const pkg of packages) { const file = pkg.file.toLowerCase().endsWith('.dlss5pkg') ? pkg.file : `dlss5-nr-before-sr-${normalizeVersion(pkg.version)}-${pkg.language}.dlss5pkg`; await durableWrite(path.join(packageDir, file), pkg.bytes, true); catalog.packages.push({ file, sha256: sha256(pkg.bytes), version: pkg.version, language: pkg.language, channel: pkg.channel, displayName: pkg.displayName, runtimeProfile: 'auto', compatibility: '待验证' }); }
    await atomicJson(path.join(packageDir, 'catalog.json'), catalog);
    const destination = path.resolve('resources/components'); await noLinks(destination); await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(destination)) if (entry !== 'catalog.json' && (/\.dlss5pkg$/i.test(entry) || /^runtime-.*\.dll$/i.test(entry))) await fs.rm(path.join(destination, entry), { force: true });
    for (const entry of await fs.readdir(packageDir)) await fs.copyFile(path.join(packageDir, entry), path.join(destination, entry));
    await atomicJson(path.join(destination, 'catalog.json'), catalog);
    if (!options.noBuild) {
      execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:win'], { stdio: 'inherit' });
      const portable = (await fs.readdir('dist')).find(x => /-Portable\.exe$/i.test(x));
      if (portable) await fs.copyFile(path.join('dist', portable), path.join('dist', portable.replace(/-Portable\.exe$/i, '-Offline-Full-Portable.exe')));
      execFileSync(process.execPath, ['scripts/release-files.cjs', '--offline'], { stdio: 'inherit' });
    }
    console.log(`已准备 ${catalog.packages.length} 个真实插件版本、${Object.keys(runtimes).length} 个显卡运行环境；ReShade 使用固定官网在线准备。`);
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
