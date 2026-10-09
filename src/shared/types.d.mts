// SPDX-License-Identifier: Apache-2.0
/** Values carried by session.send(). Validate incoming messages before use. */
export type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};
/** Structural JSON check that also accepts application interfaces. */
export type JsonCompatible<T> = T extends null | boolean | number | string
  ? T
  : T extends (...args: never[]) => unknown
    ? never
    : T extends object
      ? {[K in keyof T]: JsonCompatible<T[K]>}
      : never;
export type Log = (event: string, details: Record<string, unknown>) => void;
export type MaybePromise<T> = T | Promise<T>;
export type GateAuth = string | Record<string, string>;
export interface GatewayCredentials {
  username: string;
  credential: string;
}
export interface GatewayInfo {
  urls: string[];
  internalUrls?: string[];
  ttlSeconds?: number;
  external?: string[];
  internal?: string | null;
}
export interface GatewayBroker {
  info(): GatewayInfo | null;
  credentialsFor(tag: string, peer: string): MaybePromise<GatewayCredentials | null>;
}
export type ClientGateway = GatewayBroker | (GatewayInfo & Pick<GatewayBroker, 'credentialsFor'>);
/** The supported, origin-restricted Electron preload bridge. */
export interface DesktopGateway {
  info(): Promise<GatewayInfo | null>;
  credentialsFor(tag: string, peer: string): Promise<GatewayCredentials | null>;
  allowRoom(tag: string): Promise<void>;
  revokePeer(tag: string, peer: string): Promise<void>;
  revokeRoom(tag: string): Promise<void>;
}
/** An application TURN server for the opt-in relay rung (for example short-lived credentials from your TURN provider). */
export interface TurnServer {
  urls: string | string[];
  username: string;
  credential: string;
}
export interface RotationOptions {
  dropped?: string[];
}
