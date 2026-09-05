'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { constants } = require('node:fs');
const { fail, validId, leaf, HASH, noLinks, assertGameRoot, digestFile, durableWrite, atomicJson, readJson, redact } = require('./safety.cjs');
const { scanGame } = require('./scanner.cjs');
const { environment, checkLocks } = require('./platform.cjs');
const { validateManifest, importPackage } = require('./packages.cjs');
const { componentForPackage, componentBlockers, changeKind } = require('./components.cjs');
const { validateLoaderFile } = require('./reshade.cjs');
const { retainedEnvironment, uninstallSummary } = require('./uninstall.cjs');
function managedFile(f) { return f.role === 'reshade-loader' ? validateLoaderFile(f) : allowedFile(f.name); }
const MANAGER_VERSION = require('../../package.json').version;
const clone = value => structuredClone(value);
function environmentFingerprint(report) {
  return JSON.stringify({ antiCheat: [...(report.antiCheat || [])].sort(), services: [...(report.environment?.antiCheat || [])].sort(),
    files: (report.files || []).filter(f => f.proxy || f.loaderCandidate || /\.addon64$/i.test(f.name)).map(f => [f.relative || f.name, f.sha256]).sort((a,b)=>a[0].localeCompare(b[0])) });
}

function allowedFile(name) {
  leaf(name);
  if (!/\.addon64$/i.test(name) && name.toLowerCase() !== 'nvngx_dlssnr.dll') fail('PROTECTED_FILE', '不允许修改此文件。管理器不会覆盖图形代理或系统 DLL。');
  return name;
}
function validHash(hash) { if (hash !== null && !HASH.test(hash)) fail('JOURNAL_INVALID', '记录的文件校验值无效。'); }
async function copyDurable(source, target, expected) {
  await noLinks(source); await noLinks(target);
  await fs.copyFile(source, target, constants.COPYFILE_EXCL);
  const h = await fs.open(target, 'r+'); try { await h.sync(); } finally { await h.close(); }
  if (await digestFile(target) !== expected) fail('HASH_MISMATCH', '复制后的 SHA-256 不一致，已停止操作。');
}
class Engine {
  constructor(root, dependencies = {}) {
    this.root = path.resolve(root);
    this.stateFile = path.join(this.root, 'state.json');
    this.deps = { scan: scanGame, environment, locks: checkLocks, ...dependencies };
    this.plans = new Map(); this.busy = false; this.state = null;
  }
  async init() {
    await noLinks(this.root);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    this.state = await readJson(this.stateFile, { schema: 1, games: [], packages: [] });
    if (![1, 2, 3, 4].includes(this.state.schema) || !Array.isArray(this.state.games) || !Array.isArray(this.state.packages) || this.state.games.length > 2000 || this.state.packages.length > 1000) fail('STATE_INVALID', '本地管理记录无法读取，未修改任何游戏文件。');
    for (const g of this.state.games) { validId(g.id); if (typeof g.scanRoot !== 'string') fail('STATE_INVALID', '游戏记录已损坏。'); }
    for (const p of this.state.packages) { validId(p.id); validateManifest(p.manifest); componentForPackage(p); }
    return this;
  }
  async save() {
    // Old managers cannot enforce v2 constraints. Fail closed on downgrade instead
    // of presenting a normalized v2 package to 0.1 as an unrestricted v1 package.
    if (this.state.schema === 1 && this.state.packages.some(p => p.componentManifest)) {
      const previous = await readJson(this.stateFile, { schema: 1, games: [], packages: [] });
      const folder = path.join(this.root, 'metadata-backups');
      await noLinks(folder); await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      await durableWrite(path.join(folder, `state-v1-${crypto.randomUUID()}.json`), JSON.stringify(previous, null, 2), true);
      this.state.schema = 2;
    }
    if (this.state.schema < 3 && (this.state.packages.some(p => p.manifest.apiPolicy === 'detect-target') || this.state.games.some(g => g.installed?.files.some(f => f.role === 'reshade-loader')))) {
      const previous = await readJson(this.stateFile, { schema: this.state.schema, games: [], packages: [] });
      const folder = path.join(this.root, 'metadata-backups');
      await noLinks(folder); await fs.mkdir(folder, { recursive: true, mode: 0o700 });
      await durableWrite(path.join(folder, `state-before-player-${crypto.randomUUID()}.json`), JSON.stringify(previous, null, 2), true);
      this.state.schema = 3;
    }
    await atomicJson(this.stateFile, this.state);
  }
  async ensureLifecycleState() {
    if (this.state.schema === 4) return;
    // Older managers ignore retained dependency receipts. Persist their refusal
    // boundary BEFORE any new transaction can change a game file or ownership.
    const previous = await readJson(this.stateFile, { schema: 1, games: [], packages: [] });
    const folder = path.join(this.root, 'metadata-backups');
    await noLinks(folder); await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    await durableWrite(path.join(folder, `state-before-lifecycle-${crypto.randomUUID()}.json`), JSON.stringify(previous, null, 2), true);
    await atomicJson(this.stateFile, { ...this.state, schema: 4 });
    this.state.schema = 4;
  }
  game(id) { validId(id); const g = this.state.games.find(g => g.id === id); if (!g) fail('GAME_MISSING', '游戏记录不存在，请重新添加。'); return g; }
  package(id) { validId(id); const p = this.state.packages.find(p => p.id === id); if (!p) fail('PACKAGE_MISSING', '请先导入对应版本的 addon。'); validateManifest(p.manifest); componentForPackage(p); return p; }
  txDir(id) { return path.join(this.root, 'transactions', validId(id)); }
  journalPath(id) { return path.join(this.txDir(id), 'journal.json'); }
  backupPath(ref) {
    if (!ref || !Number.isInteger(ref.index) || ref.index < 0 || ref.index > 8) fail('BACKUP_INVALID', '备份位置记录无效。');
    return path.join(this.txDir(ref.tx), `${ref.index}.bin`);
  }
  async history(gameId) {
    let entries;
    try { entries = await fs.readdir(path.join(this.root, 'transactions'), { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const results = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) fail('JOURNAL_INVALID', '事务目录存在异常文件，请保留备份并检查。');
      const j = await readJson(this.journalPath(entry.name), null);
      // A crash can occur between mkdir and the first journal write. Only an EMPTY
      // directory is harmless: backups or temporary files without a journal block.
      if (!j) {
        if ((await fs.readdir(this.txDir(entry.name))).length === 0) continue;
        fail('JOURNAL_INVALID', '发现缺少事务记录的备份目录，已保留所有文件并停止写入。');
      }
      if (j.id !== entry.name || !['preparing', 'prepared', 'applying', 'committed', 'restoring', 'reverted', 'aborted', 'recovery-needed'].includes(j.status)) fail('JOURNAL_INVALID', '事务记录损坏，不能继续写入游戏目录。');
      if (!gameId || j.gameId === gameId) results.push(j);
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async pending(gameId) { return (await this.history(gameId)).filter(j => !['committed', 'reverted', 'aborted'].includes(j.status)); }
  async serialize(action) {
    if (this.busy) fail('BUSY', '已有文件操作正在进行，请勿重复点击。');
    this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }
  async checkOwnership(game, root) {
    const all = await this.history();
    const other = this.state.games.find(g => g.id !== game.id && g.exe && path.resolve(path.dirname(g.exe)).toLowerCase() === root.toLowerCase() && (g.installed || all.some(j => j.gameId === g.id && !['committed', 'reverted', 'aborted'].includes(j.status))));
    if (other) fail('TARGET_ALREADY_MANAGED', '同一运行目录已由另一条游戏记录管理，请使用原记录更新或恢复，避免污染原始备份。');
    const latest = all.find(j => j.gameId === game.id && j.status === 'committed');
    if (JSON.stringify(game.installed || null) !== JSON.stringify(latest?.afterInstalled || null)) fail('OWNERSHIP_UNVERIFIED', '文件归属记录与已提交事务不一致，已停止写入。请先到恢复中心检查。');
    for (const f of game.installed?.files || []) {
      managedFile(f); validHash(f.sha256); validHash(f.baselineHash);
      if (f.baselineHash && await digestFile(this.backupPath(f.baseline)) !== f.baselineHash) fail('BACKUP_DAMAGED', '首次接管前的原始备份校验失败，已停止更新并保留现状。');
    }
  }
  async captureAddon(gameId, confirmed = false) {
    return this.serialize(async () => {
      if (confirmed !== true) fail('CAPTURE_CONFIRMATION', '请确认保存当前外部修改的 addon，原始备份仍会保留。');
      const g = this.game(gameId), root = await assertGameRoot(path.dirname(g.exe), this.root);
      if ((await this.pending(g.id)).length) fail('RECOVERY_FIRST', '请先恢复未完成的操作。');
      await this.checkOwnership(g, root);
      const env = await this.deps.environment(root, g.exe);
      if (!env.verified || env.running.length) fail('GAME_RUNNING', '请退出游戏后保存当前版本。');
      await this.deps.locks((g.installed?.files || []).map(f => path.join(root, f.name)));
      const changed = [];
      for (const f of g.installed?.files || []) {
        const hash = await digestFile(path.join(root, f.name));
        if (hash !== f.sha256) changed.push({ ...f, actual: hash });
      }
      if (changed.length !== 1 || changed[0].role !== 'addon' || !changed[0].actual) fail('CAPTURE_UNSAFE', '仅可保存单个已管理 addon 的外部变更。加载器、运行组件或缺失文件需要单独检查。');
      const f = changed[0], oldPackage = this.package(g.installed.packageId);
      const oldFile = oldPackage.manifest.files.find(x => x.role === 'addon' && x.sha256 === f.sha256);
      if (!oldFile) fail('OLD_VERSION_MISSING', '无法取得原受管版本，不能建立可靠的恢复记录。');
      const oldSource = path.join(this.root, 'packages', oldPackage.id, leaf(oldFile.path));
      if (await digestFile(oldSource) !== f.sha256) fail('CACHE_TAMPERED', '原版本缓存已变化，请先修复缓存。');
      const target = path.join(root, f.name);
      const pkg = await importPackage(target, { acceptLocal: true }, path.join(this.root, 'packages'));
      const payload = pkg.manifest.files.find(x => x.role === 'addon');
      if (payload.sha256 !== f.actual || await digestFile(target) !== f.actual) fail('FILE_CHANGED', '保存时文件仍在变化，请关闭其他工具再试。');
      pkg.manifest.version = '0.0.0-local.' + Date.now(); pkg.displayName = '外部修改快照';
      await this.ensureLifecycleState();
      this.state.packages.push(pkg); await this.save(); // Persist the captured bytes before adopting metadata.
      const txid = crypto.randomUUID(); await fs.mkdir(this.txDir(txid), { recursive: true, mode: 0o700 });
      const j = { schema: 1, id: txid, gameId: g.id, root, operation: 'capture-external', version: pkg.manifest.version, createdAt: new Date().toISOString(), status: 'preparing', beforeInstalled: clone(g.installed), afterInstalled: null,
        changes: [{ name: f.name, role: 'addon', before: f.sha256, after: f.actual, adopt: false, action: '保存外部变更，不写游戏目录' }] };
      await atomicJson(this.journalPath(txid), j);
      try {
        await copyDurable(oldSource, this.backupPath({ tx: txid, index: 0 }), f.sha256);
        j.afterInstalled = { ...clone(g.installed), packageId: pkg.id, version: pkg.manifest.version, channel: 'local', installedAt: new Date().toISOString() };
        j.afterInstalled.files.find(x => x.name === f.name).sha256 = f.actual;
        if (await digestFile(target) !== f.actual) fail('FILE_CHANGED', '记录前文件又发生变化，未接管该文件。');
        j.status = 'prepared'; await atomicJson(this.journalPath(txid), j);
        g.installed = clone(j.afterInstalled); await this.save();
        j.status = 'committed'; await atomicJson(this.journalPath(txid), j);
        return { packageId: pkg.id, transactionId: txid };
      } catch (e) {
        // No game files were written. Do not silently revert externally edited bytes on a metadata failure.
        if (j.status === 'preparing') j.status = 'aborted'; else j.status = 'recovery-needed';
        await atomicJson(this.journalPath(txid), j); throw e;
      }
    });
  }
  async preview(gameId, packageId, operation = 'install', options = {}) {
    if (!['install', 'uninstall'].includes(operation)) fail('INVALID_OPERATION', '操作类型不支持。');
    const game = this.game(gameId), report = await this.deps.scan(game, this.root, { purpose: operation });
    const driftFiles = [];
    const blockers = [...report.blockers], riskWarnings = [...(report.riskWarnings || [])];
    if (options.loader) {
      validateLoaderFile({ ...options.loader, name: options.loader.name });
      report.componentEvidence = [...(report.componentEvidence || []), { componentId: 'reshade', version: options.loader.version, verified: true, capabilities: ['addon-support'] }];
    }
    if ((await this.pending(gameId)).length) blockers.push('有未完成的操作，请先到恢复中心恢复。');
    const targetRoot = await assertGameRoot(path.dirname(game.exe), this.root);
    await this.checkOwnership(game, targetRoot);
    const current = game.installed?.files || [];
    for (const f of current) {
      managedFile(f); validHash(f.sha256);
      const actual = await digestFile(path.join(targetRoot, f.name));
      if (actual !== f.sha256) {
        driftFiles.push({ name: f.name, role: f.role, missing: !actual, capturable: f.role === 'addon' && !!actual });
        blockers.push(`${f.name} 已在管理器之外改变。可先保存当前 addon 为本地版本，再重新切换；不会丢弃当前文件。`);
      }
    }
    let pkg = null, desired = [], nextFiles = clone(current), keptEnvironment = [];
    if (operation === 'install') {
      pkg = this.package(packageId);
      blockers.push(...componentBlockers(pkg, report, MANAGER_VERSION));
      if (pkg.manifest.apiPolicy !== 'detect-target' && !pkg.manifest.apis.includes(game.api)) blockers.push('导入包声明的 API 与当前游戏选择不一致。');
      if (pkg.manifest.apiPolicy === 'detect-target') riskWarnings.push({ code: 'LOCAL_API_UNDECLARED', message: '此本地插件未附兼容性说明；已自动识别游戏运行方式，插件实际效果仍需测试。' });
      const existingAddon = current.find(x => x.role === 'addon');
      for (const f of pkg.manifest.files) {
        const name = allowedFile(f.role === 'addon' && existingAddon ? existingAddon.name : f.path);
        const source = path.join(this.root, 'packages', pkg.id, leaf(f.path));
        if (await digestFile(source) !== f.sha256) fail('CACHE_TAMPERED', '本地插件缓存校验失败，请重新导入。');
        desired.push({ name, role: f.role, after: f.sha256, source });
      }
      if (options.loader) {
        const oldHost = report.files.filter(f => f.proxy || f.loaderCandidate);
        if (oldHost.some(f => path.dirname(f.path) === targetRoot && (f.name.toLowerCase() !== options.loader.name.toLowerCase() || f.sha256 !== options.loader.after))) blockers.push('已有加载器保持不动，不能创建重复或未知代理链。');
        desired.push({ ...options.loader });
      }
      const addonTarget = desired.find(x => x.role === 'addon').name.toLowerCase();
      const otherAddons = report.files.filter(f => path.dirname(f.path) === targetRoot && /\.addon64$/i.test(f.name) && f.name.toLowerCase() !== addonTarget);
      if (otherAddons.length) riskWarnings.push({ code: 'OTHER_ADDONS', message: '存在其他插件，将原样保留。请留意重复加载或兼容性问题。' });
    } else {
      if (!current.length) fail('NOT_INSTALLED', '此游戏没有管理器拥有的文件，无需卸载。');
      keptEnvironment = retainedEnvironment(current, report);
      const keptNames = new Set(keptEnvironment.map(f => f.name));
      desired = current.filter(f => !keptNames.has(f.name)).map(f => ({ name: managedFile(f), role: f.role, after: f.baselineHash, source: f.baselineHash ? this.backupPath(f.baseline) : null }));
      if (keptEnvironment.length) riskWarnings.push({ code: 'SHARED_ENVIRONMENT', message: '检测到其他插件或 ReShade 配置；卸载 NR 时保留共用运行环境，避免影响现有模组。' });
      nextFiles = [];
    }
    const changes = [];
    for (const d of desired) {
      const before = await digestFile(path.join(targetRoot, d.name));
      const owned = current.find(x => x.name.toLowerCase() === d.name.toLowerCase());
      if (d.after) { validHash(d.after); if (await digestFile(d.source) !== d.after) fail('SOURCE_CHANGED', '源文件或原始备份校验失败。'); }
      changes.push({ ...d, before, ownership: owned ? 'manager-owned' : before ? 'unknown' : 'new', adopt: !!before && !owned, action: d.after === null ? '移除管理器文件' : before === d.after && owned ? '内容一致，仅校验' : before ? '备份并替换' : '新增文件' });
    }
    const noOp = operation === 'install' && game.installed?.version === pkg.manifest.version && changes.every(c => !c.adopt && c.before === c.after);
    const transition = operation === 'install' ? changeKind(game.installed?.version, pkg.manifest.version, noOp) : 'uninstall';
    const retainedFiles = current.filter(f => !changes.some(c => c.name.toLowerCase() === f.name.toLowerCase())).map(f => ({ name: f.name, role: f.role, sha256: f.sha256, action: '保留现有文件（本包未提供）' }));
    const componentInfo = pkg ? { id: pkg.manifest.component, channel: componentForPackage(pkg)?.channel || 'local', contract: pkg.componentManifest ? 2 : 1 } : null;
    const id = crypto.randomUUID();
    const plan = { id, retainedEnvironment: keptEnvironment, driftFiles, exeHash: await digestFile(game.exe), environmentSnapshot: environmentFingerprint(report), noOp, transition, retainedFiles, componentInfo, gameId, packageId: pkg?.id || null, operation, targetRoot, createdAt: new Date().toISOString(), expires: Date.now() + 5 * 60 * 1000, changes, riskWarnings, stagedLoader: options.loader ? { name: options.loader.name, after: options.loader.after, version: options.loader.version } : null, blockers: [...new Set(blockers)], report, previousInstalled: clone(game.installed || null), nextFiles, fingerprint: JSON.stringify({ exe: game.exe, api: game.api, kind: game.kind, environmentConfirmed: game.environmentConfirmed, installed: game.installed }) };
    for (const [key, value] of this.plans) if (value.expires < Date.now()) this.plans.delete(key);
    this.plans.set(id, plan);
    return { ...plan, changes: changes.map(({ source, ...c }) => c), nextFiles: undefined, fingerprint: undefined, previousInstalled: undefined };
  }
  async apply(planId, consent = {}) {
    return this.serialize(async () => {
      validId(planId);
      const plan = this.plans.get(planId); this.plans.delete(planId);
      if (!plan || plan.expires < Date.now()) fail('PLAN_EXPIRED', '预览已过期，请重新检查后安装。');
      if (plan.blockers.length) fail('INSTALL_BLOCKED', plan.blockers.join('\n'));
      if (consent.confirm !== true || (plan.operation === 'install' && consent.compatibility !== true)) fail('CONFIRM_REQUIRED', '请确认变更清单和兼容性说明。');
      if (plan.transition === 'downgrade' && consent.downgrade !== true) fail('DOWNGRADE_CONFIRMATION', '这是降级操作，请确认恢复到较旧的插件版本。');
      if (plan.riskWarnings.some(w => !consent.riskCodes?.includes(w.code))) fail('RISK_CONFIRMATION', '请先阅读这次操作的兼容性提醒。');
      if (plan.changes.some(c => c.adopt && !consent.adoptNames?.includes(c.name))) fail('ADOPTION_REQUIRED', '需要逐项确认接管并备份现有文件。');
      const game = this.game(plan.gameId);
      if (plan.fingerprint !== JSON.stringify({ exe: game.exe, api: game.api, kind: game.kind, environmentConfirmed: game.environmentConfirmed, installed: game.installed })) fail('PLAN_CHANGED', '游戏配置已变化，请重新预览。');
      const report = await this.deps.scan(game, this.root, { purpose: plan.operation });
      if (plan.operation === 'install' && plan.exeHash !== await digestFile(game.exe)) fail('EXE_CHANGED', '游戏程序在检查后发生变化，请重新识别再安装。');
      if (plan.environmentSnapshot !== environmentFingerprint(report)) fail('RISK_CHANGED', '游戏加载环境在预览后发生变化，请重新检查。');
      if (plan.stagedLoader) {
        validateLoaderFile({ ...plan.stagedLoader, role: 'reshade-loader' });
        const local = report.files.filter(f => path.dirname(f.path) === plan.targetRoot && (f.proxy || f.loaderCandidate));
        if (local.some(f => f.name.toLowerCase() !== plan.stagedLoader.name.toLowerCase() || f.sha256 !== plan.stagedLoader.after)) fail('LOADER_CHANGED', '检测到新增或变化的加载器，已停止，请重新检查。');
        report.componentEvidence = [...(report.componentEvidence || []), { componentId: 'reshade', version: plan.stagedLoader.version, verified: true, capabilities: ['addon-support'] }];
      }
      if ((report.riskWarnings || []).some(w => !consent.riskCodes?.includes(w.code))) fail('RISK_CHANGED', '检查后出现了新的兼容性提醒，请重新确认。');
      if (plan.operation === 'uninstall' && JSON.stringify(plan.retainedEnvironment) !== JSON.stringify(retainedEnvironment(game.installed?.files || [], report))) fail('UNINSTALL_CHANGED', '其他插件或配置在预览后发生变化，请重新点击卸载。');
      if (plan.packageId) report.blockers.push(...componentBlockers(this.package(plan.packageId), report, MANAGER_VERSION));
      await this.checkOwnership(game, plan.targetRoot);
      for (const f of game.installed?.files || []) if (await digestFile(path.join(plan.targetRoot, f.name)) !== f.sha256) fail('FILE_CHANGED', '已有受管组件在预览后发生变化，已停止更新。');
      if (report.blockers.length || (await this.pending(game.id)).length) fail('INSTALL_BLOCKED', report.blockers.join('\n') || '请先恢复未完成操作。');
      await assertGameRoot(plan.targetRoot, this.root);
      await this.deps.locks(plan.changes.map(c => path.join(plan.targetRoot, c.name)));
      for (const c of plan.changes) {
        if (await digestFile(path.join(plan.targetRoot, c.name)) !== c.before) fail('FILE_CHANGED', '预览后文件发生变化，已停止。请重新检查。');
        if (c.after && await digestFile(c.source) !== c.after) fail('SOURCE_CHANGED', '源文件校验失败。');
      }
      if (plan.noOp) return { transactionId: null, version: this.package(plan.packageId).manifest.version, operation: 'verify', unchanged: true, noOp: true };
      await this.ensureLifecycleState();
      const txid = crypto.randomUUID(), dir = this.txDir(txid);
      await noLinks(dir); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const journal = { schema: 1, id: txid, gameId: game.id, root: plan.targetRoot, operation: plan.operation, version: plan.packageId ? this.package(plan.packageId).manifest.version : null, createdAt: new Date().toISOString(), status: 'preparing', beforeInstalled: clone(game.installed || null), afterInstalled: null, retainedEnvironment: clone(plan.retainedEnvironment), changes: plan.changes.map(({ source, ...c }) => c) };
      const persist = () => atomicJson(this.journalPath(txid), journal);
      await persist();
      try {
        for (let i = 0; i < plan.changes.length; i++) {
          const c = plan.changes[i];
          if (c.before) await copyDurable(path.join(plan.targetRoot, c.name), this.backupPath({ tx: txid, index: i }), c.before);
        }
        if (plan.operation === 'install') {
          const next = clone(plan.nextFiles);
          for (let i = 0; i < plan.changes.length; i++) {
            const c = plan.changes[i], index = next.findIndex(f => f.name.toLowerCase() === c.name.toLowerCase()), old = next[index];
            const file = { name: c.name, role: c.role, componentId: c.role === 'reshade-loader' ? 'reshade' : c.role === 'nr-runtime' ? 'nr-runtime' : 'nr-before-sr', sha256: c.after, baselineHash: old ? old.baselineHash : c.before, baseline: old ? old.baseline : c.before ? { tx: txid, index: i } : null };
            if (index >= 0) next[index] = file; else next.push(file);
          }
          journal.afterInstalled = { componentId: 'nr-before-sr', channel: plan.componentInfo?.channel || 'local', version: journal.version, packageId: plan.packageId, installedAt: new Date().toISOString(), files: next };
        }
        journal.status = 'prepared'; await persist();
        for (let i = 0; i < plan.changes.length; i++) {
          const c = plan.changes[i];
          if (c.after) await copyDurable(c.source, this.stagePath(journal, i), c.after);
        }
        journal.status = 'applying'; await persist();
        for (let i = 0; i < plan.changes.length; i++) {
          const c = plan.changes[i], target = path.join(plan.targetRoot, c.name);
          await assertGameRoot(plan.targetRoot, this.root);
          if (await digestFile(target) !== c.before) fail('FILE_CHANGED', '文件发生变化，已停止并尝试恢复。');
          if (c.after) {
            if (await digestFile(this.stagePath(journal, i)) !== c.after) fail('STAGE_CHANGED', '临时文件校验失败。');
            await fs.rename(this.stagePath(journal, i), target);
          } else if (c.before) { await noLinks(target); await fs.unlink(target); }
          if (await digestFile(target) !== c.after) fail('WRITE_VERIFY_FAILED', '写入后的哈希不一致。');
          if (this.deps.afterWrite) await this.deps.afterWrite(i, journal);
        }
        game.installed = clone(journal.afterInstalled); await this.save();
        journal.status = 'committed'; await persist();
        return { transactionId: txid, version: journal.version, operation: journal.operation, ...(plan.operation === 'uninstall' ? { uninstall: uninstallSummary(plan) } : {}) };
      } catch (e) {
        journal.errorCode = /^[A-Z_]+$/.test(e.code || '') ? e.code : 'OPERATION_FAILED';
        if (journal.status === 'preparing') { journal.status = 'aborted'; await persist(); throw e; }
        try { await this.restore(journal, game); }
        catch { journal.status = 'recovery-needed'; await persist(); fail('RECOVERY_NEEDED', '操作中断，自动恢复未能完成。备份已保留，请到恢复中心处理；不要手动覆盖文件。'); }
        throw e;
      }
    });
  }
  stagePath(journal, index, restore = false) {
    if (!Number.isInteger(index) || index < 0 || index > 8) fail('JOURNAL_INVALID', '操作序号无效。');
    return path.join(journal.root, `.dlss5-${validId(journal.id)}-${index}${restore ? '-restore' : ''}.tmp`);
  }
  validateJournal(j, game) {
    if (j.schema !== 1 || j.gameId !== game.id || j.root !== path.dirname(game.exe) || !Array.isArray(j.changes) || !j.changes.length || j.changes.length > 8) fail('JOURNAL_INVALID', '恢复记录与当前游戏目录不一致，请保留备份。');
    const kept = j.retainedEnvironment || [];
    if (!Array.isArray(kept) || kept.length > 8 || (kept.length && j.operation !== 'uninstall')) fail('JOURNAL_INVALID', '共用运行环境记录无效。');
    const seen = new Set();
    for (const f of kept) {
      managedFile(f); validHash(f.sha256);
      if (!['reshade-loader', 'nr-runtime'].includes(f.role) || !f.sha256 || seen.has(f.name.toLowerCase()) || !j.beforeInstalled?.files.some(c => c.name === f.name && c.role === f.role && c.sha256 === f.sha256)) fail('JOURNAL_INVALID', '保留文件与原安装记录不一致。');
      seen.add(f.name.toLowerCase());
    }
    for (const c of j.changes) { managedFile(c); validHash(c.before); validHash(c.after); if (seen.has(c.name.toLowerCase())) fail('JOURNAL_INVALID', '恢复记录重复。'); seen.add(c.name.toLowerCase()); }
  }
  async restore(journal, game) {
    this.validateJournal(journal, game);
    await assertGameRoot(journal.root, this.root);
    const env = await this.deps.environment(journal.root, game.exe);
    if (!env.verified || env.running.length) fail('GAME_RUNNING', '无法确认游戏已退出，暂不恢复文件。备份已保留。');
    await this.deps.locks(journal.changes.map(c => path.join(journal.root, c.name)));
    // Retained dependencies were not written by the uninstall; don't reclaim changed files.
    for (const f of journal.retainedEnvironment || []) if (await digestFile(path.join(journal.root, f.name)) !== f.sha256) fail('EXTERNAL_CHANGE', '共用运行环境已被其他工具更改，请保留文件后重新检查。');
    // Verify ALL originals and ALL destinations before restoring any file.
    for (let i = 0; i < journal.changes.length; i++) {
      const c = journal.changes[i], current = await digestFile(path.join(journal.root, c.name));
      if (current !== c.before && current !== c.after) fail('EXTERNAL_CHANGE', '安装后文件被其他程序改动。为避免覆盖新内容，已保留文件和备份，停止自动恢复。');
      if (c.before && await digestFile(this.backupPath({ tx: journal.id, index: i })) !== c.before) fail('BACKUP_DAMAGED', '原文件备份校验失败，不能继续恢复。');
    }
    await this.ensureLifecycleState();
    journal.status = 'restoring'; await atomicJson(this.journalPath(journal.id), journal);
    for (let i = journal.changes.length - 1; i >= 0; i--) {
      const c = journal.changes[i], target = path.join(journal.root, c.name);
      const current = await digestFile(target);
      if (current !== c.before) {
        if (current !== c.after) fail('EXTERNAL_CHANGE', '恢复过程中目标文件发生变化，已停止。');
        if (c.before) {
          const temp = this.stagePath(journal, i, true);
          const existing = await digestFile(temp);
          if (existing && existing !== c.before) fail('STAGE_CHANGED', '恢复临时文件发生变化，已保留。');
          if (!existing) await copyDurable(this.backupPath({ tx: journal.id, index: i }), temp, c.before);
          await assertGameRoot(journal.root, this.root); await noLinks(target);
          if (await digestFile(target) !== c.after) fail('EXTERNAL_CHANGE', '恢复前文件发生变化，已停止。');
          await fs.rename(temp, target);
        } else if (current) { await noLinks(target); await fs.unlink(target); }
      }
      if (await digestFile(target) !== c.before) fail('RESTORE_VERIFY_FAILED', '恢复后的文件校验失败。');
      const stage = this.stagePath(journal, i);
      const staged = await digestFile(stage);
      if (staged) {
        if (staged !== c.after) fail('STAGE_CHANGED', '暂存文件发生变化，已保留供检查。');
        await fs.unlink(stage);
      }
    }
    game.installed = clone(journal.beforeInstalled); await this.save();
    journal.status = 'reverted'; journal.restoredAt = new Date().toISOString();
    await atomicJson(this.journalPath(journal.id), journal);
  }
  async recover(gameId, transactionId) {
    return this.serialize(async () => {
      const game = this.game(gameId), j = await readJson(this.journalPath(transactionId));
      this.validateJournal(j, game);
      if (['reverted', 'aborted'].includes(j.status)) return { alreadyRestored: true };
      const histories = await this.history(gameId);
      const latest = histories.find(x => !['reverted', 'aborted'].includes(x.status));
      if (!latest || latest.id !== j.id) fail('RECOVERY_ORDER', '请先恢复最近一次操作，避免覆盖后续更新。');
      if (j.status === 'committed' && j.operation === 'install' && j.changes.some(c => ['reshade-loader', 'nr-runtime'].includes(c.role) && c.before !== c.after)) {
        const report = await this.deps.scan(game, this.root, { purpose: 'uninstall' });
        const shared = retainedEnvironment(j.afterInstalled?.files || [], report);
        if (shared.some(f => j.changes.some(c => c.name === f.name && c.before !== c.after))) fail('SHARED_ENVIRONMENT', '这次恢复会改动其他插件可能共用的运行环境。请改用“卸载我们的插件”，保留共用环境并撤销 NR。');
      }
      const env = await this.deps.environment(j.root, game.exe);
      if (!env.verified || env.running.length) fail('GAME_RUNNING', '无法确认游戏已关闭。请完全退出游戏后再恢复。');
      await this.deps.locks(j.changes.map(c => path.join(j.root, c.name)));
      if (j.status === 'preparing') { j.status = 'aborted'; await atomicJson(this.journalPath(j.id), j); return { transactionId: j.id }; }
      await this.restore(j, game);
      return { transactionId: j.id };
    });
  }
  async diagnostic() {
    const history = await this.history();
    return redact(JSON.stringify({ managerVersion: require('../../package.json').version, schema: 1, generatedAt: new Date().toISOString(), games: this.state.games.map(g => ({ id: g.id, api: g.api, kind: g.kind, installedVersion: g.installed?.version || null })), packages: this.state.packages.map(p => ({ version: p.manifest.version, hash: p.sourceHash, trust: p.trust })), transactions: history.map(j => ({ id: j.id, gameId: j.gameId, version: j.version, operation: j.operation, createdAt: j.createdAt, status: j.status, errorCode: j.errorCode, files: j.changes.map(c => ({ role: c.role, before: c.before, after: c.after, adopted: c.adopt })) })) }, null, 2), this.state.games.flatMap(g => [g.scanRoot, g.exe]));
  }
}
module.exports = { Engine, allowedFile, copyDurable };
