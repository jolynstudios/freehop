// SPDX-License-Identifier: Apache-2.0
import type {Ticket} from './ticket.mjs';
import type {MaybePromise, TurnServer} from '../shared/types.mjs';
export interface AuthorityOptions {
  app: string;
  gates: string[];
  gateTokenSecret?: string;
  gateTokenSecrets?: Record<string, string>;
  stun?: string[];
  /** Application TURN servers put into every ticket, or a function minting them per ticket. */
  turn?: TurnServer[] | ((context: {roomId: string; member?: string; expires: number}) => MaybePromise<TurnServer[] | null | undefined>);
  ticketTtlSeconds?: number;
  maxRooms?: number;
}
export interface RoomDescription {
  roomId: string;
  tag: string;
  epoch: number;
  members: string[];
}
export interface TicketRotation {
  epoch: number;
  previousTags: string[];
  tickets: Map<string, Ticket>;
  hostTicket: Ticket;
}
export interface Authority {
  openRoom(roomId: string): Promise<Omit<RoomDescription, 'members'> & {members: number}>;
  ticket(roomId: string, member?: string): Promise<Ticket>;
  kick(roomId: string, member: string): Promise<TicketRotation>;
  leave(roomId: string, member: string): Promise<TicketRotation>;
  closeRoom(roomId: string): Promise<boolean>;
  describe(roomId: string): RoomDescription | null;
}
export function createAuthority(options: AuthorityOptions): Authority;
