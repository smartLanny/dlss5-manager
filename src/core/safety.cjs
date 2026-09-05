'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

class SafetyError extends Error {
  constructor(code, message) { super(message); this.name = 'SafetyError'; this.code = code; }
}
function fail(code, message) { throw new SafetyError(code, message); }
function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
const ID = /^[a-f0-9-]{36}$/;
const HASH = /^[a-f0-9]{64}$/;
function validId(id) { if (typeof id !== 'string' || !ID.test(id)) fail('INVALID_ID', '记录编号无效，请重新打开管理器。'); return id; }
function leaf(name) {
  if (typeof name !== 'string' || !name || name.length > 150 || name !== name.normalize('NFC') ||
      /[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name) || name.startsWith('.') ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) fail('UNSAFE_NAME', '文件名不安全，不能安装。');
  return name;
}
function inside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
async function noLinks(target) {
  const full = path.resolve(target);
  const parsed = path.parse(full);
  let current = parsed.root;
  for (const part of full.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let st;
    try { st = await fs.lstat(current); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1)) fail('LINK_BLOCKED', '检测到链接、目录联接或硬链接。为保护原文件，已停止操作。');
  }
}
async function assertGameRoot(root, storeRoot) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || /^[\\/]{2}/.test(root) || root.includes('\0')) fail('UNSAFE_ROOT', '请选择本机磁盘上的游戏目录，不支持网络路径。');
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir())) fail('UNSAFE_ROOT', '不能把磁盘根目录或用户主目录当作游戏目录。');
  const blocked = process.platform === 'win32'
    ? [process.env.SystemRoot || 'C:\\Windows', process.env.WINDIR || 'C:\\Windows', process.env.APPDATA, process.env.LOCALAPPDATA]
    : ['/System', '/usr', '/bin', '/sbin', '/etc'];
  if (blocked.filter(Boolean).some(p => inside(p, resolved)) || (storeRoot && (inside(storeRoot, resolved) || inside(resolved, storeRoot)))) fail('SYSTEM_PATH', '这是系统目录或管理器数据目录，不能修改。');
  await noLinks(resolved);
  const st = await fs.stat(resolved);
  if (!st.isDirectory()) fail('UNSAFE_ROOT', '游戏目录已失效，请重新选择运行 EXE。');
  if (path.resolve(await fs.realpath(resolved)).toLowerCase() !== resolved.toLowerCase()) fail('ROOT_CHANGED', '目录真实位置发生变化，请重新添加游戏。');
  return resolved;
}
async function digestFile(file) {
  await noLinks(file);
  let h;
  try { h = await fs.open(file, 'r'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const st = await h.stat();
    if (!st.isFile() || st.nlink > 1) fail('NOT_REGULAR', '目标不是普通文件，已停止操作。');
    const hash = crypto.createHash('sha256');
    const buf = Buffer.alloc(1024 * 1024);
    let pos = 0;
    for (;;) {
      const { bytesRead } = await h.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      hash.update(buf.subarray(0, bytesRead)); pos += bytesRead;
    }
    const end = await h.stat();
    if (end.size !== st.size || end.mtimeMs !== st.mtimeMs) fail('FILE_CHANGED', '检测到文件正在变化，请关闭游戏或其他更新工具后重试。');
    return hash.digest('hex');
  } finally { await h.close(); }
}
async function durableWrite(file, data, exclusive = false) {
  await noLinks(file);
  const h = await fs.open(file, exclusive ? 'wx' : 'w', 0o600);
  try { await h.writeFile(data); await h.sync(); } finally { await h.close(); }
}
async function atomicJson(file, value) {
  await noLinks(path.dirname(file));
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await noLinks(file);
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await durableWrite(temp, JSON.stringify(value, null, 2), true); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
async function readJson(file, fallback) {
  try {
    await noLinks(file);
    const st = await fs.stat(file);
    if (st.size > 4 * 1024 * 1024) fail('STATE_TOO_LARGE', '本地记录异常，已停止操作并保留备份。');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
function redact(text, roots = []) {
  let result = String(text);
  for (const value of [os.homedir(), ...roots].filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(value).join('[本地路径]');
  return result.replace(/[A-Za-z]:[\\/][^\n\r"<>]*/g, '[本地路径]').replace(/\/(?:Users|home)\/[^/\s]+/g, '/[用户]');
}
function friendlyError(e) {
  if (e instanceof SafetyError) return { code: e.code, message: e.message };
  const known = { EACCES: '没有写入权限。请检查游戏文件夹权限；不要关闭安全软件。', EPERM: '文件可能被占用或没有权限。请关闭游戏、启动器和覆盖层后重试。', EBUSY: '文件正被使用。请完全退出游戏后重试。', ENOSPC: '磁盘空间不足。请释放空间，备份仍会保留。', ENOENT: '文件或目录不存在，请重新选择。', EINVAL: '文件路径或数据无效，请重新选择。' };
  return { code: known[e.code] ? e.code : 'OPERATION_FAILED', message: known[e.code] || '操作未完成。没有继续覆盖文件，请查看恢复中心或导出脱敏诊断。' };
}
module.exports = { SafetyError, fail, sha256, validId, HASH, leaf, inside, noLinks, assertGameRoot, digestFile, durableWrite, atomicJson, readJson, redact, friendlyError };
