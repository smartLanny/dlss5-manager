'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const methods = ['state', 'add-game', 'scan-library', 'identify', 'observe', 'import', 'prepare', 'wait-game', 'cancel-wait', 'capture-addon', 'apply', 'assign-ab', 'details', 'uninstall', 'recover', 'launch', 'hide-game', 'open-game-folder', 'copy-game-path', 'poster', 'preferences', 'open-link', 'export', 'check-updates', 'feedback-import', 'feedback-clear', 'feedback-preview', 'feedback-copy', 'feedback-open', 'feedback-export'];
const api = Object.fromEntries(methods.map(method => [method, payload => ipcRenderer.invoke(`manager:${method}`, payload)]));
api.onProgress = callback => { const listener = (_event, message) => callback(String(message)); ipcRenderer.on('manager:progress', listener); return () => ipcRenderer.removeListener('manager:progress', listener); };
contextBridge.exposeInMainWorld('manager', Object.freeze(api));
