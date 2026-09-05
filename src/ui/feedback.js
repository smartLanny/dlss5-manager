'use strict';
let feedbackDraft = null, feedbackAttachment = null;
function renderFeedbackGames() {
  const select = $('feedbackGame'), old = select.value;
  select.innerHTML = '<option value="">安装器本身 / 未找到游戏</option>' + state.games.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  if (state.games.some(g => g.id === old)) select.value = old;
}
function feedbackGame(id) { closeDialogs(); showPage('feedback'); $('feedbackGame').value = id; $('feedbackSymptom').focus(); }
document.addEventListener('click', e=>{const b=e.target.closest('[data-feedback-game]');if(b&&!busy)feedbackGame(b.dataset.feedbackGame);});
$('feedbackForm').addEventListener('submit', e=>{
  e.preventDefault(); if (!$('feedbackForm').reportValidity()) return;
  run('正在整理反馈',async()=>{
    feedbackDraft=await api('feedback-preview',{gameId:$('feedbackGame').value||null,input:{type:$('feedbackType').value,symptom:$('feedbackSymptom').value,steps:$('feedbackSteps').value,unstable:$('feedbackUnstable').checked,shareGameName:$('feedbackShareName').checked}});
    $('feedbackReport').textContent=feedbackDraft.publicReport;
    $('feedbackQuality').textContent=feedbackDraft.quality.length?'还可以补充：'+feedbackDraft.quality.join('；'):'已整理基础信息，实际原因需要进一步检查。';
    $('feedbackQuality').hidden=false;$('feedbackInclude').checked=false;$('feedbackInclude').disabled=!feedbackAttachment;
    $('feedbackDialog').showModal();
  });
});
$('feedbackImport').addEventListener('click',()=>run('正在读取反馈附件',async()=>{const r=await api('feedback-import');if(!r)return;feedbackAttachment=r;feedbackDraft=null;$('feedbackAttachment').textContent=`已加入 ${r.fileCount} 个文件，仅保留在本机。`;$('feedbackClear').hidden=false;}));
$('feedbackClear').addEventListener('click',()=>run('正在移除附件',async()=>{await api('feedback-clear');feedbackAttachment=null;feedbackDraft=null;$('feedbackAttachment').textContent='';$('feedbackClear').hidden=true;}));
for(const [id,method] of [['feedbackCopy','feedback-copy'],['feedbackOpen','feedback-open']])$(id).addEventListener('click',()=>run('正在准备反馈',async()=>{if(!feedbackDraft)return;await api(method,{id:feedbackDraft.id,reviewed:true});toast(method==='feedback-open'?'报告已复制。在 GitHub 编辑页粘贴、检查后提交。':'报告已复制。');}));
for(const [id,kind] of [['feedbackSave','public'],['feedbackPrivate','private']])$(id).addEventListener('click',()=>run('正在保存反馈',async()=>{if(!feedbackDraft)return;const include=kind==='private'&&$('feedbackInclude').checked;if(await api('feedback-export',{id:feedbackDraft.id,reviewed:true,kind,includeAttachment:include,confirmPrivate:include}))toast('已保存到本机，没有自动上传。');}));
