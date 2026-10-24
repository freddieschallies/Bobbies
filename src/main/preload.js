'use strict';
// Safe bridge between the screens and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pos', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  call: (method, ...args) => ipcRenderer.invoke('store', method, args),

  setSaleActive: (active) => ipcRenderer.send('sale-active', Boolean(active)),
  getSaleActive: () => ipcRenderer.invoke('sale-active:get'),
  onSaleActive: (cb) => ipcRenderer.on('sale-active', (_e, v) => cb(v)),

  addVideos: () => ipcRenderer.invoke('videos:add'),
  removeVideo: (id) => ipcRenderer.invoke('videos:remove', id),
  testVideo: () => ipcRenderer.send('video:test'),
  onTestVideo: (cb) => ipcRenderer.on('video:test', () => cb()),

  placeMenu: () => ipcRenderer.invoke('menu:place'),
  reloadMenu: () => ipcRenderer.invoke('menu:reload'),
});
