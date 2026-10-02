// SPDX-License-Identifier: Apache-2.0
// Validate one ICE server URI, including host/port syntax; never accept lists in one URI.
export function validIceUrl(value, kind) {
  if (typeof value !== 'string' || value.length > 240) return false;
  const m = /^(stun|stuns|turn|turns):(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/.exec(value);
  if (!m || !m[1].startsWith(kind) || kind === 'stun' && m[4] || m[3] && (Number(m[3]) < 1 || Number(m[3]) > 65535)) return false;
  try {
    const url = new URL(`http://${m[2]}:${m[3] ?? 3478}`);
    return !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
export const validStunUrls = urls => Array.isArray(urls) && urls.length <= 4 && urls.every(url => validIceUrl(url, 'stun'));
