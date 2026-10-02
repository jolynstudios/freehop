// SPDX-License-Identifier: Apache-2.0
// Electron main-process helper: runs the participant's gateway (TURN + router port mapping) and
// exposes it to the app's renderer through IPC. Pair it with preload.cjs. The gateway starts
// lazily, the first time a renderer asks for it, so participants who never use voice pay nothing.
//
//   import { installFreehopGateway } from 'freehop/electron';
//   const peerlane = installFreehopGateway({ ipcMain, allowedOrigins: ['https://play.example.com'] });
//   app.on('will-quit', () => peerlane.close());
//   new BrowserWindow({ webPreferences: { preload: preloadPath,
//     additionalArguments: ['--freehop-origins=https://play.example.com'] } });
import { startGateway } from '../relay/agent.mjs';

const TAG = /^[A-Za-z0-9_-]{8,64}$/, PEER = /^[A-Za-z0-9_-]{22}$/;

export function installFreehopGateway({ ipcMain, allowedOrigins, options = {}, log = () => {} }) {
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length || !allowedOrigins.every(origin => {
    try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol) && url.origin === origin; }
    catch { return false; }
  })) throw new TypeError('Specify allowedOrigins as exact HTTP(S) origins for the gateway renderer.');
  const origins = new Set(allowedOrigins);
  // Validate at the privileged boundary too: a preload check alone cannot authorize IPC.
  const trusted = event => {
    try { return event.senderFrame === event.sender.mainFrame && origins.has(new URL(event.senderFrame.url).origin); }
    catch { return false; }
  };
  let gateway = null, starting = null, closed = false;
  const ensure = () => {
    if (closed) return Promise.reject(new Error('closed'));
    if (gateway) return Promise.resolve(gateway);
    starting ??= startGateway({ ...options, log }).then(g => (gateway = g)).catch(error => { starting = null; throw error; });
    return starting;
  };
  ipcMain.handle('freehop:gateway-info', async event => { if (!trusted(event)) return null; try { const g = await ensure(); return trusted(event) ? g.info() : null; } catch (error) { log('gateway-unavailable', { message: error.message }); return null; } });
  ipcMain.handle('freehop:allow-room', async (event, tag) => { if (trusted(event) && typeof tag === 'string' && TAG.test(tag)) { const g = await ensure(); if (trusted(event)) g.allowRoom(tag); } });
  ipcMain.handle('freehop:revoke-peer', async (event, tag, peer) => {
    if (trusted(event) && gateway && typeof tag === 'string' && TAG.test(tag) && typeof peer === 'string' && PEER.test(peer)) gateway.revokePeer(tag, peer);
  });
  ipcMain.handle('freehop:revoke-room', async (event, tag) => { if (trusted(event) && gateway && typeof tag === 'string' && TAG.test(tag)) gateway.revokeRoom(tag); });
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
