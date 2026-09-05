'use strict';
const { fail } = require('./safety.cjs');
// Waits only; never kills processes, changes access rights, or overrides a sharing violation.
async function waitForGame(check, { signal, progress = () => {}, delay = ms => new Promise(r => setTimeout(r, ms)), attempts = 240 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return { ready: false, cancelled: true };
    const env = await check();
    if (!env.verified) fail('PROCESS_CHECK_FAILED', '暂时无法确认游戏是否退出，请稍后重新检测。');
    if (!env.running.length) return { ready: true };
    progress('等待游戏退出… 可取消，不会强行关闭游戏');
    await delay(1500);
  }
  return { ready: false, timeout: true };
}
module.exports = { waitForGame };
