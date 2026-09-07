'use strict';
// Adapted from rakanki911/DLSS5-Swapper src/core/feeder-config.js
// at 027d1becef8d048b757eb76ced639df583374917. MIT, (c) 2026 Rakan Alkhaldi.
// Only the three pure INI helpers are reused; see SWAPPER-INI-LICENSE.txt.
// One boundary rule for validation and mutation. Reject header-like syntax
// rather than let a later key be attributed to the preceding section.
function sectionHeader(line) {
  const value = String(line).trim();
  if (!value.startsWith('[')) return null;
  const match = value.match(/^\[([^\]]+)\]$/);
  if (!match || match[1] !== match[1].trim())
    throw Object.assign(new Error('INI 节头无法可靠解析，保留原文件。'), { code: 'AMBIGUOUS_INI' });
  return match[1].toLowerCase();
}
function sectionBounds(lines, section) {
  const headers = lines.map(sectionHeader);
  if (section === '') {
    const end = headers.findIndex(header => header !== null);
    return { start: -1, end: end === -1 ? lines.length : end };
  }
  const start = headers.findIndex(header => header === section.toLowerCase());
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (headers[i] !== null) { end = i; break; }
  return { start, end };
}
function getIni(text, section, key) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const bounds = sectionBounds(lines, section);
  if (!bounds) return null;
  const wanted = key.toLowerCase();
  for (let i = bounds.start + 1; i < bounds.end; i++) {
    const match = lines[i].match(/^\s*([^;#][^=]*?)\s*=\s*(.*)$/);
    if (match && match[1].trim().toLowerCase() === wanted) return match[2].trim();
  }
  return null;
}
function setIni(text, section, key, value) {
  const newline = String(text || '').includes('\r\n') ? '\r\n' : '\n';
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const bounds = sectionBounds(lines, section);
  if (!bounds) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(`[${section}]`, `${key}=${value}`);
  } else {
    const wanted = key.toLowerCase(); let changed = false;
    for (let i = bounds.start + 1; i < bounds.end; i++) {
      const match = lines[i].match(/^\s*([^;#][^=]*?)\s*=/);
      if (match && match[1].trim().toLowerCase() === wanted) {
        const spacing = (lines[i].match(/^(\s*[^=]+?\s*=\s*)/) || [])[1] || `${key}=`;
        lines[i] = spacing + value; changed = true; break;
      }
    }
    if (!changed) lines.splice(bounds.end, 0, `${key}=${value}`);
  }
  return lines.join(newline).replace(/(?:\r?\n)*$/, newline);
}
module.exports = { sectionHeader, sectionBounds, getIni, setIni };
