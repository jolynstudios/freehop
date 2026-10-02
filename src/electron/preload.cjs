// SPDX-License-Identifier: Apache-2.0
// Electron preload: exposes window.freehopGateway to the app's own pages only. The main
// process passes the allowed origins as --freehop-origins=<origin>[,<origin>...]; any other
// page (e.g. a link opened inside the window) never sees the gateway. Its signing secret stays in the main process.
const { contextBridge, ipcRenderer } = require('electron');

const arg = process.argv.find(a => a.startsWith('--freehop-origins='));
const allowed = new Set((arg ? arg.slice('--freehop-origins='.length) : '').split(',').map(s => s.trim()).filter(Boolean));
if (allowed.has(globalThis.location?.origin)) {
  contextBridge.exposeInMainWorld('freehopGateway', Object.freeze({
    info: () => ipcRenderer.invoke('freehop:gateway-info'),
    credentialsFor: (tag, peer) => ipcRenderer.invoke('freehop:credentials', tag, peer),
    allowRoom: tag => ipcRenderer.invoke('freehop:allow-room', tag),
    revokePeer: (tag, peer) => ipcRenderer.invoke('freehop:revoke-peer', tag, peer),
    revokeRoom: tag => ipcRenderer.invoke('freehop:revoke-room', tag)
  }));
}
