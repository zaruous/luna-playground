const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nyangTracker', {
  platform: process.platform,
  runtime: 'electron',
  usage: {
    getSnapshot: () => ipcRenderer.invoke('usage:get-snapshot'),
    rescan: () => ipcRenderer.invoke('usage:rescan'),
    getDiagnostics: () => ipcRenderer.invoke('usage:get-diagnostics'),
    subscribe: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, snapshot, reason) => callback(snapshot, reason);
      ipcRenderer.on('usage:snapshot', listener);
      return () => ipcRenderer.removeListener('usage:snapshot', listener);
    },
  },
  codex: {
    getHookStatus: () => ipcRenderer.invoke('codex:hook-status'),
    installHooks: () => ipcRenderer.invoke('codex:install-hooks'),
    uninstallHooks: () => ipcRenderer.invoke('codex:uninstall-hooks'),
  },
});
