// SPDX-License-Identifier: Apache-2.0
import type {Buffer} from 'node:buffer';
export const MAGIC_COOKIE: 0x2112a442;
export const METHOD: {BINDING: number; ALLOCATE: number; REFRESH: number; SEND: number; DATA: number; CREATE_PERMISSION: number; CHANNEL_BIND: number};
export const CLASS: {REQUEST: 0; INDICATION: 1; SUCCESS: 2; ERROR: 3};
export const ATTR: {
  MAPPED_ADDRESS: number;
  USERNAME: number;
  MESSAGE_INTEGRITY: number;
  ERROR_CODE: number;
  UNKNOWN_ATTRIBUTES: number;
  CHANNEL_NUMBER: number;
  LIFETIME: number;
  XOR_PEER_ADDRESS: number;
  DATA: number;
  REALM: number;
  NONCE: number;
  XOR_RELAYED_ADDRESS: number;
  REQUESTED_ADDRESS_FAMILY: number;
  EVEN_PORT: number;
  REQUESTED_TRANSPORT: number;
  DONT_FRAGMENT: number;
  MESSAGE_INTEGRITY_SHA256: number;
  PASSWORD_ALGORITHM: number;
  USERHASH: number;
  XOR_MAPPED_ADDRESS: number;
  RESERVATION_TOKEN: number;
  PRIORITY: number;
  USE_CANDIDATE: number;
  ADDITIONAL_ADDRESS_FAMILY: number;
  PASSWORD_ALGORITHMS: number;
  ALTERNATE_DOMAIN: number;
  SOFTWARE: number;
  ALTERNATE_SERVER: number;
  FINGERPRINT: number;
  ICE_CONTROLLED: number;
  ICE_CONTROLLING: number;
};
export interface Attribute {
  type: number;
  value: Buffer;
  offset: number;
}
export interface Message {
  type: number;
  method: number;
  cls: number;
  transactionId: Buffer;
  attributes: Attribute[];
  length: number;
  raw: Buffer;
}
export interface Address {
  address: string;
  port: number;
  family?: 4 | 6 | 'IPv4' | 'IPv6';
}
export interface DecodedAddress {
  address: string;
  port: number;
  family: 4 | 6;
}
export type Bytes = Uint8Array;
export type Value = Bytes | string;
export function isStunMessage(buffer: Bytes | null | undefined): boolean;
export function isChannelData(buffer: Bytes | null | undefined): boolean;
export function decode(buffer: Bytes | null | undefined): Message | null;
export function getAttr(message: Message | null | undefined, type: number): Buffer | undefined;
export function encode(
  message: {method: number; cls: number; transactionId?: Value; attributes?: Array<{type: number; value?: Value}>},
  options?: {integrityKey?: Value; fingerprint?: boolean},
): Buffer;
export function ipToBytes(address: string): Buffer | null;
export function bytesToIp(bytes: Bytes): string | null;
export function encodeAddress(address: Address): Buffer;
export function encodeXorAddress(address: Address, transactionId: Value): Buffer;
export function decodeAddress(value: Bytes | null | undefined): DecodedAddress | null;
export function decodeXorAddress(value: Bytes | null | undefined, transactionId: Bytes): DecodedAddress | null;
export function errorCodeValue(code: number, reason?: string): Buffer;
export function decodeErrorCode(value: Buffer | null | undefined): {code: number; reason: string} | null;
export function saslprep(value: string): string;
export function longTermKey(username: Value, realm: Value, password: Value): Buffer;
export function verifyIntegrity(message: Message | null | undefined, key: Value): boolean;
export function verifyFingerprint(message: Message | null | undefined): {present: boolean; valid: boolean};
export function encodeChannelData(channel: number, data: Value, options?: {pad?: boolean}): Buffer;
export function decodeChannelData(buffer: Bytes | null | undefined): {channel: number; data: Buffer} | null;
export function frameStreamMessages(buffer?: Bytes | null): {messages: Buffer[]; rest: Buffer; need: number; error?: string};
