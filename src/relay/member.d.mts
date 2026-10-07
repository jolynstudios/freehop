// SPDX-License-Identifier: Apache-2.0
import type {Gateway} from './agent.mjs';
import type {GateAuth, Log} from '../shared/types.mjs';
export const GATEWAY_ID_PREFIX: 'gw_';
export interface GatewayMemberOptions {
  gates: string[];
  secret: string | Uint8Array;
  app?: string;
  gateway: Gateway;
  auth?: GateAuth;
  WebSocketImpl?: typeof WebSocket;
  departGraceMs?: number;
  log?: Log;
}
export interface GatewayMember {
  readonly id: string;
  stats(): Record<string, number>;
  drop(peer: string): void;
  rekey(secret: string | Uint8Array, options?: {auth?: GateAuth; dropped?: string[]; gates?: string[]}): Promise<void>;
  setAuth(auth?: GateAuth): void;
  close(): Promise<void>;
}
export function joinAsGateway(options: GatewayMemberOptions): Promise<GatewayMember>;
