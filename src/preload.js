const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  uiReady: () => ipcRenderer.send('ui-ready'),
  listServices: () => ipcRenderer.invoke('list-services'),
  registryList: () => ipcRenderer.invoke('registry-list'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setWarmLimit: n => ipcRenderer.invoke('set-warm-limit', n),
  addAccount: (svc, opts) => ipcRenderer.invoke('add-account', svc, opts),
  openAccount: (svc, id) => ipcRenderer.invoke('open-account', svc, id),
  activateTab: key => ipcRenderer.invoke('activate-tab', key),
  sleepTab: key => ipcRenderer.invoke('sleep-tab', key),
  sleepAll: () => ipcRenderer.invoke('sleep-all'),
  setModalOpen: open => ipcRenderer.invoke('set-modal-open', open),
  updateAccount: (svc, id, patch) => ipcRenderer.invoke('update-account', svc, id, patch),
  deleteAccount: (svc, id) => ipcRenderer.invoke('delete-account', svc, id),
  memory: () => ipcRenderer.invoke('memory'),
  openExternal: url => ipcRenderer.invoke('open-external', url),
  activeTabUrl: () => ipcRenderer.invoke('active-tab-url'),
  setAccountToken: (svc, id, plain) => ipcRenderer.invoke('set-account-token', svc, id, plain),
  clearAccountToken: (svc, id) => ipcRenderer.invoke('clear-account-token', svc, id),
  refreshAllStatus: () => ipcRenderer.invoke('refresh-all-status'),
  onTabsState: cb => ipcRenderer.on('tabs-state', (_e, state) => cb(state)),
});
