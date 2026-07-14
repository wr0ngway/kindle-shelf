const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('kindle', {
  getBooks: () => ipcRenderer.invoke('books:get'),
  sync: () => ipcRenderer.invoke('sync'),
  openLogin: () => ipcRenderer.invoke('login:open'),
  openReader: (asin) => ipcRenderer.invoke('reader:open', asin),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  getDetails: (asin, opts) => ipcRenderer.invoke('details:get', asin, opts),
  seriesGroups: () => ipcRenderer.invoke('series:groups'),
  seriesCheck: (key, opts) => ipcRenderer.invoke('series:check', key, opts),
  authorCatalog: (name, opts) => ipcRenderer.invoke('author:catalog', name, opts),
  setOverride: (asin, value) => ipcRenderer.invoke('override:set', asin, value),
  onSyncState: (cb) => ipcRenderer.on('sync-state', (_e, s) => cb(s)),
})
