// SPDX-License-Identifier: Apache-2.0
// Freehop browser client. A game calls join() automatically when a player enters a lobby or
// match; the room secret comes from the game's own room service, never from the player.
export { join, Room, DEFAULT_TIMING, DEFAULT_LIMITS } from './room.mjs';
export { PHASE } from './peer.mjs';
export { deriveRoom, randomId } from './crypto.mjs';
