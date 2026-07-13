const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('kindle', {
  getBooks: () => ipcRenderer.invoke('books:get'),
  sync: () => ipcRenderer.invoke('sync'),
  openLogin: () => ipcRenderer.invoke('login:open'),
  onSyncState: (cb) => ipcRenderer.on('sync-state', (_e, s) => cb(s)),
})
