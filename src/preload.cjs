'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// A method allowlist, not a generic IPC or filesystem bridge.
const methods = ['state', 'add-game', 'steam-scan', 'candidates', 'choose-exe', 'configure', 'scan', 'import', 'preview', 'apply', 'recover', 'export', 'open-game-folder', 'copy-game-path', 'open-link', 'check-updates'];
const api = {};
for (const method of methods) api[method] = payload => ipcRenderer.invoke(`manager:${method}`, payload);
contextBridge.exposeInMainWorld('manager', Object.freeze(api));
