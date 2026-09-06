'use strict';
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state, selectedGame = null, draftPackageId = null, busy = false, filter = 'all', plan = null, posterRevision = 0, toastTimer;
const pending = new Set(['preparing', 'prepared', 'applying', 'restoring', 'recovery-needed']);
const version = v => String(v || '').startsWith('0.0.0-local.') ? '本地版本' : v || '未安装';
const when = v => new Date(v).toLocaleString('zh-CN', { hour12: false });
const language = p => p?.language === 'en' ? 'English' : '简体中文';
function supportsGpu(p) { const families = p?.hardwareFamilies || []; const family = state?.gpu?.family; return !families.length || !family || family === 'unknown' || families.includes(family) || families.includes('RTX20-30') && ['RTX20', 'RTX30'].includes(family); }
function visiblePackageRows(rows) { const byLanguage = new Map(); for (const p of rows) { const key = p.language || 'zh-CN', old = byLanguage.get(key); if (!old || supportsGpu(p) && !supportsGpu(old)) byLanguage.set(key, p); } return [...byLanguage.values()]; }
function packageNote(v) { return v === '0.2.0-beta.2' ? '支持 2K27；可在游戏详情中保存并切换。' : v === '0.3.3.4' ? '支持燕云十六声；默认稳定版本，可在游戏详情中保存并切换。' : '可在游戏详情中直接切换；失败时自动恢复旧版本。'; }
function toast(message, error = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').className = error ? 'error' : ''; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 11000 : 6500); }
async function api(method, payload) { const r = await window.manager[method](payload); if (!r.ok) { const e = new Error(r.error.message); e.code = r.error.code; throw e; } return r.value; }
async function run(label, fn) {
  if (busy) return; busy = true; $('busyText').textContent = label; $('busyBar').hidden = false; document.body.setAttribute('aria-busy', 'true');
  try { return await fn(); } catch (e) { toast(e.message || '没有完成，请重试。', true); }
  finally { busy = false; $('busyBar').hidden = true; document.body.removeAttribute('aria-busy'); }
}
window.manager.onProgress(message => { $('busyText').textContent = message; if (busy && $('planDialog').open) { $('confirmApply').textContent = message; $('confirmApply').disabled = true; } });
function showPage(name) {
  if (!['games', 'versions', 'recovery', 'feedback', 'settings'].includes(name)) return;
  document.querySelectorAll('.page').forEach(p => { p.hidden = p.id !== `page-${name}`; });
  document.querySelectorAll('.nav[data-page]').forEach(n => n.classList.toggle('active', n.dataset.page === name));
  $('main').scrollTop = 0; if (name === 'feedback' && typeof renderFeedbackGames === 'function') renderFeedbackGames();
}
function getGame(id = selectedGame) { return state.games.find(g => g.id === id); }
function getPkg(id) { return state.packages.find(p => p.id === id); }
function selectedPackage(g) { return getPkg(g?.selectedPackageId) || state.packages.find(p => p.id === g?.installed?.packageId) || state.packages.find(p => p.manifest?.version === '0.3.3.4') || state.packages[0]; }
function gameStatus(g) {
  if (state.history.some(h => h.gameId === g.id && pending.has(h.status))) return { title: '需要恢复', action: 'recover', button: '恢复上次操作' };
  if (!g.installed) return { title: '尚未安装', action: 'install', button: '一键安装' };
  if (g.readiness === 'loader-unverified') return { title: `已安装 ${version(g.installed.version)} · 加载情况待验证`, action: 'detail', button: '查看安装状态' };
  return { title: `已安装 ${version(g.installed.version)}`, action: 'launch', button: '启动游戏' };
}
function cover(g, cls = '') { return `<img class="${cls}" src="app://cover/${esc(g.id)}?v=${posterRevision}" alt="" loading="lazy">`; }
function posterErrors() { document.querySelectorAll('img').forEach(i => { i.onerror = () => { i.hidden = true; }; }); }
async function refresh() {
  state = await api('state'); if (!getGame()) selectedGame = state.games[0]?.id || null;
  $('appVersion').textContent = `Beta ${state.version}`; $('gameCount').textContent = state.games.length;
  const count = state.history.filter(h => pending.has(h.status)).length; $('recoveryCount').hidden = !count; $('recoveryCount').textContent = count;
  const notes = [];
  if (count) notes.push(`<div class="notice danger">上次操作没有完成。请先退出游戏，前往 <button class="text-button" data-page="recovery">恢复记录</button>。</div>`);
  if (state.bundleError) notes.push(`<div class="notice danger">${esc(state.bundleError)}</div>`);
  if (state.platform !== 'win32') notes.push('<div class="notice warning">当前为界面预览环境。游戏安装功能只在 Windows 中使用。</div>');
  $('globalNotice').innerHTML = notes.join(''); $('globalNotice').hidden = !notes.length;
  $('onlineArtwork').checked = state.preferences.onlineArtwork !== false; $('showHidden').checked = !!state.preferences.showHidden;
  const gpu = state.gpu; $('gpuSummary').textContent = gpu?.family && gpu.family !== 'unknown' ? `${gpu.family} · ${gpu.source === 'user-selected' ? '高级设置' : '自动识别'}` : '安装时自动识别';
  renderGames(); renderVersions(); renderHistory(); $('gpuProfile').value = state.gpu?.profileId || 'rtx50';
  if ($('gameDialog').open && getGame()) renderGameDetail();
  if (typeof renderFeedbackGames === 'function') renderFeedbackGames();
}
function renderGames() {
  const q = $('gameSearch').value.trim().toLowerCase();
  const games = state.games.filter(g => (!g.hidden || state.preferences.showHidden) && g.name.toLowerCase().includes(q) && (filter !== 'installed' || g.installed));
  if (!games.length) { $('gameList').innerHTML = `<div class="empty-state"><div class="symbol">▦</div><h3>${state.games.length ? '没有匹配的游戏' : '你的第一个游戏，从这里开始'}</h3><p>${state.games.length ? '换个关键词，或者显示隐藏的游戏。' : '打开软件会自动查找 Steam 和 Epic 游戏；其他游戏也可以直接添加。'}</p><button class="button primary" data-action="add">＋ 添加游戏</button></div>`; return; }
  $('gameList').innerHTML = games.map(g => {
    const s = gameStatus(g), apiName = g.api || '图形 API 识别中';
    return `<article class="poster-card" data-game-card="${esc(g.id)}"><button class="poster-open" data-detail="${esc(g.id)}" aria-label="${esc(g.name)} 详情"><span class="poster-fallback">${esc(g.name)}</span>${cover(g)}<span class="poster-label ${g.installed ? 'installed' : ''}">${g.hidden ? '已隐藏' : g.source === 'steam' ? 'STEAM' : g.source === 'epic' ? 'EPIC GAMES' : '本地游戏'}</span></button><div class="card-body"><h3 title="${esc(g.name)}">${esc(g.name)}</h3><p>${esc(apiName)} · ${esc(s.title)}</p><div class="card-actions"><button class="button ${g.installed ? 'secondary' : 'primary'}" data-game-action="${s.action}" data-game-id="${esc(g.id)}">${s.button}</button><button class="more" data-detail="${esc(g.id)}" aria-label="${esc(g.name)} 更多操作">•••</button></div></div></article>`;
  }).join(''); posterErrors();
}
function renderVersions() {
  $('packageNotice').hidden = !!state.packages.length;
  $('packageNotice').textContent = '默认版本会随安装器准备；导入新的 addon 后，它会自动出现在游戏详情的版本列表。';
  const grouped = new Map(); for (const p of state.packages) { const k = p.manifest.version; if (!grouped.has(k)) grouped.set(k, []); grouped.get(k).push(p); }
  $('packageList').innerHTML = state.packages.length ? [...grouped.entries()].sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true })).map(([v, rows]) => `<article class="package-row"><span class="symbol">✦</span><div class="package-info"><h3>装机宅 ${esc(version(v))} ${v === '0.3.3.4' ? '<span class="tag">默认稳定</span>' : '<span class="tag neutral">可切换</span>'}</h3><p>${rows.map(language).join(' / ')} · ${rows[0].distribution === 'bundled' ? '安装器内置' : '本地导入'} · ${esc(when(rows[0].importedAt))}</p><details><summary>版本说明</summary><p>${esc(packageNote(v))}</p></details></div></article>`).join('') : '<div class="empty-state compact"><h3>还没有其他版本</h3><p>导入装机宅发布的 addon，版本会自动识别，不需要填写参数。</p><button class="button secondary" data-action="import">导入新版本</button></div>';
}
function renderHistory() {
  const latest = new Map(); for (const h of state.history) if (!['aborted', 'reverted'].includes(h.status) && !latest.has(h.gameId)) latest.set(h.gameId, h.id);
  $('historyList').innerHTML = state.history.length ? state.history.map(h => `<article class="history-row"><span class="symbol">↶</span><div class="history-info"><h3>${esc(getGame(h.gameId)?.name || '游戏')} · ${h.operation === 'uninstall' ? '卸载装机宅插件' : h.operation === 'capture-external' ? '保存本地版本' : esc(version(h.version))}</h3><p>${esc(when(h.createdAt))} · ${pending.has(h.status) ? '需要恢复' : h.status === 'reverted' ? '已恢复' : h.status === 'aborted' ? '未改动游戏' : '操作完成'}</p></div>${latest.get(h.gameId) === h.id ? `<button class="button secondary" data-recover="${esc(h.id)}" data-game-id="${esc(h.gameId)}">恢复这次操作前</button>` : '<span class="muted">记录保留</span>'}</article>`).join('') : '<div class="empty-state"><div class="symbol">↶</div><h3>还没有安装记录</h3><p>安装或换版本后，可以在游戏详情中恢复。</p></div>';
}
function packageOptions(g) {
  const current = selectedPackage(g)?.id;
  const groups = new Map(); for (const p of state.packages) { const v = p.manifest.version; if (!groups.has(v)) groups.set(v, []); groups.get(v).push(p); }
  return [...groups.entries()].map(([v, rows]) => {
    const note = v === '0.2.0-beta.2' ? '（支持 2K27）' : v === '0.3.3.4' ? '（默认稳定 · 支持燕云十六声）' : '';
    return `<optgroup label="装机宅 ${esc(version(v))}${note}">${visiblePackageRows(rows).map(p => `<option value="${esc(p.id)}"${p.id === current ? ' selected' : ''}>${esc(language(p))}</option>`).join('')}</optgroup>`;
  }).join('');
}
function apiLabel(g) {
  if (!g.api) return '正在自动识别图形 API';
  if (g.api === 'DX12') return `自动识别：DirectX 12（推荐）${g.apiEvidence?.confidence === 'high' ? '' : ' · 依据充分度中等'}`;
  return `自动识别：${g.api} · 当前版本暂未验证`;
}
function renderGameDetail() {
  const g = getGame(), status = gameStatus(g), chosen = getPkg(draftPackageId) || selectedPackage(g), installed = getPkg(g.installed?.packageId), same = !!chosen && !!installed && chosen.id === installed.id;
  const installText = !g.installed ? '一键安装' : same ? '检查当前版本' : '切换到此版本';
  const apiUnsupported = g.api && g.api !== 'DX12';
  $('gameDetail').innerHTML = `<div class="detail-hero">${cover(g, 'detail-poster')}<div class="detail-title"><h2>${esc(g.name)}</h2><p>${esc(status.title)}</p><span class="tag ${apiUnsupported ? 'warning' : 'neutral'}">${esc(apiLabel(g))}</span></div></div><div class="detail-body"><div class="button-row"><button class="button primary" data-game-action="install" data-game-id="${esc(g.id)}" data-package-id="${esc(chosen?.id || '')}"${apiUnsupported ? ' disabled' : ''}>${installText}</button><button class="button secondary" data-feedback-game="${esc(g.id)}">反馈问题</button></div><div class="detail-readiness"><div><small>显卡</small><strong>${esc(g.gpu?.family || state.gpu?.family || '安装时自动识别')}</strong></div><div><small>运行环境</small><strong>${esc(g.runtimeProfile || '按显卡自动准备')}</strong></div><div><small>当前版本</small><strong>${esc(installed ? version(installed.manifest.version) : '尚未安装')}</strong></div></div>${apiUnsupported ? '<div class="notice warning">当前装机宅 NR 版本暂未验证该 API。游戏仍可展示和反馈，但本次不会写入游戏目录。</div>' : ''}${g.readiness === 'loader-unverified' ? '<div class="notice warning">发现已有图形加载环境，已保留原样。插件已安装，但是否能加载仍待验证。</div>' : ''}<div class="version-picker"><label>选择装机宅版本<select id="pluginVersion">${packageOptions(g)}</select></label><p class="muted">同一版本的中英文文件只是语言变体，安装器会把它们视为同一个版本。</p></div><div class="detail-bottom"><button class="text-button" data-game-action="recover-last" data-game-id="${esc(g.id)}"${!g.installed ? ' disabled' : ''}>恢复上次操作</button><button class="text-button danger" data-game-action="uninstall" data-game-id="${esc(g.id)}"${!g.installed ? ' disabled' : ''}>卸载装机宅插件</button><button class="text-button" data-game-action="recover-original" data-game-id="${esc(g.id)}"${!g.installed ? ' disabled' : ''}>恢复安装前状态</button><button class="text-button" data-game-action="observe" data-game-id="${esc(g.id)}">重新识别</button><button class="text-button" data-game-action="details" data-game-id="${esc(g.id)}">高级详情</button><button class="text-button" data-game-action="folder" data-game-id="${esc(g.id)}">打开游戏目录</button><button class="text-button" data-game-action="refresh-artwork" data-game-id="${esc(g.id)}">刷新海报</button><button class="text-button" data-game-action="poster" data-game-id="${esc(g.id)}">更换海报</button><button class="text-button" data-game-action="hide" data-game-id="${esc(g.id)}">${g.hidden ? '显示游戏' : '隐藏游戏'}</button></div></div>`;
  posterErrors();
}
function openDetail(id) { selectedGame = id; draftPackageId = null; renderGameDetail(); if (!$('gameDialog').open) $('gameDialog').showModal(); }
function closeDialogs() { document.querySelectorAll('dialog[open]').forEach(d => d.close()); }
async function importUpdates() { const result = await api('import'); if (!result) return; await refresh(); toast(`已导入 ${result.length} 个版本，现在可以在游戏详情中选择。`); }
async function addGame() { const id = await api('add-game'); if (!id) return; selectedGame = id; await refresh(); showPage('games'); openDetail(id); toast('游戏已添加，运行程序和图形 API 会自动识别。'); }
async function applyPrepared() {
  if (!plan?.id || plan.blockers?.length) return;
  const chosen = [...$('planContent').querySelectorAll('.adopt-check:checked')].map(x => x.dataset.name);
  const consent = { confirm: true, compatibility: true, downgrade: true, adoptNames: chosen, riskCodes: (plan.riskWarnings || []).map(w => w.code) };
  try { const result = await api('apply', { planId: plan.id, consent }); if ($('planDialog').open) $('planDialog').close(); toast(result.noOp ? '当前版本已检查，无需重复写入。' : '已完成。原文件已自动保存，遇到问题可在游戏详情中恢复。'); }
  finally { plan = null; $('confirmApply').disabled = true; await refresh(); }
}
async function prepare(id, packageId) {
  selectedGame = id; if ($('planDialog').open) $('planDialog').close(); const p = await api('prepare', { gameId: id, ...(packageId ? { packageId } : {}) });
  if (p.kind === 'need-package') { showPage('versions'); toast('请先导入装机宅发布的 addon；不用填写 API、SHA 或路径。'); return; }
  plan = p; $('planTitle').textContent = p.noOp ? '检查当前版本' : p.transition === 'downgrade' ? '切换到较早版本' : '一键准备安装';
  const blocked = p.kind === 'blocked' || p.kind === 'needs-gpu' || p.blockers?.length;
  $('confirmApply').hidden = !!blocked; $('confirmApply').disabled = !!blocked;
  const warnings = p.riskWarnings || [], messages = p.messages || p.blockers || [];
  $('planContent').innerHTML = blocked ? `<div class="notice warning">${messages.map(esc).join('<br>')}</div><p class="muted">没有写入游戏目录。处理提醒后可以重新尝试。</p>${p.kind === 'needs-gpu' ? '<p class="muted">可在“设置与帮助 → 高级选项”中选择已确认的运行环境。</p>' : ''}${p.waitable ? `<button class="button secondary" data-wait-game="${esc(id)}">等待游戏退出后重试</button>` : ''}` : `<p class="plan-summary"><strong>${esc(getGame(id).name)}</strong> · ${esc(p.label || version(p.version))}</p><p class="muted">${p.noOp ? '内容相同，仅检查，不重复备份。' : `已识别 ${esc(p.gpu?.family || '显卡')}，会先准备运行环境，再一次性备份并安装。`}</p>${warnings.length ? `<div class="notice warning">${warnings.map(w => `<p>${esc(w.message)}</p>`).join('')}</div>` : ''}${p.changes.filter(c => c.adopt).map(c => `<label class="check-row"><input type="checkbox" class="adopt-check" data-name="${esc(c.name)}">备份并接管已有的 ${esc(c.name)}</label>`).join('')}<details class="plan-files"><summary>查看本次文件变更（${p.changes.length}）</summary>${p.changes.map(c => `<p><strong>${esc(c.name)}</strong> · ${esc(c.action)}</p>`).join('')}${(p.retainedFiles || []).map(c => `<p>${esc(c.name)} · 保留</p>`).join('')}</details><p class="muted">不会删除存档、设置或无法确认来源的其他模组。</p>`;
  $('confirmApply').textContent = p.noOp ? '检查当前版本' : p.transition === 'downgrade' ? '确认切换' : '备份并安装'; syncConsent();
  if (!blocked && !p.changes.some(c => c.adopt) && (p.noOp || p.acknowledged) && !warnings.length) { await applyPrepared(); return; }
  $('planDialog').showModal();
}
function syncConsent() { $('confirmApply').disabled = !plan?.id || !!plan.blockers?.length || [...$('planContent').querySelectorAll('.adopt-check')].some(c => !c.checked); }
function reportDetails(r) {
  $('detailsContent').innerHTML = `<p class="path">${esc(r.targetRoot)}</p><p>图形 API：${esc(r.exe?.apis?.join(' / ') || getGame()?.api || '待识别')} · ${esc(r.exe?.arch || '')}</p>${r.blockers.map(x => `<div class="notice danger">${esc(x)}</div>`).join('')}${(r.riskWarnings || []).map(x => `<p class="notice warning">${esc(x.message)}</p>`).join('')}${r.files.map(f => `<details class="file-detail"><summary>${esc(f.relative)} · ${esc(f.source)}</summary><p class="path">${esc(f.path)}</p><p>架构 ${esc(f.arch)} · 版本 ${esc(f.version)}</p><p>签名 ${esc(f.signature)} · ${esc(f.signer)}</p><p>归属 ${esc(f.ownership)} · ${esc(f.shared)}</p><p class="hash">SHA-256 ${esc(f.sha256)}</p><p>静态依赖：${esc(f.imports.join(', ') || '未取得')}</p></details>`).join('')}`; $('detailsDialog').showModal();
}
async function recoverOriginal(id) { const result = await api('recover-original', { gameId: id }); await refresh(); toast(result?.count ? '已恢复安装前状态。' : '没有需要恢复的安装记录。'); }
async function gameAction(action, id, packageId) {
  if (action === 'detail') { openDetail(id); return; } selectedGame = id;
  return run(action === 'install' ? '正在准备安装' : '正在处理', async () => {
    if (action === 'install') return prepare(id, packageId || $('pluginVersion')?.value);
    if (action === 'launch') return api('launch', { gameId: id });
    if (action === 'recover' || action === 'recover-last') { await api('recover', { gameId: id }); await refresh(); toast('已恢复上次操作。'); return; }
    if (action === 'recover-original') return recoverOriginal(id);
    if (action === 'observe') { const result = await api('observe', { gameId: id }); await refresh(); toast(result.message); return; }
    if (action === 'folder') return api('open-game-folder', { gameId: id });
    if (action === 'hide') { await api('hide-game', { gameId: id, hidden: !getGame(id).hidden }); closeDialogs(); await refresh(); return; }
    if (action === 'poster') { if (await api('poster', { gameId: id })) { posterRevision++; await refresh(); } return; }
    if (action === 'refresh-artwork') { if (await api('refresh-artwork', { gameId: id })) { posterRevision++; await refresh(); toast('海报已刷新。'); } else toast('暂时找不到可靠海报，已保留占位图。'); return; }
    if (action === 'details') { const r = await api('details', { gameId: id }); reportDetails(r); return; }
    if (action === 'uninstall') { const result = await api('uninstall', { gameId: id }); if (result) toast(result.uninstall?.message || '已卸载装机宅插件。'); await refresh(); }
  });
}
document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.disabled || busy) return;
  if (b.dataset.close) { $(b.dataset.close).close(); return; }
  if (b.dataset.page) { showPage(b.dataset.page); return; }
  if (b.dataset.link) return run('正在打开官方页面', () => api('open-link', { key: b.dataset.link }));
  if (b.dataset.filter) { filter = b.dataset.filter; document.querySelectorAll('.filter').forEach(x => x.classList.toggle('active', x.dataset.filter === filter)); renderGames(); return; }
  if (b.dataset.detail) { openDetail(b.dataset.detail); return; }
  if (b.dataset.gameAction) return gameAction(b.dataset.gameAction, b.dataset.gameId, b.dataset.packageId);
  if (b.dataset.action === 'add') return run('正在添加游戏', addGame);
  if (b.dataset.action === 'import') return run('正在导入插件', importUpdates);
  if (b.dataset.recover) return run('正在恢复', async () => { await api('recover', { gameId: b.dataset.gameId, transactionId: b.dataset.recover }); await refresh(); });
  if (b.dataset.waitGame) return run('正在等待游戏退出', async () => { closeDialogs(); $('cancelWait').hidden = false; try { const result = await api('wait-game', { gameId: b.dataset.waitGame }); if (result.ready) await prepare(b.dataset.waitGame); } finally { $('cancelWait').hidden = true; } });
});
$('addGame').addEventListener('click', () => run('正在添加游戏', addGame)); $('importUpdate').addEventListener('click', () => run('正在导入插件', importUpdates)); $('gameSearch').addEventListener('input', () => state && renderGames());
$('scanLibrary').addEventListener('click', () => run('正在扫描游戏并补充海报', async () => { const r = await api('scan-library'); await refresh(); if (r) toast(`扫描完成：找到 ${r.total} 个游戏，新增 ${r.added} 个。`); }));
$('steamFolder').addEventListener('click', () => run('正在选择游戏库', async () => { await api('scan-library', { chooseFolder: true }); await refresh(); }));
$('confirmApply').addEventListener('click', () => run('正在备份并安装', applyPrepared)); $('planContent').addEventListener('change', syncConsent); $('cancelWait').addEventListener('click', () => api('cancel-wait').catch(e => toast(e.message, true)));
document.addEventListener('change', e => { if (e.target.id === 'pluginVersion' && selectedGame) { draftPackageId = e.target.value || null; renderGameDetail(); } });
for (const id of ['onlineArtwork', 'showHidden']) $(id).addEventListener('change', () => run('正在保存设置', async () => { await api('preferences', { onlineArtwork: $('onlineArtwork').checked, showHidden: $('showHidden').checked }); await refresh(); }));
$('saveGpuProfile').addEventListener('click', () => run('正在保存显卡选择', async () => { await api('set-gpu-profile', { profileId: $('gpuProfile').value }); await refresh(); toast('已保存高级显卡选择；安装时会使用对应运行环境。'); }));
$('exportLog').addEventListener('click', () => run('正在保存诊断', async () => { if (await api('export')) toast('诊断已保存到本机。'); })); $('checkUpdates').addEventListener('click', () => run('正在检查更新', async () => { const r = await api('check-updates'); $('updateContent').innerHTML = `<p>${r.current ? '当前没有更新版本' : `可用版本 ${esc(r.version)}`}</p><pre class="report-text">${esc(r.notes)}</pre>`; $('updateDialog').showModal(); }));
for (const d of document.querySelectorAll('dialog')) d.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
run('正在读取游戏库', async () => {
  await api('gpu').catch(() => null); await refresh();
  const needsEnrichment = state.games.some(g => (g.steamId || g.source === 'epic') && (!g.source || !g.exe || !g.artwork?.portrait));
  if (state.platform === 'win32' && !window.manager.skipAutoScan && (!state.games.length || needsEnrichment)) { await api('scan-library'); await refresh(); }
});
