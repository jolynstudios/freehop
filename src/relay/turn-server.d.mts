// SPDX-License-Identifier: Apache-2.0
import type {TlsOptions} from 'node:tls';
import type {Log, MaybePromise} from '../shared/types.mjs';
export interface TurnLimits {
  maxAllocations: number;
  maxAllocationsPerUsername: number;
  allocationBitrate: number;
  totalBitrate: number;
  defaultLifetime: number;
  maxLifetime: number;
  permissionLifetime: number;
  channelLifetime: number;
  maxPermissions: number;
  maxChannels: number;
  nonceLifetime: number;
  maxTcpConnections: number;
  tcpIdleMs: number;
  hookTimeoutMs: number;
  maxTcpPerAddress: number;
  tcpPreAuthMs: number;
  errorRate: number;
  errorBurst: number;
  udpResponseRate: number;
  udpResponseBurst: number;
  maxAllocationsPerScope?: number;
  scopeBitrate?: number;
}
export const DEFAULT_LIMITS: Readonly<Omit<TurnLimits, 'maxAllocationsPerScope' | 'scopeBitrate'>>;
export type Transport = 'udp' | 'tcp' | 'tls';
export type ListenOptions = {host?: string; port?: number} & (
  {transport?: 'udp' | 'tcp'} | {transport: 'tls'; key: NonNullable<TlsOptions['key']>; cert: NonNullable<TlsOptions['cert']>; passphrase?: string}
);
export interface PeerAddress {
  address: string;
  port: number;
  family: 4 | 6;
}
export interface TurnOptions {
  authenticate(username: string, realm: string): MaybePromise<string | null>;
  realm?: string;
  software?: string | false | null;
  listen?: ListenOptions[];
  relayHost?: string | string[];
  externalAddress?: string | string[];
  relayPortRange?: [number, number];
  peerScope?: 'public' | 'internal';
  allowPrivatePeers?: boolean;
  allowPeer?: (peer: PeerAddress, context: {username: string}) => boolean;
  allocationScope?: (username: string) => string;
  mapRelayPort?: (localPort: number, family: 4 | 6, signal: AbortSignal) => MaybePromise<number | null>;
  limits?: Partial<TurnLimits>;
  log?: Log;
}
export interface TurnServer {
  addresses(): Array<{transport: Transport; address: string; port: number}>;
  relayedAddresses(): Array<{internal: {address: string; port: number}; external: {address: string; port: number}; username: string}>;
  stats(): Record<string, number>;
  revoke(predicate: (username: string) => boolean): number;
  close(): Promise<void>;
}
export function createTurnServer(options: TurnOptions): Promise<TurnServer>;
export function classifyPeerAddress(address: string | Uint8Array): 'deny' | 'private' | 'public';
