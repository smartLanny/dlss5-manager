'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state, selectedGame = null, selectedPackage = null, activePage = 'games', busy = false, activePlan = null, lastReport = null, toastTimer;
const pendingStatuses = new Set(['preparing', 'prepared', 'applying', 'restoring', 'recovery-needed']);
const trustLabels = { 'local-unverified': '本地导入 · 来源未认证', 'checksum-matched': '发布校验值匹配 · 未签名', 'publisher-verified': '发布者签名已验证' };
const statusLabels = { preparing: '备份中断', prepared: '等待恢复', applying: '写入中断', committed: '已完成', restoring: '恢复中断', reverted: '已恢复', aborted: '已停止，未修改游戏', 'recovery-needed': '需要恢复' };
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未提供';
function toast(message, error = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').className = `toast${error ? ' error' : ''}`; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 10000 : 5500); }
async function api(method, payload) {
  if (!window.manager?.[method]) throw new Error('桌面连接未就绪，请重新打开安装器。');
  const response = await window.manager[method](payload);
  if (!response.ok) { const e = new Error(response.error.message); e.code = response.error.code; throw e; }
  return response.value;
}
async function run(label, action) {
  if (busy) return;
  busy = true; $('busyText').textContent = label; $('busyBar').hidden = false;
  document.body.setAttribute('aria-busy', 'true');
  try { return await action(); }
  catch (e) { toast(e.message || '操作未完成，请查看恢复中心。', true); }
  finally { busy = false; $('busyBar').hidden = true; document.body.removeAttribute('aria-busy'); }
}
function game() { return state?.games.find(g => g.id === selectedGame); }
function packageById(id) { return state?.packages.find(p => p.id === id); }
function showPage(name) {
  if (!['games', 'versions', 'recovery', 'feedback', 'about'].includes(name)) return;
  activePage = name;
  for (const page of document.querySelectorAll('.page')) page.hidden = page.id !== `page-${name}`;
  for (const nav of document.querySelectorAll('.nav-item')) nav.classList.toggle('active', nav.dataset.page === name);
  $('pageCrumb').textContent = { games: '游戏库', versions: '插件版本', recovery: '恢复中心', feedback: '反馈与诊断', about: '使用帮助' }[name];
  if (name === 'feedback' && typeof renderFeedbackGames === 'function') renderFeedbackGames();
  $('main').scrollTop = 0;
}
async function refresh() {
  state = await api('state');
  if (!state.games.some(g => g.id === selectedGame)) selectedGame = state.games[0]?.id || null;
  if (!state.packages.some(p => p.id === selectedPackage)) selectedPackage = state.packages.find(p => p.manifest.version === '0.3.3.4')?.id || state.packages.at(-1)?.id || null;
  $('gameCount').textContent = state.games.length; $('libraryCount').textContent = state.games.length;
  $('appVersion').textContent = state.version;
  const pending = state.history.filter(h => pendingStatuses.has(h.status));
  $('recoveryCount').textContent = pending.length; $('recoveryCount').hidden = !pending.length;
  const notices = [];
  if (state.platform !== 'win32') notices.push('<div class="notice warning global-notice"><strong>当前为非 Windows 预览环境</strong><p>可检查界面、导入和版本管理；实际游戏文件安装仅在 Windows 上开放。</p></div>');
  if (pending.length) notices.push(`<div class="notice danger global-notice"><strong>有 ${pending.length} 次操作需要恢复</strong><p>备份已保留，请先退出游戏，再到恢复中心处理。<button class="text-button" data-page="recovery">打开恢复中心 →</button></p></div>`);
  $('globalNotice').innerHTML = notices.join(''); $('globalNotice').hidden = !notices.length;
  renderGames(); renderInstall(); renderVersions(); renderHistory();
  if (typeof renderFeedbackGames === 'function') renderFeedbackGames();
}
function renderGames() {
  const query = $('gameSearch').value.trim().toLowerCase();
  const games = state.games.filter(g => g.name.toLowerCase().includes(query));
  if (!state.games.length) {
    $('gameList').innerHTML = '<div class="empty-state"><div class="empty-symbol" aria-hidden="true">▦</div><h3>从添加第一个游戏开始</h3><p>扫描 Steam 游戏库，或手动选择游戏 EXE。安装前先检查，游戏文件不会被悄悄改动。</p><button class="button secondary" data-action="add-game">手动添加游戏</button></div>'; return;
  }
  if (!games.length) { $('gameList').innerHTML = '<div class="empty-state compact"><h3>没有匹配的游戏</h3><p>换个关键词，或手动添加。</p></div>'; return; }
  $('gameList').innerHTML = games.map(g => `<button class="game-card${g.id === selectedGame ? ' selected' : ''}" data-game="${esc(g.id)}" aria-pressed="${g.id === selectedGame}"><span class="game-art" aria-hidden="true">${esc(g.name.replace(/\s/g, '').slice(0, 2).toUpperCase())}</span><span class="game-name"><strong title="${esc(g.name)}">${esc(g.name)}</strong><small>${esc(g.steamId ? 'Steam' : '手动添加')} · ${esc(g.api || 'API 待确认')} · ${g.installed ? `已安装 ${esc(g.installed.version)}` : '未安装'}</small></span>${g.kind === 'online' ? '<span class="tag danger">高风险</span>' : '<span class="game-arrow" aria-hidden="true">›</span>'}</button>`).join('');
}
function selectOptions(values, value, emptyLabel) { return `${emptyLabel ? `<option value="">${esc(emptyLabel)}</option>` : ''}${values.map(x => `<option value="${esc(x)}"${value === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}`; }
function renderInstall() {
  const g = game();
  if (!g) { $('installContent').innerHTML = '<div class="install-idle"><div class="empty-symbol" aria-hidden="true">↳</div><h3>先选择左侧的游戏</h3><p>这里会显示插件版本、安装位置<br>和每次操作前的安全检查。</p></div><div class="divider"></div><div class="notice neutral"><strong>第一次使用？</strong><p>先按教程配置游戏运行环境。以后换 addon，就在这里完成。</p></div><button class="text-button" data-link="tutorial">查看装机宅官方主页与教程 ↗</button>'; return; }
  const pkgOptions = state.packages.map(p => `<option value="${esc(p.id)}"${p.id === selectedPackage ? ' selected' : ''}>${esc(p.manifest.version)} · ${esc(p.manifest.apis.join('/'))} · ${p.sourceHash.slice(0, 6)}</option>`).join('');
  const gCandidates = g.candidates || [];
  $('installContent').innerHTML = `
    <h3 class="selected-title">${esc(g.name)}</h3><div class="path" title="${esc(g.exe || g.scanRoot)}">${esc(g.exe || g.scanRoot)}</div>
    <div class="inline-actions"><button class="text-button" data-action="choose-exe">${g.exe ? '更换 EXE' : '选择运行 EXE'}</button><button class="text-button" data-action="find-exes">查找候选 EXE</button><button class="text-button" data-action="open-folder">打开目录</button><button class="text-button" data-action="copy-path">复制路径</button></div>
    ${gCandidates.length > 1 || (!g.exe && gCandidates.length) ? `<label class="field-label">确认运行 EXE<select class="full" id="exeCandidate"><option value="">请选择，不会自动猜测</option>${gCandidates.map((c, i) => `<option value="${i}"${c.path === g.exe ? ' selected' : ''}>${esc(c.path.split(/[\\/]/).slice(-3).join('/'))} (${esc(c.arch)} / ${esc(c.apis.join(',') || 'API 未知')})</option>`).join('')}</select></label>` : ''}
    <div class="installed-line"><span class="tag ${g.installed ? '' : 'neutral'}">${g.installed ? `已安装 ${esc(g.installed.version)}` : '尚未安装'}</span><span>运行兼容性：待验证</span></div>
    <label class="field-label">这次安装哪个版本？<select class="full" id="packageSelect"><option value="">${state.packages.length ? '请选择本地版本' : '请先导入官方 addon'}</option>${pkgOptions}</select></label>
    <button class="text-button" data-action="import">＋ 导入群里发布的新 addon</button>
    <div class="form-grid"><label>图形 API<select id="gameApi">${selectOptions(['DX12', 'DX11', 'Vulkan', 'OpenGL'], g.api, '请人工确认')}</select></label><label>游戏类型<select id="gameKind"><option value="unknown"${g.kind === 'unknown' ? ' selected' : ''}>尚未确认</option><option value="offline"${g.kind === 'offline' ? ' selected' : ''}>单机 · 离线</option><option value="online"${g.kind === 'online' ? ' selected' : ''}>在线 / 竞技</option></select></label></div>
    <label class="check-row"><input id="environmentConfirmed" type="checkbox"${g.environmentConfirmed ? ' checked' : ''}><span>已按教程配置 <strong>Add-on 版 ReShade</strong> 和此版本所需的 NR runtime。</span></label>
    <p class="footnote">API 以实际运行模式和插件发布说明为准。检测到反作弊或未知代理冲突会阻止安装。</p>
    <div class="divider"></div><div class="button-row"><button class="button secondary small" data-action="scan"${!g.exe ? ' disabled' : ''}>只做安全检查</button>${g.installed ? '<button class="button subtle small danger-button" data-action="uninstall">卸载并恢复原文件</button>' : '<button class="text-button" data-link="tutorial">查看教程 ↗</button>'}</div>
    <button class="button primary main-action" data-action="preview"${!g.exe || !selectedPackage ? ' disabled' : ''}>${g.installed ? '检查并预览更新' : '检查并预览安装'} <span aria-hidden="true">→</span></button><p class="action-note">先展示文件清单，确认后才会修改。</p><div class="inline-actions"><button class="text-button" data-action="report-problem">报告这个游戏的问题 →</button><button class="text-button" data-link="reshade">ReShade 官方获取入口 ↗</button></div>`;
}
function renderVersions() {
  $('versionCards').innerHTML = state.catalog.map(c => {
    const pkgs = state.packages.filter(p => p.manifest.version === c.version);
    return `<article class="version-card${c.channel === 'stable' ? ' recommended' : ''}"><div class="version-top"><span class="version-channel">${c.channel === 'stable' ? 'STABLE CHANNEL' : 'BETA CHANNEL'}</span><span class="tag${c.channel === 'stable' ? '' : ' neutral'}">${esc(c.badge)}</span></div><div class="version-number">${esc(c.version)}</div><h3>${esc(c.title)}</h3><p>${esc(c.description)}</p><div class="version-state">${pkgs.length ? '● 已导入 ' + pkgs.length + ' 个文件版本' : '○ 待导入官方 addon'} · 兼容性待验证</div><button class="button ${c.channel === 'stable' ? 'primary' : 'secondary'}" data-import-version="${esc(c.version)}">${pkgs.length ? '重新导入 / 更新' : '导入这个版本'}</button></article>`;
  }).join('');
  $('packageList').innerHTML = state.packages.length ? [...state.packages].reverse().map(p => `<article class="package-row"><span class="package-icon" aria-hidden="true">▱</span><div class="package-main"><strong>${esc(p.manifest.version)}</strong><p>${esc(p.manifest.apis.join(' / '))} · x64 · ${esc(trustLabels[p.trust] || '来源待验证')} · ${esc(date(p.importedAt))}</p><p class="path">SHA-256 ${esc(p.sourceHash)}</p></div><button class="button secondary small" data-use-package="${esc(p.id)}">选择此版本</button></article>`).join('') : '<div class="empty-state compact"><div class="empty-symbol" aria-hidden="true">▱</div><h3>插件库还是空的</h3><p>导入一次，可为多个游戏重复使用。群里发布新 addon 后，再导入新版本即可。</p></div>';
}
function renderHistory() {
  if (!state.history.length) { $('historyList').innerHTML = '<div class="empty-state"><div class="empty-symbol" aria-hidden="true">↶</div><h3>还没有需要恢复的操作</h3><p>第一次安装后，文件备份和操作记录会出现在这里。</p></div>'; return; }
  const latest = new Map();
  for (const h of state.history) if (!['aborted', 'reverted'].includes(h.status) && !latest.has(h.gameId)) latest.set(h.gameId, h.id);
  $('historyList').innerHTML = state.history.map(h => {
    const g = state.games.find(g => g.id === h.gameId), pending = pendingStatuses.has(h.status), canRecover = latest.get(h.gameId) === h.id;
    return `<article class="history-card"><div class="history-top"><div><h3>${esc(g?.name || '本地游戏')} · ${h.operation === 'uninstall' ? '卸载' : '安装 / 更新'} ${esc(h.version || '')}</h3><p>${esc(date(h.createdAt))} · ${h.fileCount} 个文件</p></div><span class="tag ${pending ? 'danger' : ['reverted', 'aborted'].includes(h.status) ? 'neutral' : ''}">${esc(statusLabels[h.status] || h.status)}</span></div><div class="history-bottom"><span>事务 <code>${esc(h.id.slice(0, 8))}</code> · ${h.status === 'reverted' ? '已恢复到此次操作之前' : '备份保留在本机，不会上传'}</span>${canRecover ? `<button class="button ${pending ? 'primary' : 'secondary'} small" data-recover="${esc(h.id)}" data-recover-game="${esc(h.gameId)}">${pending ? '恢复未完成操作' : '撤销这次操作'}</button>` : '<span>按时间倒序逐次恢复</span>'}</div></article>`;
  }).join('');
}
function renderReport(report) {
  lastReport = report;
  $('scanReport').hidden = false;
  $('scanReport').innerHTML = `<div class="section-heading"><h2>安全检查报告</h2><span class="muted">${esc(date(report.scannedAt))}</span></div><div class="notice ${report.blockers.length ? 'danger' : 'success'}"><strong>${report.blockers.length ? '暂不能安装，请先处理这些问题' : '未发现阻断项，运行兼容性仍待验证'}</strong>${report.blockers.map(x => `<p>· ${esc(x)}</p>`).join('')}</div><p class="path">目标目录：${esc(report.targetRoot)}<br>扫描范围：${esc(report.scanRoot)}</p><div class="report-meta"><span class="tag neutral">EXE ${esc(report.exe.arch)}</span><span class="tag neutral">API 候选 ${esc(report.exe.apis.join(' / ') || '无法静态识别')}</span><span class="tag ${report.antiCheat.length ? 'danger' : 'neutral'}">目录反作弊线索 ${report.antiCheat.length}</span><span class="tag neutral">图形相关文件 ${report.files.length}</span></div>${report.loader ? `<div class="notice neutral"><strong>ReShade 运行环境</strong><p>${esc(report.loader.message)}</p><button class="text-button" data-link="reshade">打开 ReShade 官网 ↗</button></div>` : ''}${report.warnings.map(x => `<p class="footnote">${esc(x)}</p>`).join('')}${report.files.length ? report.files.map(f => `<details class="file-report"><summary><strong>${esc(f.relative)}</strong><span class="muted">${esc(f.arch)}</span><span class="tag ${f.risk === 'high' ? 'danger' : f.risk === 'warning' ? 'warning' : ''}">${f.risk === 'high' ? '高风险' : f.risk === 'warning' ? '需确认' : '管理器文件'}</span></summary><dl class="file-properties"><dt>完整路径</dt><dd>${esc(f.path)}</dd><dt>文件来源</dt><dd>${esc(f.source)}</dd><dt>文件版本</dt><dd>${esc(f.version)}</dd><dt>数字签名</dt><dd>${esc(f.signature)} ${esc(f.signer)}</dd><dt>SHA-256</dt><dd>${esc(f.sha256)}</dd><dt>管理器归属</dt><dd>${f.owned ? '是，文件哈希与安装记录一致' : '否，不会自动清理'}</dd><dt>其他使用方</dt><dd>${esc(f.shared)}</dd><dt>静态依赖</dt><dd>${esc(f.imports.join(', ') || '未识别；不代表无运行时依赖')}</dd></dl></details>`).join('') : '<p class="muted">未发现列入检查范围的图形组件。这不代表已经安装了运行环境。</p>'}`;
}
function openImport(version = '') {
  $('importVersion').value = version || packageById(selectedPackage)?.manifest.version || '0.4.2beta';
  $('importApi').value = game()?.api || 'DX12'; $('importHash').value = ''; $('acceptLocal').checked = false;
  $('importDialog').showModal(); $('importVersion').focus();
}
async function configure(candidateIndex) {
  const g = game(); if (!g) return;
  const payload = { gameId: g.id, api: $('gameApi').value, kind: $('gameKind').value, environmentConfirmed: $('environmentConfirmed').checked };
  if (candidateIndex !== undefined) payload.candidateIndex = candidateIndex;
  await api('configure', payload); lastReport = null; $('scanReport').hidden = true; await refresh();
}
async function preview(operation = 'install') {
  const g = game(); if (!g) return;
  const plan = await api('preview', { gameId: g.id, packageId: selectedPackage, operation });
  activePlan = plan; renderReport(plan.report);
  const transitionLabels = { install: '首次安装', upgrade: '升级', downgrade: '降级', rebuild: '同版本文件变化', verify: '版本与文件一致，仅校验', switch: '切换版本', uninstall: '卸载' };
  $('planTitle').textContent = operation === 'uninstall' ? '确认卸载与原文件恢复' : '确认这次插件变更';
  $('planContent').innerHTML = `<div class="notice neutral"><strong>${esc(transitionLabels[plan.transition] || '变更预览')}</strong><p>${plan.noOp ? '此次不会复制、替换文件或重建原始备份。' : '所有写入仍使用原有事务与恢复流程。'}</p></div><div class="plan-target"><small>${esc(g.name)} · ${esc(g.api)} · ${operation === 'uninstall' ? '卸载管理器拥有的文件' : esc(packageById(selectedPackage)?.manifest.version)}</small><div class="path">${esc(plan.targetRoot)}</div></div>${plan.blockers.length ? `<div class="notice danger"><strong>安全门禁未通过，不会修改文件</strong>${plan.blockers.map(b => `<p>· ${esc(b)}</p>`).join('')}</div>` : plan.noOp ? '<div class="notice neutral"><strong>同版本且哈希一致，仅校验</strong><p>不复制文件、不新建事务、不改变首次原始备份。</p></div>' : '<div class="notice neutral"><strong>全部原文件备份完成后，才开始替换</strong><p>预览有效期为 5 分钟。执行前会重新扫描并校验，失败时尝试自动恢复。</p></div>'}${plan.changes.map(c => `<div class="plan-file"><div class="plan-file-heading"><strong>${esc(c.name)}</strong><span class="tag ${c.adopt ? 'warning' : 'neutral'}">${esc(c.action)}</span></div><details><summary>查看替换前后 SHA-256</summary><p>原文件 ${esc(c.before || '不存在（将新增）')}</p><p>目标文件 ${esc(c.after || '恢复为不存在（移除）')}</p></details>${c.adopt ? `<label class="check-row"><input type="checkbox" class="adopt-check" data-name="${esc(c.name)}"><span>这是我之前安装的目标组件，允许管理器<strong>备份后接管并替换</strong>。不会接管其他文件。</span></label>` : ''}</div>`).join('')}${(plan.retainedFiles || []).map(f => `<p class="footnote">保留：${esc(f.name)}（当前包没有提供，不会删除）</p>`).join('')}<div class="plan-checks">${plan.transition === 'downgrade' ? '<label class="check-row"><input type="checkbox" id="confirmDowngrade"><span>确认降级到旧版本；首次安装前的原始备份仍保留。</span></label>' : ''}${operation === 'install' ? '<label class="check-row"><input type="checkbox" id="confirmCompatibility"><span>我已查阅此版本发布说明，确认这是单机离线测试目标，理解当前游戏/API 兼容性仍待验证，异常时先恢复。</span></label>' : ''}<label class="check-row"><input type="checkbox" id="confirmPlan"><span>我已退出游戏、启动器及相关覆盖层，确认只修改以上清单中的文件。</span></label></div>`;
  $('confirmApply').disabled = true; $('confirmApply').textContent = plan.noOp ? '确认并校验已有文件' : operation === 'uninstall' ? '卸载并恢复原文件' : g.installed ? '备份并更新' : '备份并安装';
  $('planDialog').showModal();
}
function updatePlanConsent() {
  const checks = [...$('planContent').querySelectorAll('input[type=checkbox]')];
  $('confirmApply').disabled = !activePlan || activePlan.blockers.length > 0 || checks.some(c => !c.checked);
}
async function addGame() { const id = await api('add-game'); if (id) { selectedGame = id; lastReport = null; $('scanReport').hidden = true; await refresh(); showPage('games'); toast('游戏已添加。请确认图形 API、游戏类型与运行环境。'); } }
async function action(name) {
  if (name === 'add-game') return run('正在添加游戏', addGame);
  if (name === 'import') { openImport(); return; }
  if (!game()) { toast('请先选择游戏。', true); return; }
  const id = game().id;
  if (name === 'report-problem') { openGameFeedback(id); return; }
  if (name === 'open-folder') return run('正在打开游戏目录', () => api('open-game-folder', { gameId: id }));
  if (name === 'copy-path') return run('正在复制游戏路径', async () => { await api('copy-game-path', { gameId: id }); toast('已复制到剪贴板，仅在你的电脑上操作。'); });
  if (name === 'choose-exe') return run('正在选择游戏 EXE', async () => { await api('choose-exe', { gameId: id }); await refresh(); });
  if (name === 'find-exes') return run('正在查找真正运行的 EXE', async () => { const list = await api('candidates', { gameId: id }); await refresh(); toast(list.length ? `找到 ${list.length} 个候选，请从列表中确认。` : '没有找到合适的候选，请手动选择 EXE。'); });
  if (name === 'scan') return run('正在进行只读安全检查', async () => { const report = await api('scan', { gameId: id }); renderReport(report); $('scanReport').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  if (name === 'preview') return run('正在检查并生成文件变更预览', () => preview());
  if (name === 'uninstall') return run('正在检查卸载与恢复计划', () => preview('uninstall'));
}
document.addEventListener('click', event => {
  const b = event.target.closest('button'); if (!b || b.disabled || busy) return;
  if (b.dataset.page) return showPage(b.dataset.page);
  if (b.dataset.link) return run('正在打开官方页面', () => api('open-link', { key: b.dataset.link }));
  if (b.dataset.close) { $(b.dataset.close).close(); return; }
  if (b.dataset.game) { selectedGame = b.dataset.game; lastReport = null; $('scanReport').hidden = true; renderGames(); renderInstall(); return; }
  if (b.dataset.action) return action(b.dataset.action);
  if (b.dataset.importVersion) return openImport(b.dataset.importVersion);
  if (b.dataset.usePackage) { selectedPackage = b.dataset.usePackage; renderInstall(); showPage('games'); toast('已选择此插件版本。请继续选择游戏并预览安装。'); return; }
  if (b.dataset.recover) return run('正在校验备份并恢复原状', async () => { await api('recover', { gameId: b.dataset.recoverGame, transactionId: b.dataset.recover }); await refresh(); });
});
$('addGame').addEventListener('click', () => run('正在添加游戏', addGame));
$('scanSteam').addEventListener('click', () => run('正在扫描 Steam 游戏库', async () => { const result = await api('steam-scan'); await refresh(); if (result) toast(result.total ? `发现 ${result.total} 个游戏，新增 ${result.added} 个。请选择游戏后确认运行 EXE。` : '未发现 Steam 游戏，可使用旁边的文件夹入口选择库目录。'); }));
$('steamFolder').addEventListener('click', () => run('正在扫描选择的 Steam 库', async () => { const result = await api('steam-scan', { chooseFolder: true }); await refresh(); if (result) toast(`发现 ${result.total} 个游戏，新增 ${result.added} 个。`); }));
$('gameSearch').addEventListener('input', renderGames);
$('installContent').addEventListener('change', event => {
  if (event.target.id === 'packageSelect') { selectedPackage = event.target.value || null; renderInstall(); return; }
  if (event.target.id === 'exeCandidate' && event.target.value !== '') return run('正在保存运行 EXE', () => configure(Number(event.target.value)));
  if (['gameApi', 'gameKind', 'environmentConfirmed'].includes(event.target.id)) return run('正在保存游戏配置', () => configure());
});
$('importCustom').addEventListener('click', () => { if (!busy) openImport(); });
$('importForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!$('importForm').reportValidity()) return;
  run('正在校验并导入插件', async () => {
    const pkg = await api('import', { version: $('importVersion').value.trim(), api: $('importApi').value, expectedHash: $('importHash').value.trim(), acceptLocal: $('acceptLocal').checked });
    if (!pkg) return;
    selectedPackage = pkg.id; await refresh(); $('importDialog').close(); toast(`已导入 ${pkg.manifest.version}。文件尚未写入任何游戏。`);
  });
});
$('planContent').addEventListener('change', updatePlanConsent);
$('confirmApply').addEventListener('click', () => run('正在重新检查、备份并处理游戏文件', async () => {
  if (!activePlan) return;
  const consent = { confirm: !!$('confirmPlan')?.checked, compatibility: !!$('confirmCompatibility')?.checked, downgrade: !!$('confirmDowngrade')?.checked, adoptNames: [...document.querySelectorAll('.adopt-check:checked')].map(c => c.dataset.name) };
  try { const result = await api('apply', { planId: activePlan.id, consent }); $('planDialog').close(); toast(result.unchanged ? '版本与文件哈希一致。已完成校验，没有重复写入或重建备份。' : result.operation === 'uninstall' ? '已卸载，并恢复安装前的原文件。' : `已完成 ${result.version} 的文件安装。请在游戏内验证效果，异常时可在恢复中心撤销。`); }
  finally { activePlan = null; $('confirmApply').disabled = true; await refresh(); }
}));
$('exportLog').addEventListener('click', () => run('正在导出脱敏诊断', async () => { if (await api('export')) toast('诊断已导出，不包含用户名、游戏路径、账号或机器标识。'); }));
$('checkUpdates').addEventListener('click', () => run('正在检查管理器更新', async () => {
  const info = await api('check-updates');
  $('updateContent').innerHTML = `<div class="notice neutral"><strong>${info.current ? '当前已是最新公开版本' : '发现公开版本 ' + esc(info.version)}</strong><p>管理器更新与 addon 更新相互独立。Beta 仅检查更新并跳转官方发布页，不在后台自动执行安装包。</p></div><pre class="release-notes">${esc(info.notes || '暂无更新说明。')}</pre>`;
  $('updateDialog').showModal();
}));
for (const d of document.querySelectorAll('dialog')) d.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
run('正在读取本地插件与恢复记录', refresh);
