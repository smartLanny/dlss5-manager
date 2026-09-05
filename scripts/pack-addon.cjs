'use strict';
// Offline publisher utility. Reads ONLY explicit arguments; never discovers another repository.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeZip, validateManifest, canonical, peBytes, MAX_PACKAGE } = require('../src/core/packages.cjs');
const { validateComponent } = require('../src/core/components.cjs');
const { leaf, noLinks, sha256, durableWrite } = require('../src/core/safety.cjs');
async function main() {
  const args = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--addon', '--runtime', '--version', '--api', '--out', '--sign-key', '--key-id', '--component-manifest'].includes(args[i]) || !args[i + 1]) throw new Error('参数不完整或未知。');
    opts[args[i].slice(2)] = args[i + 1];
  }
  if (!opts.addon || !opts.version || !opts.api || !opts.out) throw new Error('用法：npm run pack:addon -- --addon /本地/插件.addon64 --version 0.4.2beta --api DX12 --out /私下发布/0.4.2beta.dlss5pkg [--runtime /本地/nvngx_dlssnr.dll] [--sign-key /私有/ed25519.pem --key-id publisher-1]');
  const entries = [], files = [];
  for (const [input, role] of [[opts.addon, 'addon'], [opts.runtime, 'nr-runtime']]) {
    if (!input) continue;
    await noLinks(path.resolve(input)); const st = await fs.stat(input);
    if (!st.isFile() || st.size > MAX_PACKAGE / 2) throw new Error('输入文件不是普通文件或过大。');
    const data = await fs.readFile(input), name = leaf(path.basename(input));
    if (!peBytes(data)) throw new Error('只允许有效的 Windows x64 addon / runtime。');
    entries.push([name, data]); files.push({ path: name, role, sha256: sha256(data), size: data.length });
  }
  let manifest = validateManifest({ schema: 1, component: 'nr-before-sr', architecture: 'x64', version: opts.version, apis: opts.api.split(','), files,
    rightsNotice: 'NR before SR 插件由装机宅独立发布。未经许可，请勿逆向、反编译、复制或再分发。本说明表达作者意愿，不构成无法逆向的技术保证。此工具不修改任何原始插件字节。' });
  if (opts['component-manifest']) {
    const file = path.resolve(opts['component-manifest']); await noLinks(file);
    if ((await fs.stat(file)).size > 64 * 1024) throw new Error('组件清单超过 64 KiB。');
    const c = validateComponent(JSON.parse(await fs.readFile(file, 'utf8')));
    if (c.version !== opts.version || JSON.stringify(c.supportedApis) !== JSON.stringify(opts.api.split(',')) || c.files.length !== files.length || c.files.some(f => !files.some(actual => ['path', 'role', 'sha256', 'size'].every(k => actual[k] === f[k])))) throw new Error('组件清单与明确选择的输入文件、版本或 API 不一致。');
    manifest = c;
  }
  const envelope = { manifest };
  if (opts['sign-key']) {
    if (!opts['key-id']) throw new Error('签名时需要 --key-id。');
    await noLinks(path.resolve(opts['sign-key']));
    const key = crypto.createPrivateKey(await fs.readFile(opts['sign-key']));
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('仅支持 Ed25519 私钥。');
    envelope.keyId = opts['key-id']; envelope.signature = crypto.sign(null, Buffer.from(canonical(manifest)), key).toString('base64');
  }
  const bytes = writeZip([['manifest.json', Buffer.from(JSON.stringify(envelope, null, 2))], ...entries]);
  if (bytes.length > MAX_PACKAGE) throw new Error('包体超过导入上限。');
  const out = path.resolve(opts.out); await noLinks(out); await fs.mkdir(path.dirname(out), { recursive: true });
  await durableWrite(out, bytes, true);
  await durableWrite(out + '.sha256', `${sha256(bytes)}  ${path.basename(out)}\n`, true);
  console.log(`已生成本地发布包。原始 addon 字节保持不变。\nSHA-256: ${sha256(bytes)}\n签名状态: ${envelope.signature ? '已签名，管理器需预置信任公钥' : '未签名，用户须确认来源'}`);
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
