// SPDX-License-Identifier: Apache-2.0
// Electron main-process helper: runs the player's gateway (TURN + router port mapping) and
// exposes it to the app's renderer through IPC. Pair it with preload.cjs. The gateway starts
// lazily, the first time a renderer asks for it, so players who never use voice pay nothing.
//
//   import { installFreehopGateway } from 'freehop/electron';
//   const peerlane = installFreehopGateway({ ipcMain });
//   app.on('will-quit', () => peerlane.close());
//   new BrowserWindow({ webPreferences: { preload: preloadPath,
//     additionalArguments: ['--freehop-origins=https://play.example.com'] } });
import { startGateway } from '../relay/agent.mjs';

const TAG = /^[A-Za-z0-9_-]{8,64}$/, PEER = /^[A-Za-z0-9_-]{22}$/;

export function installFreehopGateway({ ipcMain, options = {}, log = () => {} }) {
  let gateway = null, starting = null, closed = false;
  const ensure = () => {
    if (closed) return Promise.reject(new Error('closed'));
    if (gateway) return Promise.resolve(gateway);
    starting ??= startGateway({ ...options, log }).then(g => (gateway = g)).catch(error => { starting = null; throw error; });
    return starting;
  };
  ipcMain.handle('freehop:gateway-info', async () => { try { return (await ensure()).info(); } catch (error) { log('gateway-unavailable', { message: error.message }); return null; } });
  ipcMain.handle('freehop:allow-room', async (_event, tag) => { if (typeof tag === 'string' && TAG.test(tag)) (await ensure()).allowRoom(tag); });
  ipcMain.handle('freehop:revoke-peer', async (_event, tag, peer) => {
    if (gateway && typeof tag === 'string' && TAG.test(tag) && typeof peer === 'string' && PEER.test(peer)) gateway.revokePeer(tag, peer);
  });
  ipcMain.handle('freehop:revoke-room', async (_event, tag) => { if (gateway && typeof tag === 'string' && TAG.test(tag)) gateway.revokeRoom(tag); });
  return {
    get gateway() { return gateway; },
    async close() {
      closed = true;
      for (const channel of ['freehop:gateway-info', 'freehop:allow-room', 'freehop:revoke-peer', 'freehop:revoke-room']) ipcMain.removeHandler(channel);
      const g = gateway ?? await starting?.catch(() => null);
      await g?.close();
    }
  };
}
