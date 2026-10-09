// SPDX-License-Identifier: Apache-2.0
// NAT behaviour from what a browser already gathers, and port prediction for peers behind NATs that
// allocate ports in order. Pure functions: no I/O, no timers. Used only when an application opts in
// (classifyNat / portPrediction); with both off nothing here runs.
//
// Classification reads the server-reflexive (srflx) ports one ICE generation reports for up to three
// application STUN servers. One port for every answering server means endpoint-independent mapping
// ('eim'); ports a small, regular step apart mean a sequential allocator ('sequential'); anything
// else is 'random' or 'unknown'. Browsers report a repeated srflx address once, so 'eim' is only
// inferred when at least two STUN servers were configured and none of them failed.
export const NAT_TYPES = Object.freeze(['eim', 'sequential', 'random']);
export const MAX_DELTA = 16;
export const MAX_PREDICTED = 16;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const FOUNDATION = /^[A-Za-z0-9+/]{1,32}$/;

export function parseCandidate(text) {
  if (typeof text !== 'string' || text.length > 1024) return null;
  const parts = text.replace(/^a=/, '').split(/\s+/);
  const head = /^candidate:(\S+)$/.exec(parts[0] ?? '');
  if (!head || parts.length < 8 || parts[6] !== 'typ') return null;
  const port = Number(parts[5]), priority = Number(parts[3]);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(priority) || priority < 0) return null;
  const out = { foundation: head[1], component: parts[1], protocol: parts[2].toLowerCase(), priority, address: parts[4], port, type: parts[7], raddr: null, rport: null, extensions: [] };
  for (let i = 8; i + 1 < parts.length; i += 2) {
    if (parts[i] === 'raddr') out.raddr = parts[i + 1];
    else if (parts[i] === 'rport') out.rport = Number(parts[i + 1]);
    else out.extensions.push(parts[i], parts[i + 1]);
  }
  return out;
}

export const isIpv4 = address => IPV4.test(address ?? '') && address.split('.').every(n => Number(n) <= 255);

// One ICE generation's evidence: UDP IPv4 srflx samples plus failed STUN lookups.
export function createSampler() {
  const samples = [];
  let errors = 0;
  return {
    candidate(text) {
      const c = parseCandidate(text);
      if (c && c.type === 'srflx' && c.protocol === 'udp' && isIpv4(c.address)) samples.push({ address: c.address, port: c.port, base: c.rport > 0 ? `${c.raddr}:${c.rport}` : '' });
    },
    error(url) { if (typeof url === 'string' && /^stun:/i.test(url)) errors++; },
    result() { return { samples: samples.map(s => ({ ...s })), errors }; },
  };
}

// servers: the number of plain stun: URLs the generation used; complete: gathering finished.
export function classifyNat({ samples = [], servers = 0, errors = 0, complete = false } = {}) {
  const unknown = { type: 'unknown', delta: 0 };
  if (!samples.length) return unknown;
  const groups = new Map();
  for (const s of samples) {
    const key = `${s.address}|${s.base ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), s.port]);
  }
  const verdicts = [...groups.values()].map(list => {
    const ports = [...new Set(list)].sort((a, b) => a - b);
    if (ports.length === 1) return servers >= 2 && complete && errors === 0 ? { type: 'eim', delta: 0 } : unknown;
    const gaps = ports.slice(1).map((port, i) => port - ports[i]);
    if (gaps.every(gap => gap >= 1 && gap <= MAX_DELTA)) return { type: 'sequential', delta: Math.min(...gaps) };
    return { type: 'random', delta: 0 };
  });
  return verdicts.every(v => v.type === verdicts[0].type && v.delta === verdicts[0].delta) ? verdicts[0] : unknown;
}

// A peer's advertised NAT behaviour, validated: anything malformed is treated as not advertised.
export function cleanNat(value) {
  if (!value || typeof value !== 'object' || !NAT_TYPES.includes(value.type)) return null;
  if (value.type === 'sequential') return Number.isInteger(value.delta) && value.delta >= 1 && value.delta <= MAX_DELTA ? { type: 'sequential', delta: value.delta } : null;
  return value.delta === 0 || value.delta === undefined ? { type: value.type, delta: 0 } : null;
}

// For a peer whose NAT allocates in order, its next mappings sit just above the highest srflx port
// it reported. Each real srflx candidate of the current generation yields candidates for those
// ports (same address, ufrag and media line), at most MAX_PREDICTED per generation.
export function createPredictor({ count = 8 } = {}) {
  const perGeneration = new Map();
  const n = Math.max(1, Math.min(MAX_PREDICTED, Number.isInteger(count) ? count : 8));
  return function predict(init, nat) {
    if (nat?.type !== 'sequential' || !init || typeof init.candidate !== 'string') return [];
    const c = parseCandidate(init.candidate);
    if (!c || c.type !== 'srflx' || c.protocol !== 'udp' || !isIpv4(c.address) || !FOUNDATION.test(c.foundation)) return [];
    const key = init.usernameFragment ?? '';
    const state = perGeneration.get(key) ?? { real: new Set(), made: new Set(), high: new Map() };
    perGeneration.set(key, state);
    state.real.add(`${c.address}:${c.port}`);
    const high = Math.max(state.high.get(c.address) ?? 0, c.port);
    state.high.set(c.address, high);
    const out = [];
    for (let k = 1; k <= n && state.made.size < MAX_PREDICTED; k++) {
      const port = high + k * nat.delta, id = `${c.address}:${port}`;
      if (port > 65535 || state.real.has(id) || state.made.has(id)) continue;
      state.made.add(id);
      const rest = [c.raddr !== null ? `raddr ${c.raddr}` : '', c.rport !== null ? `rport ${c.rport}` : '', c.extensions.join(' ')].filter(Boolean).join(' ');
      const text = `candidate:${c.foundation.slice(0, 29)}p${k} ${c.component} udp ${Math.max(0, c.priority - k)} ${c.address} ${port} typ srflx${rest ? ` ${rest}` : ''}`;
      out.push({ candidate: text, sdpMid: init.sdpMid ?? null, sdpMLineIndex: init.sdpMLineIndex ?? null, usernameFragment: init.usernameFragment ?? null });
    }
    return out;
  };
}
