// SPDX-License-Identifier: Apache-2.0
import type {Server, IncomingMessage} from 'node:http';
import type {Log, MaybePromise} from '../shared/types.mjs';
export {mintGateToken, verifyGateToken} from '../shared/tokens.mjs';
export const GATE_PROTOCOL: 1;
export interface GateLimits {
  frame: number;
  box: number;
  roomsPerSocket: number;
  peersPerRoom: number;
  socketsPerAddress: number;
  maxSockets: number;
  maxPendingSockets: number;
  pendingPerAddress: number;
  helloMs: number;
  closeMs: number;
  idleMs: number;
  pingMs: number;
  burstBytes: number;
  refillBytesPerSec: number;
  messagesPerSec: number;
  messageBurst: number;
  maxBufferedBytes: number;
  maxBufferedTotal: number;
  maxPendingFrames: number;
  maxPendingBytes: number;
}
export const GATE_LIMITS: Readonly<GateLimits>;
export interface GateHello {
  t: 'hello';
  v: 1;
  auth?: unknown;
  [key: string]: unknown;
}
export interface GateOptions {
  server?: Server;
  host?: string;
  port?: number;
  path?: string;
  publicHost?: string;
  stun?: Array<{host?: string; port?: number; ratePerSec?: number; burst?: number; totalRatePerSec?: number; totalBurst?: number; software?: string}>;
  stunUrls?: string[];
  tokenSecret?: string;
  tokenAudience?: string;
  trustProxy?: boolean;
  authorize?: (hello: GateHello, request: IncomingMessage) => MaybePromise<boolean>;
  limits?: Partial<GateLimits>;
  log?: Log;
}
export interface Gate {
  readonly server: Server;
  readonly path: string;
  readonly stunUrls: string[];
  url(host?: string): string;
  stats(): {[counter: string]: number | Array<Record<string, number>>; stun: Array<Record<string, number>>};
  rooms(): number;
  close(): Promise<void>;
}
export function createGate(options?: GateOptions): Promise<Gate>;
export function randomTag(bytes?: number): string;
