'use strict';
const DEFAULTS = Object.freeze({ A: '0.3.3.4', B: '0.4.1beta' });
function versionKey(value) {
  const text = String(value || '').trim().toLowerCase().replace(/^v(?=\d)/, '');
  const beta = text.match(/^(?:beta[ -]?(\d+(?:\.\d+){1,3})|(\d+(?:\.\d+){1,3})[ -]?beta)$/);
  return beta ? (beta[1] || beta[2]) + 'beta' : text;
}
function preferredPackage(packages, game, slot) {
  if (slot && game.ab?.[slot]) return packages.find(p => p.id === game.ab[slot]);
  if (!slot && game.installed?.packageId) return packages.find(p => p.id === game.installed.packageId);
  const key = DEFAULTS[slot || 'A'];
  const exact = packages.find(p => versionKey(p.manifest.version) === key);
  // Do not silently replace the requested beta with r2/r3/0.4.2 or a newer version.
  // Explicit A/B selections always permit later versions.
  return exact || (!slot ? packages.at(-1) : undefined);
}
module.exports = { DEFAULTS, versionKey, preferredPackage };
