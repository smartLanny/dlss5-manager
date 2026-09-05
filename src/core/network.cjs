'use strict';
const { fail } = require('./safety.cjs');
// Bound both compressed transport length and streamed decoded bytes. No cookies, arbitrary redirects or renderer URLs.
async function download(url, { maxBytes = 8 * 1024 * 1024, headers = {}, timeout = 25000 } = {}, fetcher = fetch) {
  const res = await fetcher(url, { headers, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeout) });
  if (!res.ok) fail('DOWNLOAD_FAILED', '下载暂时失败。已安装的文件不会改变，请检查网络后重试。');
  if (Number(res.headers.get('content-length') || 0) > maxBytes) fail('DOWNLOAD_SIZE', '下载内容异常，已停止。');
  const chunks = []; let count = 0;
  for await (const chunk of res.body) {
    count += chunk.length;
    if (count > maxBytes) { await res.body.cancel?.().catch(() => {}); fail('DOWNLOAD_SIZE', '下载内容超过允许大小。'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
module.exports = { download };
