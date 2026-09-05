'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fail, sha256, leaf, noLinks, digestFile, readJson } = require('./safety.cjs');
const { detectGame, API_DLL } = require('./detection.cjs');
const { importPackage } = require('./packages.cjs');
const { compareVersions } = require('./components.cjs');
const { ensureReShade, loaderName } = require('./reshade.cjs');
const { runningGame, peInfo } = require('./platform.cjs');
class PlayerService {
  constructor(engine, dependencies = {}) { this.engine = engine; this.deps = { detect: detectGame, runtime: ensureReShade, running: runningGame, ...dependencies }; }
  preferred(game, slot) {
    if (slot && game.ab?.[slot]) return this.engine.state.packages.find(p => p.id === game.ab[slot]);
    const all = this.engine.state.packages;
    if (slot === 'B') return [...all].reverse().find(p => /beta/i.test(p.manifest.version)) || all.at(-1);
    return all.find(p => p.manifest.version === '0.3.3.4') || [...all].filter(p => !/beta|local/i.test(p.manifest.version)).sort((a, b) => compareVersions(b.manifest.version, a.manifest.version) || 0)[0] || all.at(-1);
  }
  async import(file, options = {}) {
    const pkg = await importPackage(file, { acceptLocal: true, ...options }, path.join(this.engine.root, 'packages'), require('../../config/trusted-keys.json'));
    const existing = this.engine.state.packages.find(p => p.sourceHash === pkg.sourceHash);
    if (existing) { // Cache cleanup is limited to the newly created, never-installed package ID.
      await fs.rm(path.join(this.engine.root, 'packages', pkg.id), { recursive: true, force: true }); return existing;
    }
    this.engine.state.packages.push(pkg); await this.engine.save(); return pkg;
  }
  async bundled(resources) {
    const dir = path.join(resources, 'components');
    const catalog = await readJson(path.join(dir, 'catalog.json'), null);
    if (!catalog) return { imported: 0, provided: 0 };
    if (catalog.schema !== 1 || !Array.isArray(catalog.packages) || catalog.packages.length > 20) fail('BUNDLE_INVALID', '随包插件清单无法读取。');
    let imported = 0;
    for (const p of catalog.packages) {
      const file = path.join(dir, leaf(p.file));
      if (!/^[a-f0-9]{64}$/.test(p.sha256 || '') || await digestFile(file) !== p.sha256) fail('BUNDLE_DAMAGED', '随包插件不完整，请重新获取安装器。');
      if (!this.engine.state.packages.some(x => x.sourceHash === p.sha256)) { const pkg = await this.import(file, { expectedHash: p.sha256 }); pkg.distribution = 'bundled'; imported++; }
    }
    await this.engine.save(); return { imported, provided: catalog.packages.length };
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
    const found = candidates[0];
    const { inside } = require('./safety.cjs');
    if (!inside(g.scanRoot, found.exe) || (g.installed && g.exe !== found.exe)) fail('TARGET_CHANGED', '检测到不同运行目录，请先恢复原安装记录。');
    await noLinks(found.exe); g.exe = found.exe; g.api = found.api;
    g.apiEvidence = { api: found.api, candidates: [found.api], source: 'runtime-modules', confident: true, exeHash: await digestFile(found.exe), checkedAt: new Date().toISOString() };
    await this.engine.save(); return { message: '已识别，退出游戏后即可安装或换版本。' };
  }
  async prepare(id, packageId, slot, progress = () => {}) {
    const e = this.engine, g = e.game(id);
    progress('正在识别游戏'); await this.identify(id);
    if (!g.exe || !g.api) fail('NEEDS_IDENTIFICATION', '请先启动一次游戏，然后点击“识别运行中的游戏”。无需选择图形 API。');
    const pkg = packageId ? e.package(packageId) : this.preferred(g, slot);
    if (!pkg) return { kind: 'need-package' };
    progress('正在检查游戏文件'); const report = await e.deps.scan(g, e.root);
    if (report.blockers.length) return { kind: 'blocked', waitable: report.environment?.running?.length > 0, messages: report.blockers, report };
    let loader = null;
    const proxies = report.files.filter(f => path.dirname(f.path) === report.targetRoot && (f.proxy || f.loaderCandidate));
    if (!proxies.length && !g.installed?.files.some(f => f.role === 'reshade-loader')) {
      if (report.riskWarnings?.some(w=>w.code==='SCAN_PARTIAL')) return { kind:'blocked', messages:['目标目录尚未完整检查，不能确认新加载器的位置。已有组件和其他文件保持原样。'], report };
      const name = loaderName(g.api);
      if (!name) return { kind: 'blocked', messages: ['已识别此游戏，但当前版本尚不能自动部署它的 Vulkan 加载环境。已有环境的游戏可继续更新插件。'], report };
      loader = { ...(await this.deps.runtime(e.root, progress)), name };
    }
    progress('正在准备安装');
    const plan = await e.preview(id, pkg.id, 'install', { loader });
    if (proxies.length && report.loader?.addonSupport !== 'yes') plan.riskWarnings.push({ code: 'LOADER_UNVERIFIED', message: '现有加载器保持原样；将只部署插件，游戏内是否能加载仍需验证。' });
    if (!pkg.manifest.files.some(f => f.role === 'nr-runtime') && !report.files.some(f => f.name.toLowerCase() === 'nvngx_dlssnr.dll')) plan.riskWarnings.push({ code: 'RUNTIME_NOT_FOUND', message: '未发现 NR 运行组件。可以先部署插件；要产生效果仍需使用带运行组件的完整发行包。' });
    if (pkg.trust !== 'publisher-verified' && pkg.distribution !== 'bundled') plan.riskWarnings.push({ code: 'LOCAL_SOURCE', message: '正在使用你选择的本地插件，请确认来自装机宅发布渠道。' });
    // Engine's canonical plan receives exactly the same warnings seen by the user.
    const stored = e.plans.get(plan.id); stored.riskWarnings = plan.riskWarnings;
    stored.riskKey = sha256(JSON.stringify({ codes: plan.riskWarnings.map(w => w.code).sort(), source: pkg.sourceHash, api: g.api, antiCheat: report.antiCheat, services: report.environment.antiCheat, proxies: proxies.map(f => [f.name, f.sha256]) }));
    const acknowledged = (g.acknowledgedRisks || []).includes(stored.riskKey);
    stored.slot = slot; stored.readiness = plan.riskWarnings.some(w => w.code === 'RUNTIME_NOT_FOUND') ? 'runtime-missing' : plan.riskWarnings.some(w=>w.code==='CUSTOM_ADDON_PATH') ? 'loader-unverified' : report.loader?.addonSupport === 'yes' || loader ? 'deployed' : 'loader-unverified';
    return { ...plan, acknowledged, kind: 'plan', version: pkg.manifest.version, label: pkg.manifest.version.startsWith('0.0.0-local.') ? '本地更新' : pkg.manifest.version, readiness: stored.readiness };
  }
  async apply(planId, consent) {
    const plan = this.engine.plans.get(planId); if (!plan) fail('PLAN_EXPIRED', '请重新点击安装。');
    const meta = { gameId: plan.gameId, packageId: plan.packageId, slot: plan.slot, riskKey: plan.riskKey, readiness: plan.readiness };
    const result = await this.engine.apply(planId, consent);
    const g = this.engine.game(meta.gameId);
    if (meta.packageId) { g.ab = { ...g.ab }; if (meta.slot) g.ab[meta.slot] = meta.packageId; else if (!g.ab.A) g.ab.A = meta.packageId; }
    if (meta.riskKey) g.acknowledgedRisks = [...new Set([...(g.acknowledgedRisks || []), meta.riskKey])].slice(-30);
    g.readiness = g.installed ? meta.readiness || 'deployed' : null;
    await this.engine.save(); return { ...result, readiness: g.readiness };
  }
  async assign(id, a, b) {
    const g = this.engine.game(id); if (a) this.engine.package(a); if (b) this.engine.package(b);
    g.ab = { A: a || null, B: b || null }; await this.engine.save(); return true;
  }
}
module.exports = { PlayerService };
