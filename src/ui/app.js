'use strict';
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state, selectedGame = null, busy = false, filter = 'all', plan = null, launchPlan = null, posterRevision = 0, toastTimer;
const launchInfo = new Map();
const pending = new Set(['preparing','prepared','applying','restoring','recovery-needed']);
const version = v => String(v || '').startsWith('0.0.0-local.') ? '本地更新' : v || '未安装';
const when = v => new Date(v).toLocaleString('zh-CN', { hour12: false });
function toast(message, error = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').className = error ? 'error' : ''; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 11000 : 6500); }
async function api(method, payload) { const r = await window.manager[method](payload); if (!r.ok) { const e = new Error(r.error.message); e.code = r.error.code; throw e; } return r.value; }
async function run(label, fn) {
  if (busy) return; busy = true; $('busyText').textContent = label; $('busyBar').hidden = false; document.body.setAttribute('aria-busy','true');
  try { return await fn(); } catch (e) { toast(e.message || '没有完成，请重试。', true); }
  finally { busy = false; $('busyBar').hidden = true; document.body.removeAttribute('aria-busy'); }
}
window.manager.onProgress(message => { $('busyText').textContent = message; if (busy && $('planDialog').open) { $('confirmApply').textContent = message; $('confirmApply').disabled = true; } });
function showPage(name) {
  if (!['games','versions','recovery','feedback','settings'].includes(name)) return;
  document.querySelectorAll('.page').forEach(p => { p.hidden = p.id !== `page-${name}`; });
  document.querySelectorAll('.nav[data-page]').forEach(n => n.classList.toggle('active', n.dataset.page === name));
  $('main').scrollTop = 0; if (name === 'feedback' && typeof renderFeedbackGames === 'function') renderFeedbackGames();
}
function getGame(id = selectedGame) { return state.games.find(g => g.id === id); }
function getPkg(id) { return state.packages.find(p => p.id === id); }
function preferred(g, slot) { return getPkg(g.preferredPackages?.[slot]); }
function gameStatus(g) {
  if (state.history.some(h => h.gameId === g.id && pending.has(h.status))) return { title:'需要恢复', action:'recover', button:'恢复游戏' };
  if (!g.installed) return { title:'尚未安装', action:'install', button:'安装 DLSS5' };
  if (g.readiness === 'loader-unverified') return { title:'已部署 · 加载情况待验证', action:'detail', button:'查看安装状态' };
  if (g.readiness === 'runtime-missing') return { title:'文件已部署 · 运行组件待补齐', action:'detail', button:'查看安装状态' };
  return { title:`已安装 ${version(g.installed.version)}`, action:'launch', button:'启动游戏' };
}
function cover(g, cls = '') { return `<img class="${cls}" src="app://cover/${esc(g.id)}?v=${posterRevision}" alt="" loading="lazy">`; }
function posterErrors() { document.querySelectorAll('img').forEach(i => { i.onerror = () => { i.hidden = true; }; }); }
async function refresh() {
  state = await api('state'); if (!getGame()) selectedGame = state.games[0]?.id || null;
  $('appVersion').textContent = state.version; $('gameCount').textContent = state.games.length;
  const count = state.history.filter(h => pending.has(h.status)).length; $('recoveryCount').hidden = !count; $('recoveryCount').textContent = count;
  const notes = [];
  if (count) notes.push(`<div class="notice danger">上次有 ${count} 次操作未完成。请先退出游戏，前往 <button class="text-button" data-page="recovery">恢复记录</button>。</div>`);
  if (state.bundleError) notes.push(`<div class="notice danger">${esc(state.bundleError)}</div>`);
  if (state.platform !== 'win32') notes.push('<div class="notice warning">当前为界面预览环境。游戏安装功能在 Windows 中使用。</div>');
  $('globalNotice').innerHTML = notes.join(''); $('globalNotice').hidden = !notes.length;
  $('onlineArtwork').checked = state.preferences.onlineArtwork !== false; $('showHidden').checked = !!state.preferences.showHidden;
  renderGames(); renderVersions(); renderHistory();
  if ($('gameDialog').open && getGame()) renderGameDetail();
  if (typeof renderFeedbackGames === 'function') renderFeedbackGames();
}
function renderGames() {
  const q = $('gameSearch').value.trim().toLowerCase();
  const games = state.games.filter(g => (!g.hidden || state.preferences.showHidden) && g.name.toLowerCase().includes(q) && (filter !== 'installed' || g.installed));
  if (!games.length) { $('gameList').innerHTML = `<div class="empty-state"><div class="symbol">▦</div><h3>${state.games.length ? '没有匹配的游戏' : '你的第一个游戏，从这里开始'}</h3><p>${state.games.length ? '换个关键词，或者显示隐藏的游戏。' : '自动查找 Steam 和 Epic 游戏。其他平台的游戏，点击添加即可。'}</p><button class="button primary" data-action="add">＋ 添加游戏</button></div>`; return; }
  $('gameList').innerHTML = games.map(g => {
    const s = gameStatus(g);
    return `<article class="poster-card" data-game-card="${esc(g.id)}"><button class="poster-open" data-detail="${esc(g.id)}" aria-label="${esc(g.name)} 详情"><span class="poster-fallback">${esc(g.name)}</span>${cover(g)}<span class="poster-label ${g.installed ? 'installed' : ''}">${g.hidden ? '已隐藏' : g.source === 'steam' ? 'STEAM' : g.source === 'epic' ? 'EPIC GAMES' : '本地游戏'}</span></button><div class="card-body"><h3 title="${esc(g.name)}">${esc(g.name)}</h3><p>${esc(s.title)}</p><div class="card-actions"><button class="button ${g.installed ? 'secondary' : 'primary'}" data-game-action="${s.action}" data-game-id="${esc(g.id)}">${s.button}</button><button class="more" data-detail="${esc(g.id)}" aria-label="${esc(g.name)} 更多操作">•••</button></div></div></article>`;
  }).join(''); posterErrors();
}
function renderVersions() {
  $('packageNotice').hidden = !!state.packages.length;
  $('packageNotice').textContent = '这个发行包尚未附带 NR 插件成品。导入装机宅发布的文件后，即可安装与切换版本。';
  $('packageList').innerHTML = state.packages.length ? [...state.packages].reverse().map(p => `<article class="package-row"><span class="symbol">⇄</span><div class="package-info"><h3>${esc(version(p.manifest.version))} <span class="tag ${/beta/i.test(p.manifest.version) ? 'beta' : 'neutral'}">${p.distribution === 'bundled' ? '随包提供' : '本地导入'}</span></h3><p>${esc(when(p.importedAt))} · ${p.manifest.files.length} 个组件文件</p><details><summary>文件详情</summary><p class="hash">${esc(p.sourceHash)}</p><p>兼容性：${p.manifest.apis.length ? esc(p.manifest.apis.join(' / ')) + '，运行待验证' : '未附声明，按自动识别的目标进行测试'}</p></details></div></article>`).join('') : '<div class="empty-state compact"><h3>把官方插件放进来</h3><p>可以一次导入多个版本，之后在游戏详情中选择 A 和 B。</p><button class="button secondary" data-action="import">导入插件 / 更新包</button></div>';
}
function renderHistory() {
  const latest = new Map(); for (const h of state.history) if (!['aborted','reverted'].includes(h.status) && !latest.has(h.gameId)) latest.set(h.gameId,h.id);
  const label = h => h.operation === 'uninstall' ? '卸载本工具安装内容' + (h.keptEnvironmentCount ? ` · 保留 ${h.keptEnvironmentCount} 项共用环境` : '') : h.operation === 'launch-settings' ? '启动图像设置' : version(h.version);
  $('historyList').innerHTML = state.history.length ? state.history.map(h => `<article class="history-row"><span class="symbol">↶</span><div class="history-info"><h3>${esc(getGame(h.gameId)?.name || '游戏')} · ${esc(label(h))}</h3><p>${esc(when(h.createdAt))} · ${pending.has(h.status) ? '需要恢复' : h.status === 'reverted' ? '已恢复' : h.status === 'aborted' ? '未改动游戏' : '操作完成'}</p></div>${latest.get(h.gameId) === h.id ? `<button class="button secondary" data-recover="${esc(h.id)}" data-game-id="${esc(h.gameId)}">恢复这次操作前</button>` : '<span class="muted">记录保留</span>'}</article>`).join('') : '<div class="empty-state"><div class="symbol">↶</div><h3>还没有安装记录</h3><p>安装或换版本后，可以在这里恢复。</p></div>';
}
function selected(value, current) { return value === current ? ' selected' : ''; }
function launchSettingsMarkup(g) {
  const info = launchInfo.get(g.id);
  if (!info) return '<div class="launch-box"><div class="ab-heading"><strong>启动图像设置</strong><span>正在读取…</span></div><p class="muted">设置按游戏和 EXE 分开保存。</p></div>';
  if (info.error) return `<div class="launch-box"><div class="ab-heading"><strong>启动图像设置</strong><span>暂时无法读取</span></div><div class="notice warning">${esc(info.error)}</div></div>`;
  const sr = info.requests.sr?.request || info.applied.sr?.request || { backend:'native', quality:'quality' };
  const defaultFg = info.hardware?.family === 'RTX40' ? 'rtx40' : 'nvidia';
  const fg = info.requests.fg?.request || info.applied.fg?.request || { backend:defaultFg, mode:defaultFg === 'rtx40' ? 'follow' : 'fixed', multiplier:2 };
  const srApplied = info.applied.sr, fgApplied = info.applied.fg;
  const status = (row, saved) => (row ? `已写入 ${row.backend === 'native' ? '原生 SR' : row.backend === 'optiscaler' ? 'OptiScaler SR' : row.backend === 'nvidia' ? 'RTX 50 驱动 FG' : 'RTX 40 社区 MFG'} · 运行待验证` : '尚未由本工具应用') + (saved ? ' · 已保存下次启动' : '');
  return `<div class="launch-box"><div class="ab-heading"><strong>启动图像设置</strong><span>${esc(info.hardware?.family === 'unknown' ? 'GPU 型号未确认' : `检测到 ${info.hardware.family}`)}</span></div><p class="muted">预览和配置读回不代表游戏实际采用。SR 与 FG 独立保存；从管理器点击启动时，Steam 游戏与直接 EXE 使用同一套预处理。</p>
    <section class="launch-domain"><div class="launch-domain-title"><div><strong>超分辨率 SR</strong><small>${esc(status(srApplied,info.requests.sr))}</small></div>${srApplied ? '<button class="text-button" data-launch-restore="sr">恢复之前设置</button>' : ''}</div><div class="launch-grid"><label>后端<select id="srBackend"><option value="native"${selected('native',sr.backend)}>原生 NVIDIA SR（默认）</option><option value="optiscaler"${selected('optiscaler',sr.backend)}>已安装的 OptiScaler</option></select></label><label>画质<select id="srQuality"><option value="game"${selected('game',sr.quality)}>恢复之前设置</option><option value="dlaa"${selected('dlaa',sr.quality)}>DLAA</option><option value="quality"${selected('quality',sr.quality)}>质量</option><option value="balanced"${selected('balanced',sr.quality)}>平衡</option><option value="performance"${selected('performance',sr.quality)}>性能</option><option value="ultraPerformance"${selected('ultraPerformance',sr.quality)}>超级性能</option><option value="custom"${selected('custom',sr.quality)}>自定义比例</option><option value="preserve"${selected('preserve',sr.quality)}>只改模型，保留游戏比例</option></select></label><label id="srPercentField">原生渲染比例 %<input class="full" id="srPercent" type="number" min="34" max="100" step="1" value="${esc(sr.renderPercent ?? 75)}"></label><label id="srPresetField">模型<select id="srPreset"><option value="">保持当前模型</option>${['K','L','M'].map(x=>`<option value="${x}"${selected(x,sr.preset)}>${x}</option>`).join('')}</select></label></div><div class="button-row"><button class="button secondary" data-launch-save="sr">保存到下次启动</button><button class="button primary" data-launch-preview="sr">预览并应用</button></div></section>
    <section class="launch-domain"><div class="launch-domain-title"><div><strong>帧生成 FG / MFG</strong><small>${esc(status(fgApplied,info.requests.fg))}</small></div>${fgApplied ? '<button class="text-button" data-launch-restore="fg">恢复之前设置</button>' : ''}</div><div class="launch-grid"><label>路线<select id="fgBackend"><option value="nvidia"${selected('nvidia',fg.backend)}>RTX 50 官方驱动请求</option><option value="rtx40"${selected('rtx40',fg.backend)}>RTX 40 已安装社区后端</option></select></label><label>模式<select id="fgMode" data-current="${esc(fg.mode)}"></select></label><label id="fgMultiplierField">总帧倍率<input class="full" id="fgMultiplier" type="number" min="2" max="6" step="1" value="${esc(fg.multiplier ?? 2)}"></label><label id="fgTargetField">动态目标 FPS<input class="full" id="fgTarget" type="number" min="0" max="1000" step="1" value="${esc(fg.targetFps ?? 0)}"></label></div><label class="check-row" id="fgExperimentalField"><input id="fgExperimental" type="checkbox"${fg.experimental56 ? ' checked' : ''}>允许社区后端尝试 5X / 6X；仍受已报告安全上限约束</label><p class="muted" id="fgModeNote"></p><div class="button-row"><button class="button secondary" data-launch-save="fg">保存到下次启动</button><button class="button primary" data-launch-preview="fg">预览并应用</button></div></section></div>`;
}
function renderGameDetail() {
  const g = getGame(), a = preferred(g,'A'), b = preferred(g,'B'), status = gameStatus(g);
  const options = chosen => '<option value="">自动选择</option>' + state.packages.map(p => `<option value="${esc(p.id)}"${p.id === chosen?.id ? ' selected' : ''}>${esc(version(p.manifest.version))} · ${p.sourceHash.slice(0,6)}</option>`).join('');
  const apiChoice = g.apiPreference?.exe === g.exe ? g.apiPreference.api : 'auto';
  $('gameDetail').innerHTML = `<div class="detail-hero">${cover(g,'detail-poster')}<div class="detail-title"><h2>${esc(g.name)}</h2><p>${esc(status.title)}</p><span class="tag neutral">${g.api ? `图形 API：${esc(g.api)}${apiChoice === 'auto' ? '（自动）' : '（手动）'}` : 'API 待确认'}</span></div></div><div class="detail-body"><div class="button-row"><button class="button primary" data-game-action="${status.action === 'detail' ? 'install' : status.action}" data-game-id="${esc(g.id)}">${status.action === 'detail' ? '安装 / 补齐组件' : status.button}</button><button class="button secondary" data-feedback-game="${esc(g.id)}">反馈问题</button></div>${g.readiness === 'runtime-missing' ? '<div class="notice warning">插件已部署，但缺少 NR 运行组件，暂不代表能产生画面效果。请导入完整发行包后重新安装。</div>' : ''}<div class="api-choice"><label>游戏图形 API<select id="gameApiChoice"><option value="auto"${selected('auto',apiChoice)}>自动识别</option><option value="DX11"${selected('DX11',apiChoice)}>DirectX 11</option><option value="DX12"${selected('DX12',apiChoice)}>DirectX 12</option><option value="Vulkan"${selected('Vulkan',apiChoice)}>Vulkan</option><option value="OpenGL"${selected('OpenGL',apiChoice)}>OpenGL</option></select></label><p>手动选择只决定管理器使用哪条配置路线，不是运行证据，也不代表兼容性已经验证。</p></div>${launchSettingsMarkup(g)}<div class="ab-box"><div class="ab-heading"><strong>A / B 版本对比</strong><span>退出游戏后切换 · 设置保留</span></div><div class="ab-actions">${[['A',a],['B',b]].map(([slot,p]) => `<button class="ab-button${p && g.installed?.packageId === p.id ? ' current' : ''}" data-slot="${slot}" data-game-id="${esc(g.id)}"${!p ? ' disabled' : ''}><strong>${slot}</strong><span>${esc(version(p?.manifest.version) || '未选择')}<small>${p && g.installed?.packageId === p.id ? '当前版本 · 点击可校验' : '点击切换到这个版本'}</small></span></button>`).join('')}</div><details><summary>更换 A / B 版本</summary><div class="form-grid"><label>A 版本<select id="slotA">${options(a)}</select></label><label>B 版本<select id="slotB">${options(b)}</select></label></div><div class="button-row"><button class="button secondary" id="saveAB">保存选择</button><button class="text-button" data-action="import">导入新的 addon</button></div></details></div><div class="detail-bottom"><button class="text-button" data-game-action="observe" data-game-id="${esc(g.id)}">识别运行中的游戏</button><button class="text-button" data-game-action="details" data-game-id="${esc(g.id)}">高级详情</button><button class="text-button" data-game-action="folder" data-game-id="${esc(g.id)}">打开目录</button><button class="text-button" data-game-action="poster" data-game-id="${esc(g.id)}">更换海报</button><button class="text-button" data-game-action="hide" data-game-id="${esc(g.id)}">${g.hidden ? '显示游戏' : '隐藏游戏'}</button>${g.installed ? `<button class="text-button" data-game-action="uninstall" data-game-id="${esc(g.id)}">卸载我们的插件</button>` : ''}</div></div>`;
  posterErrors();
  if (launchInfo.has(g.id)) syncLaunchFields();
}
async function loadLaunchSettings(id) {
  try { launchInfo.set(id, await api('launch-settings-inspect', { gameId:id })); }
  catch (e) { launchInfo.set(id, { error:e.message }); }
  if (selectedGame === id && $('gameDialog').open) {
    const current = $('gameDetail').querySelector('.launch-box');
    if (current) current.outerHTML = launchSettingsMarkup(getGame(id));
    syncLaunchFields();
  }
}
function openDetail(id) { selectedGame = id; renderGameDetail(); if (!$('gameDialog').open) $('gameDialog').showModal(); void loadLaunchSettings(id); }
function syncLaunchFields() {
  if (!$('srBackend')) return;
  const opti = $('srBackend').value === 'optiscaler';
  if (opti && $('srQuality').value === 'preserve') $('srQuality').value = 'quality';
  $('srQuality').querySelector('option[value="preserve"]').hidden = opti;
  $('srPercent').min = opti ? '33.34' : '33'; $('srPercent').step = opti ? '0.01' : '1';
  $('srPercentField').hidden = $('srQuality').value !== 'custom';
  $('srPresetField').hidden = opti || $('srQuality').value === 'game';
  const community = $('fgBackend').value === 'rtx40', oldMode = $('fgMode').dataset.current || $('fgMode').value;
  const modes = community ? [['restore','恢复之前设置'],['follow','跟随游戏 FG（不是关闭）'],['fixed','固定总倍率'],['dynamic','动态目标']] : [['restore','恢复之前设置'],['off','请求关闭'],['fixed','固定总倍率'],['dynamic','动态目标']];
  $('fgMode').innerHTML = modes.map(([value,label])=>`<option value="${value}"${selected(value,oldMode)}>${label}</option>`).join('');
  if (!$('fgMode').value) $('fgMode').value = community ? 'follow' : 'fixed';
  $('fgMode').dataset.current = $('fgMode').value;
  $('fgMultiplierField').hidden = $('fgMode').value !== 'fixed';
  $('fgTargetField').hidden = $('fgMode').value !== 'dynamic';
  $('fgExperimentalField').hidden = !community || $('fgMode').value !== 'dynamic';
  $('fgModeNote').textContent = community
    ? 'RTX 40 路线只控制已经安装的社区后端。跟随游戏 FG 不等于关闭，也不会为无 FG 游戏新增帧生成。'
    : 'RTX 50 固定或动态模式只是每游戏驱动请求，不要求安装 OptiScaler；游戏与驱动是否采用仍待运行验证。';
}
function launchRequest(domain) {
  if (domain === 'sr') {
    const request = { backend:$('srBackend').value, quality:$('srQuality').value };
    if (request.quality === 'custom') request.renderPercent = Number($('srPercent').value);
    if (request.backend === 'native' && request.quality !== 'game' && $('srPreset').value) request.preset = $('srPreset').value;
    return request;
  }
  const request = { backend:$('fgBackend').value, mode:$('fgMode').value };
  if (request.mode === 'fixed') request.multiplier = Number($('fgMultiplier').value);
  if (request.mode === 'dynamic') { request.targetFps = Number($('fgTarget').value); if (request.backend === 'rtx40') request.experimental56 = $('fgExperimental').checked; }
  return request;
}
function renderLaunchPlan(p) {
  launchPlan = p; const blocked = !!p.blockers?.length;
  $('launchPlanTitle').textContent = p.domain === 'sr' ? '检查超分辨率设置' : '检查帧生成设置';
  const target = p.backend === 'native' ? '原生 NVIDIA SR' : p.backend === 'optiscaler' ? '已安装 OptiScaler' : p.backend === 'nvidia' ? 'RTX 50 驱动 FG 请求' : 'RTX 40 社区 MFG';
  $('launchPlanContent').innerHTML = `<p class="plan-summary"><strong>${esc(getGame(p.gameId)?.name)}</strong> · ${esc(target)}</p><p class="muted">阶段：预览。应用后只确认配置读回，运行时仍未验证。</p>${(p.blockers || []).map(x=>`<div class="notice danger">${esc(x)}</div>`).join('')}${p.warnings?.length ? `<div class="notice warning">${p.warnings.map(x=>`<p>${esc(x)}</p>`).join('')}</div>` : ''}<details><summary>查看变更范围</summary><p>${p.driverSettings?.length ? `${p.driverSettings.length} 个受限的每游戏驱动设置` : p.changes?.length ? p.changes.map(x=>esc(x.name)).join('<br>') : '没有需要写入的变化'}</p></details>${p.noOp ? '<p class="notice">当前配置已经是请求状态。</p>' : ''}`;
  $('applyLaunchPlan').disabled = blocked || !!p.noOp;
  $('saveLaunchPlan').disabled = false;
  $('launchPlanDialog').showModal();
}
async function previewLaunch(domain, request = launchRequest(domain)) { renderLaunchPlan(await api('launch-settings-preview', { gameId:selectedGame, domain, request })); }
async function saveLaunch(domain, request = launchRequest(domain)) { await api('launch-settings-save', { gameId:selectedGame, domain, request }); await refresh(); await loadLaunchSettings(selectedGame); toast('已保存。下次从管理器启动游戏时会先尝试应用。'); }
async function restoreLaunch(domain) {
  const row = launchInfo.get(selectedGame)?.applied?.[domain]; if (!row) return;
  await previewLaunch(domain, domain === 'sr' ? { backend:row.backend, quality:'game' } : { backend:row.backend, mode:'restore' });
}
async function applyLaunchPrepared() {
  if (!launchPlan?.id || launchPlan.blockers?.length || launchPlan.noOp) return;
  const result = await api('launch-settings-apply', { planId:launchPlan.id });
  $('launchPlanDialog').close(); launchPlan = null; await refresh(); await loadLaunchSettings(selectedGame);
  toast(result.applied ? '配置已写入并读回。请启动游戏验证实际效果。' : '当前配置没有变化；运行状态仍待验证。');
}
function closeDialogs() { document.querySelectorAll('dialog[open]').forEach(d => d.close()); }
async function importUpdates() { const result = await api('import'); if (!result) return; await refresh(); toast(`已导入 ${result.length} 个文件。现在可以安装或切换版本。`); }
async function addGame() { const id = await api('add-game'); if (!id) return; selectedGame = id; await refresh(); showPage('games'); toast('游戏已添加，运行方式自动识别。'); }
async function applyPrepared() {
  if (!plan?.id || plan.blockers?.length) return;
  const chosen = [...$('planContent').querySelectorAll('.adopt-check:checked')].map(x => x.dataset.name);
  const consent = { confirm: true, compatibility: true, downgrade: true, adoptNames: chosen, riskCodes: (plan.riskWarnings || []).map(w => w.code) };
  try {
    const result = await api('apply', { planId: plan.id, consent });
    closeDialogs();
    toast(result.noOp ? '当前版本已检查，无需重复安装。' : result.readiness === 'runtime-missing' ? '插件文件已部署，仍需补齐 NR 运行组件。' : result.readiness === 'loader-unverified' ? '插件已部署，现有加载器保持原样。请在游戏内确认是否生效。' : '已安装。启动游戏验证效果，有问题可恢复上一版。');
  } finally { plan = null; $('confirmApply').disabled = true; await refresh(); }
}
async function prepare(id, slot) {
  selectedGame = id; closeDialogs();
  const p = await api('prepare', { gameId: id, ...(slot ? { slot } : {}) });
  if (p.kind === 'need-package') { showPage('versions'); toast('先导入装机宅发布的插件成品；不用填写 API 或校验值。'); return; }
  plan = p; $('planTitle').textContent = p.noOp ? '检查当前版本' : slot ? `切换到 ${slot} 版本` : '安装 DLSS5';
  const blocked = p.kind === 'blocked' || p.blockers?.length;
  $('confirmApply').hidden = !!blocked; $('confirmApply').disabled = !!blocked;
  const warnings = p.riskWarnings || [];
  $('planContent').innerHTML = blocked ? `<div class="notice warning">${(p.messages || p.blockers).map(esc).join('<br>')}</div><p class="muted">没有继续覆盖游戏文件。可以处理后重试，或生成反馈。</p>${p.driftFiles?.length && p.driftFiles.every(f=>f.capturable) ? `<button class="button secondary" data-capture-game="${esc(id)}">保存当前 addon 为本地版本</button>` : ''}${p.waitable ? `<button class="button secondary" data-wait-game="${esc(id)}" data-wait-slot="${esc(slot || '')}">等待游戏退出后重试</button>` : ''}` :
    `<p class="plan-summary"><strong>${esc(getGame(id).name)}</strong> · ${esc(p.label || version(p.version))}${p.transition === 'downgrade' ? '（切回较早版本）' : ''}</p><p class="muted">${p.noOp ? '内容相同，仅检查，不重复备份。' : '自动备份后安装，现有游戏设置保持不变。'}</p>${warnings.length ? `<div class="notice warning">${warnings.map(w => `<p>${esc(w.message)}</p>`).join('')}</div>` : ''}${p.changes.filter(c => c.adopt).map(c => `<label class="check-row"><input type="checkbox" class="adopt-check" data-name="${esc(c.name)}">备份并接管已有的 ${esc(c.name)}</label>`).join('')}<details class="plan-files"><summary>查看本次文件变更（${p.changes.length}）</summary>${p.changes.map(c => `<p><strong>${esc(c.name)}</strong> · ${esc(c.action)}</p>`).join('')}${(p.retainedFiles || []).map(c => `<p>${esc(c.name)} · 保留</p>`).join('')}<p class="path">${esc(p.targetRoot)}</p></details><p class="muted">安装不等于已验证画面效果；异常时可恢复。</p>`;
  $('confirmApply').textContent = p.noOp ? '检查当前版本' : p.transition === 'downgrade' ? '确认切回这个版本' : warnings.length ? '已了解提醒，备份并继续' : '备份并安装';
  syncConsent();
  // A/B repeats need no repeated warning wizard; current ownership/hash checks still execute.
  if (!blocked && !p.changes.some(c => c.adopt) && (p.noOp || slot) && (!warnings.length || p.acknowledged)) { await applyPrepared(); return; }
  $('planDialog').showModal();
}
function syncConsent() { $('confirmApply').disabled = !plan?.id || !!plan.blockers?.length || [...$('planContent').querySelectorAll('.adopt-check')].some(c => !c.checked); }
function reportDetails(r) {
  $('detailsContent').innerHTML = `<p class="path">${esc(r.targetRoot)}</p><p>运行方式：${esc(r.exe?.apis?.join(' / ') || getGame()?.api || '待识别')} · ${esc(r.exe?.arch || '')}</p>${r.blockers.map(x => `<div class="notice danger">${esc(x)}</div>`).join('')}${(r.riskWarnings || []).map(x => `<p class="notice warning">${esc(x.message)}</p>`).join('')}${r.files.map(f => `<details class="file-detail"><summary>${esc(f.relative)} · ${esc(f.source)}</summary><p class="path">${esc(f.path)}</p><p>架构 ${esc(f.arch)} · 版本 ${esc(f.version)}</p><p>签名 ${esc(f.signature)} · ${esc(f.signer)}</p><p>归属 ${esc(f.ownership)} · ${esc(f.shared)}</p><p class="hash">SHA-256 ${esc(f.sha256)}</p><p>静态依赖：${esc(f.imports.join(', ') || '未取得')}</p></details>`).join('')}`;
  $('detailsDialog').showModal();
}
async function gameAction(action, id) {
  if (action === 'detail') { openDetail(id); return; }
  selectedGame = id;
  return run(action === 'install' ? '正在准备安装' : '正在处理', async () => {
    if (action === 'install') return prepare(id);
    if (action === 'launch') return api('launch', { gameId:id });
    if (action === 'recover') { await api('recover', { gameId:id }); await refresh(); return; }
    if (action === 'observe') { const result = await api('observe', { gameId:id }); await refresh(); toast(result.message); return; }
    if (action === 'folder') return api('open-game-folder', { gameId:id });
    if (action === 'hide') { await api('hide-game', { gameId:id, hidden: !getGame(id).hidden }); closeDialogs(); await refresh(); return; }
    if (action === 'poster') { if (await api('poster', { gameId:id })) { posterRevision++; await refresh(); } return; }
    if (action === 'details') { const r = await api('details', { gameId:id }); reportDetails(r); return; }
    if (action === 'uninstall') { const result = await api('uninstall', { gameId:id }); if (result) toast(result.uninstall?.message || '已撤销本工具的安装改动。'); await refresh(); }
  });
}
document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.disabled || busy) return;
  if (b.dataset.close) { $(b.dataset.close).close(); return; }
  if (b.dataset.page) { showPage(b.dataset.page); return; }
  if (b.dataset.link) { return run('正在打开官方页面', () => api('open-link', { key:b.dataset.link })); }
  if (b.dataset.filter) { filter=b.dataset.filter; document.querySelectorAll('.filter').forEach(x=>x.classList.toggle('active',x.dataset.filter===filter)); renderGames(); return; }
  if (b.dataset.detail) { openDetail(b.dataset.detail); return; }
  if (b.dataset.launchSave) return run('正在保存启动设置',()=>saveLaunch(b.dataset.launchSave));
  if (b.dataset.launchPreview) return run('正在生成设置预览',()=>previewLaunch(b.dataset.launchPreview));
  if (b.dataset.launchRestore) return run('正在准备恢复设置',()=>restoreLaunch(b.dataset.launchRestore));
  if (b.dataset.slot) return run('正在准备切换版本', () => prepare(b.dataset.gameId,b.dataset.slot));
  if (b.dataset.gameAction) return gameAction(b.dataset.gameAction,b.dataset.gameId);
  if (b.dataset.action === 'add') return run('正在添加游戏',addGame);
  if (b.dataset.action === 'import') return run('正在导入插件',importUpdates);
  if (b.dataset.recover) return run('正在恢复', async()=>{await api('recover',{gameId:b.dataset.gameId,transactionId:b.dataset.recover});await refresh();});
  if (b.id === 'saveAB') return run('正在保存版本选择',async()=>{await api('assign-ab',{gameId:selectedGame,a:$('slotA').value,b:$('slotB').value});await refresh();toast('A / B 版本已保存，点击对应按钮切换。');});
  if (b.dataset.captureGame) return run('正在保存当前版本',async()=>{if(await api('capture-addon',{gameId:b.dataset.captureGame})){closeDialogs();await refresh();toast('当前 addon 已保存。现在可以重新选择 A 或 B，不会丢失外部版本。');}});
  if (b.dataset.waitGame) return run('正在等待游戏退出',async()=>{ closeDialogs(); $('cancelWait').hidden=false; try { const result=await api('wait-game',{gameId:b.dataset.waitGame}); if(result.ready)await prepare(b.dataset.waitGame,b.dataset.waitSlot||undefined); } finally { $('cancelWait').hidden=true; } });
});
$('addGame').addEventListener('click',()=>run('正在添加游戏',addGame));
$('importUpdate').addEventListener('click',()=>run('正在导入插件',importUpdates));
$('gameSearch').addEventListener('input',()=>state&&renderGames());
$('scanLibrary').addEventListener('click',()=>run('正在查找游戏',async()=>{const r=await api('scan-library');await refresh();if(r)toast(`找到 ${r.total} 个游戏，新增 ${r.added} 个。`);}));
$('steamFolder').addEventListener('click',()=>run('正在选择游戏库',async()=>{await api('scan-library',{chooseFolder:true});await refresh();}));
$('confirmApply').addEventListener('click',()=>run('正在备份并安装',applyPrepared));
$('saveLaunchPlan').addEventListener('click',()=>run('正在保存启动设置',async()=>{if(!launchPlan)return;const p=launchPlan;$('launchPlanDialog').close();await saveLaunch(p.domain,p.request);launchPlan=null;}));
$('applyLaunchPlan').addEventListener('click',()=>run('正在备份并应用设置',applyLaunchPrepared));
$('planContent').addEventListener('change',syncConsent);
$('gameDetail').addEventListener('change',e=>{
  if (e.target.id === 'gameApiChoice') return run('正在保存图形 API',async()=>{await api('set-game-api',{gameId:selectedGame,api:e.target.value});await refresh();await loadLaunchSettings(selectedGame);toast(e.target.value==='auto'?'已恢复自动识别；未知时会显示 API 待确认。':'已保存手动选择；这不代表运行或兼容性已经验证。');});
  if (['srBackend','srQuality','fgBackend','fgMode'].includes(e.target.id)) { if(e.target.id==='fgMode')e.target.dataset.current=e.target.value; syncLaunchFields(); }
});
$('cancelWait').addEventListener('click',()=>api('cancel-wait').catch(e=>toast(e.message,true)));
for(const id of ['onlineArtwork','showHidden'])$(id).addEventListener('change',()=>run('正在保存设置',async()=>{await api('preferences',{onlineArtwork:$('onlineArtwork').checked,showHidden:$('showHidden').checked});await refresh();}));
$('exportLog').addEventListener('click',()=>run('正在保存诊断',async()=>{if(await api('export'))toast('诊断已保存到本机。');}));
$('checkUpdates').addEventListener('click',()=>run('正在检查更新',async()=>{const r=await api('check-updates');$('updateContent').innerHTML=`<p>${r.current?'当前没有更新版本':`可用版本 ${esc(r.version)}`}</p><pre class="report-text">${esc(r.notes)}</pre>`;$('updateDialog').showModal();}));
for(const d of document.querySelectorAll('dialog'))d.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
run('正在读取游戏库',async()=>{await refresh();if(state.platform==='win32'&&!state.games.length){await api('scan-library');await refresh();}});
