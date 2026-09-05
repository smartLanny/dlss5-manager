'use strict';
const { pe } = require('./helpers.cjs');
const { sha256 } = require('../src/core/safety.cjs');
function component(bytes = pe(1), overrides = {}) {
  return { schemaVersion: 2, componentId: 'nr-before-sr', displayName: 'NR before SR', version: '0.4.2beta', channel: 'beta', managerMinVersion: '0.2.0-beta.1', architectures: ['x64'], supportedApis: ['DX12'], files: [{ path: 'nr.addon64', role: 'addon', sha256: sha256(bytes), size: bytes.length }], dependencies: [], conflicts: [], rollbackProtocol: 'manager-journal-v1', source: { kind: 'local' }, license: { name: 'Author supplied', redistribution: 'not-declared' }, ...overrides };
}
module.exports = { component };
