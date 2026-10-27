'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('collabo', {
  getState: () => ipcRenderer.invoke('state:get'),
  addDirs: () => ipcRenderer.invoke('dirs:add'),
  removeDir: (dir) => ipcRenderer.invoke('dirs:remove', dir),
  rescan: () => ipcRenderer.invoke('files:rescan'),
  readFile: (id) => ipcRenderer.invoke('file:read', id),
  saveThumb: (id, dataUrl) => ipcRenderer.invoke('thumb:save', id, dataUrl),
  failThumb: (id) => ipcRenderer.invoke('thumb:fail', id),
  setInfo: (id, info) => ipcRenderer.invoke('file:info', id, info),
  reveal: (id) => ipcRenderer.invoke('file:reveal', id),
  copyPath: (id) => ipcRenderer.invoke('file:path', id),
  openFins: (id) => ipcRenderer.invoke('fins:open', id),
  finsUrl: (id) => ipcRenderer.invoke('fins:url', id),
  setNotes: (id, notes) => ipcRenderer.invoke('file:notes', id, notes),
  renameFiles: (items) => ipcRenderer.invoke('files:rename', items),
  setTheme: (mode) => ipcRenderer.invoke('theme:set', mode),
  onChanged: (cb) => on('files:changed', cb),
  onTheme: (cb) => on('theme:changed', cb)
});
