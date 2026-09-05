'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { noLinks } = require('./safety.cjs');
// Interpret only the public ReShade AddonPath key. No NR settings are parsed or rewritten.
async function addonLocation(root) {
  const file = path.join(root, 'ReShade.ini');
  try {
    await noLinks(file); const stat = await fs.stat(file);
    if (stat.size > 1024*1024) return { state:'unknown' };
    const b = await fs.readFile(file); const text = b[0] === 255 && b[1] === 254 ? b.subarray(2).toString('utf16le') : b.toString('utf8');
    let section = '', values = [];
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim(); if (!s || /^[;#]/.test(s)) continue;
      const heading = s.match(/^\[([^\]]+)\]$/); if (heading) { section = heading[1].toUpperCase(); continue; }
      if (section === 'ADDON') { const m = s.match(/^AddonPath\s*=\s*(.*)$/i); if (m) values.push(m[1].trim()); }
    }
    if (!values.length) return { state:'default' };
    if (values.length !== 1 || !['', '.', './', '.\\'].includes(values[0])) return { state:'custom' };
    return { state:'default' };
  } catch (e) { if(e.code==='ENOENT')return {state:'default'}; return {state:'unknown'}; }
}
module.exports = { addonLocation };
