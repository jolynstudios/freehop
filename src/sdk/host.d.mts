// SPDX-License-Identifier: Apache-2.0
import type {Ticket} from './ticket.mjs';
import type {Gateway, GatewayOptions, GatewayStats} from '../relay/agent.mjs';
import type {Log, RotationOptions} from '../shared/types.mjs';
export interface HostOptions {
  gateway?: 'auto' | Gateway | null | false;
  gatewayOptions?: GatewayOptions;
  log?: Log;
}
export interface AvailableHost {
  available: true;
  readonly id: string;
  readonly gateway: Gateway;
  update(ticket: Ticket | string, options?: RotationOptions): Promise<boolean>;
  refresh(ticket: Ticket | string): Promise<boolean>;
  drop(peer: string): void;
  stats(): {available: true; epoch: number; member: Record<string, number>; gateway: GatewayStats};
  close(): Promise<void>;
}
export interface UnavailableHost {
  available: false;
  update(ticket: Ticket | string, options?: RotationOptions): Promise<void>;
  refresh(ticket: Ticket | string): Promise<false>;
  stats(): {available: false};
  close(): Promise<void>;
}
export type HostedSession = AvailableHost | UnavailableHost;
export function sharedGateway(options?: GatewayOptions): Promise<Gateway>;
export function closeSharedGateway(): Promise<void>;
export function hostSession(ticket: Ticket | string, options?: HostOptions): Promise<HostedSession>;
