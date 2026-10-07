// SPDX-License-Identifier: Apache-2.0
import type {Gateway, GatewayOptions} from '../relay/agent.mjs';
import type {Log} from '../shared/types.mjs';
/** Structural subset, so browser users do not need Electron installed for SDK types. */
export interface GatewayIpcEvent {
  senderFrame: {url: string} | null;
  sender: {
    mainFrame: {url: string};
    on(event: string, listener: () => void): unknown;
    once(event: string, listener: () => void): unknown;
  };
}
export interface GatewayIpcMain {
  handle(channel: string, listener: (event: GatewayIpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}
export interface ElectronGatewayOptions {
  ipcMain: GatewayIpcMain;
  allowedOrigins: string[];
  options?: GatewayOptions;
  log?: Log;
}
export interface ElectronGateway {
  readonly gateway: Gateway | null;
  close(): Promise<void>;
}
export function installFreehopGateway(options: ElectronGatewayOptions): ElectronGateway;
