// SPDX-License-Identifier: Apache-2.0
import type {BinaryLike, KeyObject} from 'node:crypto';
export interface GateTokenClaims {
  exp: number;
  room?: string;
  aud?: string;
  [key: string]: unknown;
}
export function mintGateToken(secret: BinaryLike | KeyObject, claims: GateTokenClaims): string;
export function verifyGateToken(
  secret: BinaryLike | KeyObject,
  token: unknown,
  options?: number | {audience?: string; now?: number} | null,
): GateTokenClaims | null;
