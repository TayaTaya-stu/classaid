const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('classroomOverlay', {
  getInitialState: () => ipcRenderer.invoke('overlay:get-initial-state'),
  start: (config) => ipcRenderer.invoke('overlay:start', config),
  stop: () => ipcRenderer.invoke('overlay:stop'),
  test: () => ipcRenderer.invoke('overlay:test'),
  openScreen: (screenUrl) => ipcRenderer.invoke('overlay:open-screen', screenUrl),
  onStatus: (callback) => ipcRenderer.on('overlay:status', (_event, value) => callback(value)),
  onPosts: (callback) => ipcRenderer.on('overlay:posts', (_event, value) => callback(value)),
})
