'use strict';
const { powershell } = require('./platform.cjs');

const GPU_FAMILIES = Object.freeze(['RTX50', 'RTX40', 'RTX30', 'RTX20']);
const GPU_PRIORITY = Object.freeze({ RTX50: 4, RTX40: 3, RTX30: 2, RTX20: 1 });

function classifyGpuName(name) {
  const value = String(name || '');
  const match = /\bRTX\s*(20|30|40|50)\s*\d{2,3}\b/i.exec(value);
  return match ? `RTX${match[1]}` : null;
}

function profileForFamily(family) {
  if (family === 'RTX50') return 'rtx50';
  if (family === 'RTX40') return 'rtx40';
  if (family === 'RTX30' || family === 'RTX20') return 'rtx20-30';
  return null;
}

async function detectGpu(probe = powershell) {
  if (process.platform !== 'win32') return { family: 'unknown', profileId: null, families: [], names: [], source: 'windows-only', reliable: false };
  // Only the automated Windows fixture uses this deterministic probe override;
  // normal packaged builds always use Win32_VideoController below.
  if (process.env.DLSS5_TEST_GPU && /^(RTX20|RTX30|RTX40|RTX50)$/i.test(process.env.DLSS5_TEST_GPU)) {
    const family = process.env.DLSS5_TEST_GPU.toUpperCase();
    return { family, profileId: profileForFamily(family), families: [family], names: [`Synthetic ${family}`], source: 'test-fixture', reliable: true };
  }
  try {
    const value = await probe(`
      $rows=@(Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop | ForEach-Object { [string]$_.Name });
      ConvertTo-Json -InputObject @($rows) -Compress
    `);
    const names = (Array.isArray(value) ? value : [value]).filter(x => typeof x === 'string' && x.length > 0).slice(0, 8);
    const families = [...new Set(names.map(classifyGpuName).filter(Boolean))].sort((a, b) => GPU_PRIORITY[b] - GPU_PRIORITY[a]);
    const family = families[0] || 'unknown';
    return { family, profileId: profileForFamily(family), families, names, source: 'Win32_VideoController', reliable: families.length > 0 };
  } catch {
    return { family: 'unknown', profileId: null, families: [], names: [], source: 'probe-failed', reliable: false };
  }
}

module.exports = { GPU_FAMILIES, classifyGpuName, profileForFamily, detectGpu };
