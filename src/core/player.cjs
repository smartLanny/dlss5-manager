'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, sha256, leaf, noLinks, digestFile, readJson } = require('./safety.cjs');
const { detectGame, API_DLL } = require('./detection.cjs');
const { importPackage } = require('./packages.cjs');
const { ensureReShade, loaderName } = require('./reshade.cjs');
const { ensureRuntime, RUNTIME_PROFILES } = require('./runtime.cjs');
const { detectGpu } = require('./gpu.cjs');
const { runningGame, peInfo } = require('./platform.cjs');
const { versionKey } = require('./versions.cjs');

function packageLanguage(pkg) {
  if (pkg.language) return pkg.language;
  return /\.en\.addon64$/i.test(pkg.manifest?.files?.find(f => f.role === 'addon')?.path || '') ? 'en' : 'zh-CN';
}
function packageSupportsGpu(pkg, family) {
  const families = pkg.componentManifest?.hardwareFamilies;
  if (!Array.isArray(families) || !families.length || !family || family === 'unknown') return true;
  return families.includes(family) || families.includes('RTX20-30') && ['RTX20', 'RTX30'].includes(family);
}

class PlayerService {
  constructor(engine, dependencies = {}) {
    this.engine = engine;
    this.resourcesRoot = null;
    this.catalog = null;
    this.deps = { detect: detectGame, runtime: ensureReShade, runtimeProfile: ensureRuntime, gpu: detectGpu, running: runningGame, ...dependencies };
  }
  preferred(game, slot) {
    if (!slot && game.selectedPackageId) {
      const selected = this.engine.state.packages.find(p => p.id === game.selectedPackageId);
      if (selected) return selected;
    }
    if (!slot && game.installed?.packageId) {
      const installed = this.engine.state.packages.find(p => p.id === game.installed.packageId);
      if (installed) return installed;
    }
    if (!slot) {
      const recommended = this.engine.state.packages.filter(p => versionKey(p.manifest.version) === '0.3.3.4');
      if (recommended.length) return recommended.find(p => packageLanguage(p) === 'zh-CN') || recommended[0];
    }
    return require('./versions.cjs').preferredPackage(this.engine.state.packages, game, slot);
  }
  async import(file, options = {}) {
    const pkg = await importPackage(file, { acceptLocal: true, ...options }, path.join(this.engine.root, 'packages'), require('../../config/trusted-keys.json'));
    pkg.language = packageLanguage(pkg);
    pkg.displayName = pkg.displayName || '装机宅 ' + pkg.manifest.version;
    const existing = this.engine.state.packages.find(p => p.sourceHash === pkg.sourceHash);
    if (existing) {
      await fs.rm(path.join(this.engine.root, 'packages', pkg.id), { recursive: true, force: true });
      if (!existing.language) existing.language = pkg.language;
      return existing;
    }
    this.engine.state.packages.push(pkg); await this.engine.save(); return pkg;
  }
  async bundled(resources) {
    this.resourcesRoot = resources;
    const dir = path.join(resources, 'components');
    const catalog = await readJson(path.join(dir, 'catalog.json'), null);
    if (!catalog) return { imported: 0, provided: 0 };
    if (catalog.schema !== 2 || !Array.isArray(catalog.packages) || catalog.packages.length > 20) fail('BUNDLE_INVALID', '随包插件清单无法读取。');
    this.catalog = catalog;
    let imported = 0;
    for (const item of catalog.packages) {
      const file = path.join(dir, leaf(item.file));
      if (!/^[a-f0-9]{64}$/.test(item.sha256 || '') || await digestFile(file) !== item.sha256) fail('BUNDLE_DAMAGED', '随包插件不完整，请重新获取安装器。');
      let pkg = this.engine.state.packages.find(x => x.sourceHash === item.sha256);
      if (!pkg) { pkg = await this.import(file, { expectedHash: item.sha256 }); imported++; }
      pkg.distribution = 'bundled'; pkg.language = item.language || packageLanguage(pkg); pkg.channel = item.channel || 'beta'; pkg.runtimeProfile = item.runtimeProfile || 'auto'; pkg.compatibility = item.compatibility || '待验证'; pkg.displayName = item.displayName || `装机宅 ${pkg.manifest.version}`;
    }
    await this.engine.save(); return { imported, provided: catalog.packages.length };
  }
  async gpu() {
    const detected = await this.deps.gpu();
    const selected = this.engine.state.gpu;
    if (detected?.profileId || !selected?.profileId) return detected;
    return { ...detected, ...selected, source: selected.source || 'user-selected', reliable: false };
  }
  async identify(id) { const g = this.engine.game(id); const result = await this.deps.detect(g, this.engine.root); await this.engine.save(); return result; }
  async observe(id) {
    const g = this.engine.game(id), rows = await this.deps.running(g.scanRoot);
    const candidates = [];
    for (const row of rows) {
      const pe = await peInfo(row.exe); if (!pe.valid || pe.dll || pe.arch !== 'x64') continue;
      const apis = [...new Set(row.modules.map(n => API_DLL[n]).filter(Boolean))];
      if (apis.length === 1) candidates.push({ ...row, api: apis[0] });
    }
    if (candidates.length !== 1) fail('API_AMBIGUOUS', '仍未唯一识别。请进入游戏主菜单再试；不需要猜选 DX11 或 DX12。');
    const found = candidates[0], { inside } = require('./safety.cjs');
    if (!inside(g.scanRoot, found.exe) || (g.installed && g.exe !== found.exe)) fail('TARGET_CHANGED', '检测到不同运行目录，请先恢复原安装记录。');
    await noLinks(found.exe); g.exe = found.exe; g.api = found.api;
    g.apiEvidence = { api: found.api, candidates: [found.api], source: 'runtime-modules', confident: true, confidence: 'high', exeHash: await digestFile(found.exe), checkedAt: new Date().toISOString() };
    await this.engine.save(); return { message: '已识别，退出游戏后即可安装或换版本。' };
  }
  async prepare(id, packageId, slot, progress = () => {}) {
    const e = this.engine, g = e.game(id);
    progress('正在识别游戏'); await this.identify(id);
    if (!g.exe || !g.api) fail('NEEDS_IDENTIFICATION', '暂时无法确定游戏运行程序；请启动一次游戏后再试。');
    let pkg = packageId ? e.package(packageId) : this.preferred(g, slot);
    if (!pkg) return { kind: 'need-package' };
    if (g.api !== 'DX12') return { kind: 'blocked', messages: [`已识别：${g.api}。当前装机宅版本暂未验证该 API，未修改游戏文件。`], report: { blockers: [], riskWarnings: [] }, unsupportedApi: true };
    progress('正在检查游戏文件'); const report = await e.deps.scan(g, e.root);
    if (report.blockers.length) return { kind: 'blocked', waitable: report.environment?.running?.length > 0, messages: report.blockers, report };
    const proxies = report.files.filter(f => path.dirname(f.path) === report.targetRoot && (f.proxy || f.loaderCandidate));
    if (!proxies.length && !g.installed?.files.some(f => f.role === 'reshade-loader') && report.riskWarnings?.some(w => w.code === 'SCAN_PARTIAL')) return { kind: 'blocked', messages: ['目标目录尚未完整检查，不能确认运行环境的位置。已有组件和其他文件保持原样。'], report };
    const selectedGpu = await this.gpu();
    const profileId = selectedGpu?.profileId;
    if (!profileId) return { kind: 'needs-gpu', messages: ['暂时无法可靠识别 NVIDIA 显卡，未选择运行环境，也没有修改游戏文件。请在高级设置中选择后再试。'], gpu: selectedGpu, report };
    if (!packageSupportsGpu(pkg, selectedGpu.family)) {
      const sameLanguage = e.state.packages.find(p => p.id !== pkg.id && p.manifest.version === pkg.manifest.version && packageLanguage(p) === packageLanguage(pkg) && packageSupportsGpu(p, selectedGpu.family));
      const alternate = sameLanguage || e.state.packages.find(p => p.id !== pkg.id && pkg.manifest.version === p.manifest.version && packageSupportsGpu(p, selectedGpu.family));
      if (alternate) pkg = alternate;
      else return { kind: 'blocked', messages: [`已识别 ${selectedGpu.family}，所选版本没有对应的运行环境；未修改游戏文件。请选择其他可用版本。`], report, gpu: selectedGpu };
    }
    const runtimeAlreadyInPackage = pkg.manifest.files.some(f => f.role === 'nr-runtime');
    let runtimeFile = null;
    if (!runtimeAlreadyInPackage) {
      progress('正在准备运行环境');
      const runtimeDefinition = { ...RUNTIME_PROFILES[profileId], ...(this.catalog?.runtimeProfiles?.[profileId] || {}) };
      runtimeFile = await this.deps.runtimeProfile(e.root, runtimeDefinition, progress, { resourcesRoot: this.resourcesRoot });
    }
    let loader = null;
    if (!proxies.length && !g.installed?.files.some(f => f.role === 'reshade-loader')) {
      const name = loaderName(g.api);
      if (!name) return { kind: 'blocked', messages: ['已识别此游戏，但当前版本不能自动部署它的运行环境。已有环境的游戏可继续更新插件。'], report };
      loader = { ...(await this.deps.runtime(e.root, progress)), name };
    }
    progress('正在准备安装');
    const plan = await e.preview(id, pkg.id, 'install', { loader, extraFiles: runtimeFile ? [runtimeFile] : [] });
    if (proxies.length && report.loader?.addonSupport !== 'yes') plan.riskWarnings.push({ code: 'LOADER_UNVERIFIED', message: '现有图形运行环境保持原样；插件是否能加载仍需验证。' });
    if (selectedGpu.family !== 'RTX50') plan.riskWarnings.push({ code: 'GPU_EXPERIMENTAL', message: `${RUNTIME_PROFILES[profileId].label} 运行环境为实验性 / 待验证；r3 没有宣称解决 RTX40 MFG #63。` });
    if (pkg.trust !== 'publisher-verified' && pkg.distribution !== 'bundled') plan.riskWarnings.push({ code: 'LOCAL_SOURCE', message: '正在使用你导入的本地插件，请确认来自装机宅发布渠道。' });
    const stored = e.plans.get(plan.id); stored.riskWarnings = plan.riskWarnings;
    stored.riskKey = sha256(JSON.stringify({ codes: plan.riskWarnings.map(w => w.code).sort(), source: pkg.sourceHash, api: g.api, gpu: selectedGpu.family, antiCheat: report.antiCheat, services: report.environment.antiCheat, proxies: proxies.map(f => [f.name, f.sha256]) }));
    const acknowledged = (g.acknowledgedRisks || []).includes(stored.riskKey);
    stored.slot = slot; stored.gpu = selectedGpu; stored.runtimeProfile = profileId; stored.readiness = report.loader?.addonSupport === 'yes' || loader ? 'deployed' : 'loader-unverified';
    return { ...plan, acknowledged, kind: 'plan', version: pkg.manifest.version, label: pkg.displayName || `装机宅 ${pkg.manifest.version}`, readiness: stored.readiness, gpu: selectedGpu, runtimeProfile: { ...RUNTIME_PROFILES[profileId], ...(this.catalog?.runtimeProfiles?.[profileId] || {}) } };
  }
  async apply(planId, consent) {
    const plan = this.engine.plans.get(planId); if (!plan) fail('PLAN_EXPIRED', '请重新点击安装。');
    const meta = { gameId: plan.gameId, packageId: plan.packageId, slot: plan.slot, riskKey: plan.riskKey, readiness: plan.readiness, gpu: plan.gpu, runtimeProfile: plan.runtimeProfile };
    const result = await this.engine.apply(planId, consent), g = this.engine.game(meta.gameId);
    if (meta.packageId) { g.selectedPackageId = meta.packageId; g.ab = { ...g.ab }; if (meta.slot) g.ab[meta.slot] = meta.packageId; else if (!g.ab.A) g.ab.A = meta.packageId; }
    if (meta.riskKey) g.acknowledgedRisks = [...new Set([...(g.acknowledgedRisks || []), meta.riskKey])].slice(-30);
    if (meta.gpu) g.gpu = { family: meta.gpu.family, profileId: meta.gpu.profileId, source: meta.gpu.source };
    g.runtimeProfile = meta.runtimeProfile || g.runtimeProfile;
    g.readiness = g.installed ? meta.readiness || 'deployed' : null;
    await this.engine.save(); return { ...result, readiness: g.readiness };
  }
  async assign(id, a, b) {
    const g = this.engine.game(id); if (a) this.engine.package(a); if (b) this.engine.package(b);
    g.ab = { A: a || null, B: b || null }; await this.engine.save(); return true;
  }
}
module.exports = { PlayerService, packageLanguage };
