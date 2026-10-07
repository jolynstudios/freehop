// SPDX-License-Identifier: Apache-2.0
import type {GateAuth} from '../shared/types.mjs';
export interface Ticket {
  v: 1;
  app: string;
  roomId: string;
  epoch: number;
  gates: string[];
  secret: string;
  stun?: string[];
  auth?: GateAuth;
  /** Unix expiry in seconds. */
  expires: number;
}
export function validTicket(value: unknown): value is Ticket;
export function encodeTicket(ticket: Ticket): string;
/** Throws TypeError for malformed, invalid or expired tickets. */
export function decodeTicket(text: string): Ticket;
