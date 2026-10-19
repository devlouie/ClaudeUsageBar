const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudeBar', {
  onState: (cb) => {
    const handler = (_e, snap) => cb(snap);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
  // invoke(). Caller awaits a result.
  getState: () => ipcRenderer.invoke('get-state'),
  refresh: () => ipcRenderer.invoke('refresh'),
  refreshForce: () => ipcRenderer.invoke('refresh-force'),
  // send(). Fire-and-forget; no return value, no promise round-trip.
  hide: () => ipcRenderer.send('hide'),
  quit: () => ipcRenderer.send('quit'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  setHeight: (h) => ipcRenderer.send('set-height', h),
});
