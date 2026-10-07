// SPDX-License-Identifier: Apache-2.0
import type {GatewayInfo, GatewayCredentials, Log} from '../shared/types.mjs';
import type {TurnLimits, TurnServer} from './turn-server.mjs';
import type {PortMapper, PortMapperOptions, PortMapping} from './port-mapper.mjs';
export interface GatewayOptions {
  host?: string;
  port?: number;
  relayPortRange?: [number, number];
  portMapping?: boolean | PortMapperOptions;
  mapper?: PortMapper | null;
  externalAddress?: string;
  rooms?: string[];
  credentialTtlSeconds?: number;
  relayScope?: 'internal' | 'public';
  limits?: Partial<TurnLimits>;
  log?: Log;
}
export interface GatewayStats {
  external: string | null;
  relayScope: 'internal' | 'public';
  rooms: number;
  revocations: number;
  floors: number;
  mappings: Array<Pick<PortMapping, 'method' | 'protocol' | 'internalPort' | 'externalPort'>>;
  turn: Record<string, number>;
}
export interface Gateway {
  readonly turn: TurnServer;
  readonly mapper: PortMapper | null;
  info(): GatewayInfo | null;
  credentialsFor(roomTag: string, peer: string): GatewayCredentials | null;
  allowRoom(roomTag: string): void;
  revokeRoom(roomTag: string): number;
  revokePeer(roomTag: string, peer: string): number;
  rotate(): GatewayInfo | null;
  stats(): GatewayStats;
  close(): Promise<void>;
}
export function startGateway(options?: GatewayOptions): Promise<Gateway>;
export function isPublicAddress(address: string): boolean;
