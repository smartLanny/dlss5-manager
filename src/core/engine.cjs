'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { constants } = require('node:fs');
const { fail, validId, leaf, HASH, noLinks, assertGameRoot, digestFile, durableWrite, atomicJson, readJson, redact } = require('./safety.cjs');
const { scanGame } = require('./scanner.cjs');
const { environment, checkLocks } = require('./platform.cjs');
const { validateManifest } = require('./packages.cjs');
const clone = value => structuredClone(value);
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
    if (this.state.schema !== 1 || !Array.isArray(this.state.games) || !Array.isArray(this.state.packages) || this.state.games.length > 2000 || this.state.packages.length > 1000) fail('STATE_INVALID', '本地管理记录无法读取，未修改任何游戏文件。');
    for (const g of this.state.games) { validId(g.id); if (typeof g.scanRoot !== 'string') fail('STATE_INVALID', '游戏记录已损坏。'); }
    for (const p of this.state.packages) { validId(p.id); validateManifest(p.manifest); }
    return this;
  }
  async save() { await atomicJson(this.stateFile, this.state); }
  game(id) { validId(id); const g = this.state.games.find(g => g.id === id); if (!g) fail('GAME_MISSING', '游戏记录不存在，请重新添加。'); return g; }
  package(id) { validId(id); const p = this.state.packages.find(p => p.id === id); if (!p) fail('PACKAGE_MISSING', '请先导入对应版本的 addon。'); validateManifest(p.manifest); return p; }
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
  async preview(gameId, packageId, operation = 'install') {
    if (!['install', 'uninstall'].includes(operation)) fail('INVALID_OPERATION', '操作类型不支持。');
    const game = this.game(gameId), report = await this.deps.scan(game, this.root);
    const blockers = [...report.blockers];
    if ((await this.pending(gameId)).length) blockers.push('有未完成的操作，请先到恢复中心恢复。');
    const targetRoot = await assertGameRoot(path.dirname(game.exe), this.root);
    const current = game.installed?.files || [];
    for (const f of current) {
      allowedFile(f.name); validHash(f.sha256);
      if (await digestFile(path.join(targetRoot, f.name)) !== f.sha256) blockers.push(`${f.name} 已被其他程序修改或删除，请先处理后再继续。`);
    }
    let pkg = null, desired = [], nextFiles = clone(current);
    if (operation === 'install') {
      pkg = this.package(packageId);
      if (!pkg.manifest.apis.includes(game.api)) blockers.push('导入包声明的 API 与当前游戏选择不一致。');
      if (!game.environmentConfirmed) blockers.push('请先确认支持 Add-on 的 ReShade 与所需 NR runtime 已按教程配置。');
      const existingAddon = current.find(x => x.role === 'addon');
      for (const f of pkg.manifest.files) {
        const name = allowedFile(f.role === 'addon' && existingAddon ? existingAddon.name : f.path);
        const source = path.join(this.root, 'packages', pkg.id, leaf(f.path));
        if (await digestFile(source) !== f.sha256) fail('CACHE_TAMPERED', '本地插件缓存校验失败，请重新导入。');
        desired.push({ name, role: f.role, after: f.sha256, source });
      }
      const addonTarget = desired.find(x => x.role === 'addon').name.toLowerCase();
      const otherAddons = report.files.filter(f => path.dirname(f.path) === targetRoot && /\.addon64$/i.test(f.name) && f.name.toLowerCase() !== addonTarget);
      if (otherAddons.length) blockers.push('同目录存在其他 addon，无法排除重复加载。请先确认或移走旧插件，不会自动删除。');
    } else {
      if (!current.length) fail('NOT_INSTALLED', '此游戏没有管理器拥有的文件，无需卸载。');
      desired = current.map(f => ({ name: allowedFile(f.name), role: f.role, after: f.baselineHash, source: f.baselineHash ? this.backupPath(f.baseline) : null }));
      nextFiles = [];
    }
    const changes = [];
    for (const d of desired) {
      const before = await digestFile(path.join(targetRoot, d.name));
      const owned = current.find(x => x.name.toLowerCase() === d.name.toLowerCase());
      if (d.after) { validHash(d.after); if (await digestFile(d.source) !== d.after) fail('SOURCE_CHANGED', '源文件或原始备份校验失败。'); }
      changes.push({ ...d, before, adopt: !!before && !owned, action: d.after === null ? '移除管理器文件' : before ? '备份并替换' : '新增文件' });
    }
    const id = crypto.randomUUID();
    const plan = { id, gameId, packageId: pkg?.id || null, operation, targetRoot, createdAt: new Date().toISOString(), expires: Date.now() + 5 * 60 * 1000, changes, blockers: [...new Set(blockers)], report, previousInstalled: clone(game.installed || null), nextFiles, fingerprint: JSON.stringify({ exe: game.exe, api: game.api, kind: game.kind, environmentConfirmed: game.environmentConfirmed, installed: game.installed }) };
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
      if (plan.changes.some(c => c.adopt && !consent.adoptNames?.includes(c.name))) fail('ADOPTION_REQUIRED', '需要逐项确认接管并备份现有文件。');
      const game = this.game(plan.gameId);
      if (plan.fingerprint !== JSON.stringify({ exe: game.exe, api: game.api, kind: game.kind, environmentConfirmed: game.environmentConfirmed, installed: game.installed })) fail('PLAN_CHANGED', '游戏配置已变化，请重新预览。');
      const report = await this.deps.scan(game, this.root);
      if (report.blockers.length || (await this.pending(game.id)).length) fail('INSTALL_BLOCKED', report.blockers.join('\n') || '请先恢复未完成操作。');
      await assertGameRoot(plan.targetRoot, this.root);
      await this.deps.locks(plan.changes.map(c => path.join(plan.targetRoot, c.name)));
      for (const c of plan.changes) {
        if (await digestFile(path.join(plan.targetRoot, c.name)) !== c.before) fail('FILE_CHANGED', '预览后文件发生变化，已停止。请重新检查。');
        if (c.after && await digestFile(c.source) !== c.after) fail('SOURCE_CHANGED', '源文件校验失败。');
      }
      const txid = crypto.randomUUID(), dir = this.txDir(txid);
      await noLinks(dir); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const journal = { schema: 1, id: txid, gameId: game.id, root: plan.targetRoot, operation: plan.operation, version: plan.packageId ? this.package(plan.packageId).manifest.version : null, createdAt: new Date().toISOString(), status: 'preparing', beforeInstalled: clone(game.installed || null), afterInstalled: null, changes: plan.changes.map(({ source, ...c }) => c) };
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
            const file = { name: c.name, role: c.role, sha256: c.after, baselineHash: old ? old.baselineHash : c.before, baseline: old ? old.baseline : c.before ? { tx: txid, index: i } : null };
            if (index >= 0) next[index] = file; else next.push(file);
          }
          journal.afterInstalled = { version: journal.version, packageId: plan.packageId, installedAt: new Date().toISOString(), files: next };
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
        return { transactionId: txid, version: journal.version, operation: journal.operation };
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
    const seen = new Set();
    for (const c of j.changes) { allowedFile(c.name); validHash(c.before); validHash(c.after); if (seen.has(c.name.toLowerCase())) fail('JOURNAL_INVALID', '恢复记录重复。'); seen.add(c.name.toLowerCase()); }
  }
  async restore(journal, game) {
    this.validateJournal(journal, game);
    await assertGameRoot(journal.root, this.root);
    const env = await this.deps.environment(journal.root, game.exe);
    if (!env.verified || env.running.length) fail('GAME_RUNNING', '无法确认游戏已退出，暂不恢复文件。备份已保留。');
    await this.deps.locks(journal.changes.map(c => path.join(journal.root, c.name)));
    // Verify ALL originals and ALL destinations before restoring any file.
    for (let i = 0; i < journal.changes.length; i++) {
      const c = journal.changes[i], current = await digestFile(path.join(journal.root, c.name));
      if (current !== c.before && current !== c.after) fail('EXTERNAL_CHANGE', '安装后文件被其他程序改动。为避免覆盖新内容，已保留文件和备份，停止自动恢复。');
      if (c.before && await digestFile(this.backupPath({ tx: journal.id, index: i })) !== c.before) fail('BACKUP_DAMAGED', '原文件备份校验失败，不能继续恢复。');
    }
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
