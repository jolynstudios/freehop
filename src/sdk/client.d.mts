// SPDX-License-Identifier: Apache-2.0
import type {StartedRoom, MediaControls} from '../client/peerlane.mjs';
import type {DesktopGateway, RotationOptions} from '../shared/types.mjs';
import type {Ticket} from './ticket.mjs';
export {encodeTicket, decodeTicket, validTicket} from './ticket.mjs';
export type {Ticket} from './ticket.mjs';
export type {RoomEvents, RoomStats, LinkStats, ConnectionPath, PathKind, VideoQualityLevel, RoomTiming, RoomLimits, MediaOptions} from '../client/peerlane.mjs';
export type {DesktopGateway, GatewayInfo, GatewayCredentials, JsonValue, Log} from '../shared/types.mjs';
export interface ConnectOptions extends MediaControls {
  /** null disables automatic discovery of window.freehopGateway. */
  desktopGateway?: DesktopGateway | null;
}
export interface Session extends StartedRoom {
  ticket(): Ticket;
  update(ticket: Ticket | string, options?: RotationOptions): Promise<boolean>;
  refresh(ticket: Ticket | string): Promise<boolean>;
  disconnectPeer(peer: string): Promise<void>;
  /** Always rejects. Use authority.kick() and distribute replacement tickets. */
  kick(): Promise<never>;
  attach<T extends HTMLMediaElement>(track: MediaStreamTrack, element: T): T;
  levels(): Promise<Record<string, number>>;
}
export function connect(ticket: Ticket | string, options?: ConnectOptions): Promise<Session>;
