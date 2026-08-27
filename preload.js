// DSH Desktop preload — minimal bridge for the built-in skin switcher.
// Only whitelisted channels are exposed.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshSkin', {
  getConfig: () => ipcRenderer.invoke('skin:get-config'),
  setConfig: (patch) => ipcRenderer.invoke('skin:set-config', patch),
  onConfig: (callback) => {
    const listener = (_event, config) => callback(config);
    ipcRenderer.on('skin:config', listener);
    return () => ipcRenderer.removeListener('skin:config', listener);
  },
});

// Custom window controls (frameless window).
contextBridge.exposeInMainWorld('dshWindow', {
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
});

// Info panel (DSH version + DeepSeek API balance).
contextBridge.exposeInMainWorld('dshInfo', {
  getInfo: () => ipcRenderer.invoke('shell:get-info'),
  getBalance: () => ipcRenderer.invoke('info:get-balance'),
});

// First-run API key setup.
contextBridge.exposeInMainWorld('dshSetup', {
  saveKey: (key) => ipcRenderer.invoke('setup:save-key', key),
});
