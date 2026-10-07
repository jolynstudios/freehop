// SPDX-License-Identifier: Apache-2.0
import type {EventEmitter} from 'node:events';
import type {Log} from '../shared/types.mjs';
export type MappingMethod = 'pcp' | 'natpmp' | 'upnp';
export interface PortMapperOptions {
  gateway?: string;
  localAddress?: string;
  methods?: MappingMethod | MappingMethod[];
  timeoutMs?: number;
  pcpPort?: number;
  natpmpPort?: number;
  ssdpPort?: number;
  ssdpAddress?: string;
  log?: Log;
}
export interface MappingRequest {
  protocol: 'udp' | 'tcp';
  internalPort: number;
  suggestedExternalPort?: number;
  lifetimeSeconds?: number;
  description?: string;
}
export interface PortMapping {
  method: MappingMethod;
  protocol: 'udp' | 'tcp';
  internalAddress: string;
  internalPort: number;
  externalAddress: string | null;
  externalPort: number;
  lifetimeSeconds: number;
  expiresAt: number | null;
  externalAddressIsPrivate: boolean | null;
  gateway: string;
  description: string;
}
export interface MappingProbe {
  gateway: string | null;
  localAddress: string | null;
  available: Record<MappingMethod, boolean>;
  externalAddress: string | null;
  externalAddressIsPrivate: boolean | null;
  details: Record<string, unknown>;
}
export interface PortMapper extends EventEmitter {
  readonly gateway: string | null;
  readonly localAddress: string | null;
  readonly closed: boolean;
  readonly mappings: PortMapping[];
  probe(): Promise<MappingProbe>;
  map(request: MappingRequest): Promise<PortMapping>;
  unmap(mapping: PortMapping): Promise<boolean>;
  close(): Promise<void>;
  on(event: 'renewed', listener: (mapping: PortMapping) => void): this;
  on(event: 'lost', listener: (mapping: PortMapping, error: PortMapperError) => void): this;
  on(event: string | symbol, listener: (...args: unknown[]) => void): this;
}
export class PortMapperError extends Error {
  constructor(message: string, code: string, details?: {cause?: unknown; [key: string]: unknown});
  code: string;
  method?: MappingMethod;
  transient?: boolean;
  unavailable?: boolean;
  resultCode?: number;
  upnpErrorCode?: number;
}
export function createPortMapper(options?: PortMapperOptions): Promise<PortMapper>;
export function isPrivateIPv4(ip: string): boolean;
export interface DefaultGateway {
  gateway: string;
  interface: string | null;
}
export function parseDefaultGateway(platform: string, text: string): DefaultGateway | null;
export function detectGateway(options?: {timeoutMs?: number; signal?: AbortSignal}): Promise<DefaultGateway | null>;
export function parseIgdDescription(xml: string, location: string): Array<{serviceType: string; version: number; rank: number; controlURL: string}>;
export function parseSoapFault(
  xml: string,
): {errorCode: number | null; errorDescription: string | null; faultCode: string | null; faultString: string | null} | null;
