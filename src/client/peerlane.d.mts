// SPDX-License-Identifier: Apache-2.0
import type {ClientGateway, GateAuth, JsonValue, JsonCompatible, Log, TurnServer} from '../shared/types.mjs';
export type {ClientGateway, GateAuth, JsonValue, JsonCompatible, Log, TurnServer} from '../shared/types.mjs';
export type PathKind = 'connecting' | 'direct' | 'gateway' | 'relay' | 'bridged' | 'unreachable';
export type VideoQualityLevel = 'normal' | 'reduced' | 'minimal' | 'paused';
/** How this endpoint's NAT maps ports, from its own srflx candidates (classifyNat). */
export type NatType = 'eim' | 'sequential' | 'random' | 'unknown';
export interface NatInfo {
  type: NatType;
  /** Port step of a sequential allocator; 0 otherwise. */
  delta: number;
}
export interface ConnectionPath {
  kind: PathKind;
  via?: string | null;
  phase?: 0 | 1 | 2;
  local?: RTCIceCandidateType;
  remote?: RTCIceCandidateType;
  protocol?: string;
  relayProtocol?: string | null;
  localAddress?: string | null;
  remoteAddress?: string | null;
  relayUrl?: string | null;
  rtt?: number | null;
  bytesSent?: number;
  bytesReceived?: number;
}
export interface RoomEvents {
  peer: {id: string};
  'peer-left': {id: string; reason: 'bye' | 'dropped' | 'rekey' | 'gone'};
  /** Untrusted data. Narrow/validate before rendering or acting on it. */
  message: {from: string; data: unknown};
  track: {peer: string; via: string | null; track: MediaStreamTrack; stream: MediaStream};
  'track-ended': {peer: string; via: string; stream: string};
  path: ConnectionPath & {peer: string};
  'video-quality': {peer: string; direction: 'send' | 'receive'; level: VideoQualityLevel; reason: string};
  link: {peer: string; connected: boolean};
  gate: {url: string; state: 'joined' | 'reconnecting' | 'error'; code?: string};
  gateway: {id: string; available: boolean};
  closed: Record<string, never>;
}
export interface RoomTiming {
  capsWaitMs: number;
  politeWaitMs: number;
  endpointMs: number;
  sessionMs: number;
  bridgedRetryMs: number;
  maxRetryMs: number;
  restartFallbackMs: number;
  mediaWatchMs: number;
  recoveryMs: number;
  bridgeWaitMs: number;
  departGraceMs: number;
  offerTimeoutMs: number;
  greetMs: number;
  outboxMs: number;
  sweepMs: number;
  /** Port-prediction rung budget (default 10000). */
  predictMs?: number;
  /** Application TURN rung budget (default 10000). */
  turnMs?: number;
  /** First check for a cheaper route on a pair the application TURN relay carries (default 60000, then doubling up to maxRetryMs). */
  turnUpgradeMs?: number;
}
export interface RoomLimits {
  audioBitrate: number;
  videoBitrate: number;
  forwardVideoBitrate: number;
  maxPeers: number;
  maxGatewayMembers: number;
  maxHints: number;
  maxBridges: number;
  meshForwardPerMinute: number;
  outboxPerPeer: number;
  /** Predicted candidates per peer srflx candidate, 1-16 (default 8; at most 16 per ICE generation). */
  predictPorts?: number;
}
export interface MediaOptions {
  audio?: boolean;
  video?: boolean;
}
export interface MediaControls {
  media?: MediaOptions | MediaStream | null;
  devices?: {audio?: string | null; video?: string | null};
  gateway?: ClientGateway | null;
  stun?: string[];
  forward?: boolean;
  adaptiveVideo?: boolean;
  /** Opt-in: learn this endpoint's NAT behaviour and share it with peers. */
  classifyNat?: boolean;
  /** Opt-in: before reporting unreachable, try predicted ports for peers whose NAT allocates in order. Implies classifyNat. */
  portPrediction?: boolean;
  /** Opt-in: the application's TURN relay, tried last before unreachable. */
  turn?: TurnServer[] | null;
  timing?: Partial<RoomTiming>;
  limits?: Partial<RoomLimits>;
  log?: Log;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  RTCPeerConnection?: typeof RTCPeerConnection;
  WebSocket?: typeof WebSocket;
}
export interface JoinOptions extends MediaControls {
  gates: string[];
  secret: string | Uint8Array;
  app?: string;
  auth?: GateAuth;
}
export interface InboundMediaStats {
  packets: number;
  bytes: number;
  frames: number;
  samples: number;
  lost: number;
  jitter: number;
  streams: number;
  width?: number;
  height?: number;
}
export interface OutboundMediaStats {
  packets: number;
  bytes: number;
  frames: number;
  streams: number;
}
export interface LinkStats {
  peer: string;
  connected: boolean;
  phase: 0 | 1 | 2;
  path: ConnectionPath;
  restarts: number;
  connectMs: number | null;
  forwardedOrigins: string[];
  forwarding: string[];
  media: {
    inbound: Partial<Record<'audio' | 'video', InboundMediaStats>>;
    outbound: Partial<Record<'audio' | 'video', OutboundMediaStats>>;
  };
}
export interface GateStats {
  url: string;
  state: string;
  sent: number;
  received: number;
  bytesOut: number;
  bytesIn: number;
  errors: number;
  connects: number;
}
export interface RoomStats {
  id: string;
  tag: string;
  counters: Record<string, number>;
  gates: GateStats[];
  links: LinkStats[];
  bridges: Array<{peer: string; via: string | null; state: string; requestedAt: number}>;
  relaying: Array<{a: string; b: string}>;
  /** Present when classifyNat (or portPrediction) is enabled. */
  nat?: NatInfo;
}
export interface PeerConnectionView {
  id: string;
  pc: RTCPeerConnection;
  connected: boolean;
  closed: boolean;
  phase: 0 | 1 | 2;
  path: ConnectionPath;
}
export class Room {
  constructor(options: JoinOptions);
  readonly id: string;
  /** Available after start(). Prefer join() for an initialized room. */
  readonly tag: string | undefined;
  readonly tag8: string;
  readonly app: string;
  readonly closed: boolean;
  readonly localStream: MediaStream | null;
  readonly links: Map<string, PeerConnectionView>;
  readonly known: Set<string>;
  readonly options: JoinOptions;
  readonly timing: RoomTiming;
  readonly limits: RoomLimits;
  readonly adaptiveVideoEnabled: boolean;
  readonly classifyNatEnabled: boolean;
  readonly portPredictionEnabled: boolean;
  /** Latest conclusive classification of this endpoint's NAT (classifyNat), or null. */
  readonly nat: NatInfo | null;
  readonly turnServers: Array<{urls: string[]; username: string; credential: string}> | null;
  readonly devices: {audio: string | null; video: string | null};
  on<E extends keyof RoomEvents>(event: E, handler: (detail: RoomEvents[E]) => void): () => void;
  off<E extends keyof RoomEvents>(event: E, handler: (detail: RoomEvents[E]) => void): void;
  start(): Promise<void>;
  rekey(secret: string | Uint8Array, options?: {auth?: GateAuth; gates?: string[]; stun?: string[]; turn?: TurnServer[] | null}): Promise<void>;
  drop(peer: string): void;
  send<T>(data: T & JsonCompatible<T>, options?: {to?: string}): Promise<number>;
  setGateway(gateway: ClientGateway | null): Promise<void>;
  /** Replace the application TURN servers (fresh credentials); null removes them. */
  setTurn(servers: TurnServer[] | null): void;
  setMedia(media: MediaOptions | MediaStream | null): Promise<void>;
  setMicrophone(enabled: boolean): Promise<void>;
  setCamera(enabled: boolean): Promise<void>;
  setPeerMuted(peer: string, muted: boolean): void;
  switchDevice(kind: 'audio' | 'video', deviceId: string | null): Promise<boolean>;
  setAdaptiveVideo(enabled: boolean): Promise<boolean>;
  stats(): Promise<RoomStats>;
  leave(): Promise<void>;
}
export interface StartedRoom extends Room {
  readonly tag: string;
}
export function join(options: JoinOptions): Promise<StartedRoom>;
export const DEFAULT_TIMING: Readonly<RoomTiming>;
export const DEFAULT_LIMITS: Readonly<RoomLimits>;
export const PHASE: Readonly<{ENDPOINT: 0; SESSION: 1; BRIDGED: 2}>;
export function deriveRoom(secret: string | Uint8Array, app?: string): Promise<{tag: string; key: CryptoKey}>;
export function randomId(bytes?: number): string;
