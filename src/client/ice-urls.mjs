// SPDX-License-Identifier: Apache-2.0
// Validate one ICE server URI, including host/port syntax; never accept lists in one URI.
export function validIceUrl(value, kind) {
  if (typeof value !== 'string' || value.length > 240) return false;
  const m = /^(stun|stuns|turn|turns):(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/.exec(value);
  if (!m || !m[1].startsWith(kind) || kind === 'stun' && m[4] || m[3] && (Number(m[3]) < 1 || Number(m[3]) > 65535)) return false;
  // Hostnames: dot-separated labels of 1-63 letters, digits or inner hyphens (no empty or edge-hyphen labels).
  if (!m[2].startsWith('[') && !/^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/.test(m[2])) return false;
  try {
    const url = new URL(`http://${m[2]}:${m[3] ?? 3478}`);
    return !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
export const validStunUrls = urls => Array.isArray(urls) && urls.length <= 4 && urls.every(url => validIceUrl(url, 'stun'));
// Application TURN servers (opt-in relay rung): at most 2 entries, each with 1-8 turn:/turns: URLs and
// credentials of 1-256 characters.
export const validTurnServers = list => Array.isArray(list) && list.length <= 2 && list.every(s => !!s && typeof s === 'object' &&
  (typeof s.urls === 'string' ? validIceUrl(s.urls, 'turn') : Array.isArray(s.urls) && s.urls.length >= 1 && s.urls.length <= 8 && s.urls.every(url => validIceUrl(url, 'turn'))) &&
  typeof s.username === 'string' && s.username.length >= 1 && s.username.length <= 256 && typeof s.credential === 'string' && s.credential.length >= 1 && s.credential.length <= 256);
export const normalizeTurnServers = list => Array.isArray(list) && list.length ? list.map(s => ({ urls: [].concat(s.urls), username: s.username, credential: s.credential })) : null;
