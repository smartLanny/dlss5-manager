'use strict';
const path = require('node:path');
const { HASH } = require('./safety.cjs');
// A product/version string or export name cannot prove that full add-on support is enabled.
// https://reshade.me/ documents separate normal and full add-on distributions.
// This catalog contains metadata only; no third-party binaries are redistributed.
function loaderStatus(files, targetRoot, catalog = []) {
  const local = files.filter(f => path.dirname(f.path) === targetRoot && (f.proxy || f.loaderCandidate));
  const matches = local.map(file => ({ file, known: catalog.find(x => HASH.test(x.sha256) && x.sha256 === file.sha256 && x.architecture === file.arch && x.componentId === 'reshade' && ['full-addon', 'standard'].includes(x.flavor)) }));
  const verified = matches.find(x => x.known);
  if (verified && local.length === 1) {
    const k = verified.known;
    return { state: 'catalog-verified', addonSupport: k.flavor === 'full-addon' ? 'yes' : 'no', version: k.version, evidenceType: 'curated-sha256', componentEvidence: [{ componentId: 'reshade', version: k.version, verified: true, capabilities: k.flavor === 'full-addon' ? ['addon-support'] : [] }], message: k.flavor === 'full-addon' ? '已按审定哈希识别支持 Add-on 的 ReShade；游戏内加载仍需验证。' : '已按审定哈希识别普通 ReShade，不满足完整 Add-on 运行要求。' };
  }
  if (!local.length) return { state: 'absent', addonSupport: 'unknown', evidenceType: 'directory-scan', componentEvidence: [], message: '未识别到同目录加载器。支持的游戏会在安装时自动准备运行环境。' };
  return { state: 'unverified', addonSupport: 'unknown', evidenceType: 'file-metadata-only', componentEvidence: [], message: '发现代理文件，但尚不能核验完整 Add-on 能力。现有文件保持不动，可以仅更新插件。' };
}
module.exports = { loaderStatus };
