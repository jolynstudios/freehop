// SPDX-License-Identifier: Apache-2.0
// Drives one real Room (src/client/room.mjs) and its real PeerLinks through scripted path-ladder
// scenarios on the fake peer connection and virtual clock. Remote members are scripts: they answer
// offers, trickle candidates and play the forwarder side of a bridge. The output is a canonical
// trace of everything the ladder decides: outgoing signalling, events, peer-connection calls and
// final link state. Signalling is captured before sealing, so traces contain no random bytes.
import { Room } from '../../src/client/room.mjs';
import { createFakePeerConnection, installClock, sdpFor, ufragOf } from './fake-pc.mjs';

export const IDS = Object.freeze({ A: 'A'.repeat(22), Z: 'Z'.repeat(22), B: 'B'.repeat(22), C: 'C'.repeat(22), gw: `gw_${'G'.repeat(19)}` });
const TAG = 'T'.repeat(22);
const START = 1_800_000_000_000;
export const STUN = ['stun:stun-a.invalid:3478', 'stun:stun-b.invalid:3478'];
export const GATEWAYS = Object.freeze({
  own: { urls: ['turn:198.18.0.10:3478'], internalUrls: ['turn:10.0.0.1:3478'], external: ['198.18.0.10'], internal: '10.0.0.1' },
  B: { urls: ['turn:198.18.0.20:3478'], username: 'u-b', credential: 'c-b', external: ['198.18.0.20'], internal: null },
  gw: { urls: ['turn:198.18.0.30:3478'], username: 'u-gw', credential: 'c-gw', external: ['198.18.0.30'], internal: null },
});

const negotiated = pc => !!pc.localDescription && !!pc.remoteDescription && pc.signalingState === 'stable' && pc.remoteCandidates.length > 0;
const configured = (pc, url) => pc.gatheredIceServers.some(s => [].concat(s.urls).includes(url));
export const pairs = {
  direct: { local: 'srflx', remote: 'srflx', localAddress: '203.0.113.10', remoteAddress: '198.51.100.20' },
  relay: (url, address) => ({ local: 'relay', remote: 'srflx', relayProtocol: 'udp', localAddress: address, remoteAddress: '198.51.100.20', url }),
};

function fakeOwnGateway() {
  const g = GATEWAYS.own;
  return { info: () => ({ urls: g.urls, internalUrls: g.internalUrls, ttlSeconds: 7200, external: g.external, internal: g.internal }),
    credentialsFor: (tag, label) => ({ username: `${Math.floor(Date.now() / 1000) + 7200}:${tag.slice(0, 8)}:${label}`, credential: 'c-own' }) };
}

// Local candidates per generation: a host candidate, one srflx per answering STUN server (a NAT
// model picks its mapped port; equal mappings are reported once, as browsers do) and one relay per
// TURN entry.
function natPorts(nat, count) {
  const type = nat?.type ?? 'eim', base = nat?.base ?? 40000;
  if (type === 'eim') return Array(count).fill(base);
  if (type === 'sequential') return Array.from({ length: count }, (_, i) => base + (i + 1) * (nat.delta ?? 1));
  let state = nat.seed ?? 7;
  return Array.from({ length: count }, () => { state = (state * 1103515245 + 12345) % 2147483648; return 1024 + state % 64512; });
}

export function createWorld(scenario) {
  const pcs = [], remotes = new Map(), bound = new Map();
  let room = null, trace = null, at = () => 0;
  const world = {
    attach(r, t, clockAt) { room = r; trace = t; at = clockAt; },
    register(pc) { pcs.push(pc); return `pc${pcs.length}`; },
    bind(pc, peer) { bound.set(pc, peer); world.record(pc, 'bind', { peer }); },
    peerOf: pc => bound.get(pc) ?? null,
    record(pc, call, detail = {}) { trace?.push({ t: at(), pc: pc.id, call, ...detail }); },
    checkConfiguration(pc, config) { scenario.checkConfiguration?.({ pc, config, world }); },
    candidatesFor(pc) {
      const out = [{ candidate: `candidate:1 1 udp 2122260223 10.0.0.1 ${50000 + pc.localGeneration} typ host generation 0` }];
      const stun = pc.config.iceServers.filter(s => !s.username).flatMap(s => [].concat(s.urls)).filter(u => u.startsWith('stun:'));
      const failing = new Set(scenario.stunErrors ?? []);
      const answering = stun.filter(u => !failing.has(u));
      const ports = natPorts(scenario.nat, answering.length);
      const seen = new Set();
      stun.forEach(url => {
        if (failing.has(url)) { out.push({ error: true, url }); return; }
        const port = ports[answering.indexOf(url)];
        if (seen.has(port)) return;
        seen.add(port);
        out.push({ candidate: `candidate:2 1 udp 1686052607 203.0.113.10 ${port} typ srflx raddr 10.0.0.1 rport ${50000 + pc.localGeneration} generation 0` });
      });
      pc.config.iceServers.filter(s => s.username).forEach((s, i) => out.push({ candidate: `candidate:${3 + i} 1 udp 41885439 198.18.1.${10 + i} ${60000 + i} typ relay raddr 203.0.113.10 rport ${ports[0] ?? 40000} generation 0`, delay: 40 + i }));
      return out;
    },
    evaluate(pc) {
      if (pc.probe || pc.closed || pc.connectTimer) return;
      const peer = bound.get(pc);
      if (pc.connectionState === 'connected') {
        // Optional: a later ICE generation of a connected pair may select a better pair, as browsers do.
        const next = peer && scenario.reselect?.({ pc, peer, room, negotiated: negotiated(pc), configured: url => configured(pc, url), world });
        if (next && JSON.stringify(next) !== JSON.stringify(pc.pair)) { pc.pair = next; world.record(pc, 'reselect', { local: next.local, remote: next.remote, url: next.url ?? null }); }
        return;
      }
      const pair = peer && scenario.connect?.({ pc, peer, room, negotiated: negotiated(pc), configured: url => configured(pc, url), world });
      if (!pair) return;
      pc.connectTimer = setTimeout(() => { pc.connectTimer = null; if (pc.closed) return; pc.pair = pair; pc.setState('connected'); }, scenario.connectDelay ?? 200);
    },
    async stats(pc) {
      const map = new Map();
      if (pc.connectionState === 'connected' && pc.pair) {
        const p = pc.pair;
        map.set('T1', { id: 'T1', type: 'transport', selectedCandidatePairId: 'CP1' });
        map.set('CP1', { id: 'CP1', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L1', remoteCandidateId: 'R1',
          responsesReceived: 3, currentRoundTripTime: 0.04, bytesSent: 1200, bytesReceived: 1300 });
        map.set('L1', { id: 'L1', type: 'local-candidate', candidateType: p.local, protocol: 'udp', relayProtocol: p.relayProtocol, address: p.localAddress, url: p.url });
        map.set('R1', { id: 'R1', type: 'remote-candidate', candidateType: p.remote, address: p.remoteAddress });
      } else {
        const responses = scenario.responses?.({ pc, peer: bound.get(pc) }) ?? 0;
        map.set('CP0', { id: 'CP0', type: 'candidate-pair', state: 'in-progress', responsesReceived: responses, localCandidateId: 'L0', remoteCandidateId: 'R0' });
      }
      return map;
    },
    linkFor: peer => room.links.get(peer),
    setState(peer, state) { room.links.get(peer)?.pc.setState(state); },
    // A remote member as a script: dispatches sealed-equivalent payloads straight into the room.
    remote(def) {
      const r = { n: 0, generation: 0, lastOffer: null, answers: true, answerDelay: 60, ...def };
      remotes.set(r.id, r);
      return r;
    },
    dispatch(r, payload) {
      try { room.dispatch(r.id, { ...payload, n: ++r.n }); } catch (error) { room.count('linkErrors', error); }
    },
    sendCandidates(r, ufrag) {
      const list = typeof r.candidates === 'function' ? r.candidates(r.generation) : r.candidates;
      for (const candidate of list ?? [`candidate:1 1 udp 2122260223 10.9.0.2 50100 typ host generation 0`,
        `candidate:2 1 udp 1686052607 198.51.100.20 41000 typ srflx raddr 10.9.0.2 rport 50100 generation 0`])
        world.dispatch(r, { kind: 'candidate', candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: ufrag } });
    },
    offer(r) {
      r.generation++;
      const ufrag = `${r.label}r${r.generation}`;
      world.dispatch(r, { kind: 'description', description: { type: 'offer', sdp: sdpFor(ufrag) }, phase: 0, gateways: [], caps: r.caps });
      setTimeout(() => world.sendCandidates(r, ufrag), 10);
    },
    deliver(to, payload) {
      const r = remotes.get(to);
      if (!r) return;
      if (payload.kind === 'description' && payload.description.type === 'offer' && r.answers) {
        const offerUfrag = ufragOf(payload.description.sdp);
        setTimeout(() => {
          if (offerUfrag !== r.lastOffer) { r.generation++; r.lastOffer = offerUfrag; }
          const ufrag = `${r.label}r${r.generation}`;
          world.dispatch(r, { kind: 'description', description: { type: 'answer', sdp: sdpFor(ufrag) }, phase: 0, gateways: [], caps: r.caps });
          setTimeout(() => world.sendCandidates(r, ufrag), 10);
        }, r.answerDelay);
      } else if (payload.kind === 'bridge-request' && r.forwards) {
        setTimeout(() => world.dispatch(r, { kind: 'bridge-offer', a: payload.a, b: payload.b }), 30);
      } else if (payload.kind === 'bridge-accept' && r.forwards) {
        setTimeout(() => world.dispatch(r, { kind: 'bridge-active', a: payload.a, b: payload.b }), 30);
      }
    },
  };
  return world;
}

function summarize(payload) {
  const { kind, n, ...rest } = payload;
  if (rest.description) rest.description = { type: rest.description.type, ufrag: ufragOf(rest.description.sdp) };
  if (rest.candidate) rest.candidate = { candidate: rest.candidate.candidate, ufrag: rest.candidate.usernameFragment ?? null };
  return rest;
}

const LABELS = Object.entries({ ...IDS, T: TAG }).sort((a, b) => b[1].length - a[1].length);
const label = text => LABELS.reduce((s, [name, id]) => s.split(id).join(name), text);

// Runs one scenario definition. `mutate(room, world)` injects drift for falsifiers and tests.
export async function runScenario(scenario, { mutate } = {}) {
  const clock = installClock(START);
  const trace = [];
  const world = createWorld(scenario);
  try {
    const room = new Room({ gates: ['wss://gate.invalid/freehop'], secret: 'x'.repeat(32), app: 'ladder', stun: scenario.stun ?? STUN,
      RTCPeerConnection: createFakePeerConnection(world), WebSocket: class {}, getUserMedia: async () => { throw new Error('no media'); },
      ...(scenario.ownGateway ? { gateway: fakeOwnGateway() } : {}), ...scenario.options });
    room.id = scenario.self ?? IDS.A; room.crypto = { tag: TAG }; room.tag = TAG;
    world.attach(room, trace, () => clock.now() - START);
    const emit = room.emit.bind(room);
    room.emit = (type, detail) => { trace.push({ t: clock.now() - START, event: type, ...detail }); return emit(type, detail); };
    room.signalTo = async (to, payload) => {
      if (room.closed && payload.kind !== 'bye') return false;
      trace.push({ t: clock.now() - START, out: payload.kind, to, ...summarize(payload) });
      world.deliver(to, payload);
      return true;
    };
    const ensureLink = room.ensureLink.bind(room);
    room.ensureLink = (peer, forOffer) => {
      const before = room.links.get(peer), link = ensureLink(peer, forOffer);
      if (link && link !== before) world.bind(link.pc, peer);
      return link;
    };
    if (room.ownGateway) await room.gatewayCredsFor('self');
    // The periodic media watch room.start() installs (it re-reads every connected link's path), for
    // scenarios that depend on it.
    if (scenario.mediaWatch) room.mediaWatch = setInterval(() => room.checkSending(), room.timing.mediaWatchMs);
    mutate?.(room, world);
    await scenario.setup({ room, world, IDS });
    await clock.run(START + scenario.runMs);
    const final = { counters: { ...room.counters }, links: [...room.links.values()].map(l => ({ peer: l.id, phase: l.phase, connected: l.connected,
      restarts: l.restarts, retries: l.retries, path: { kind: l.path.kind, via: l.path.via ?? null } })) };
    room.closed = true; clearTimeout(room.capsTimer);
    for (const link of room.links.values()) link.close();
    return JSON.parse(label(JSON.stringify({ trace, final, errors: clock.errors })));
  } finally {
    clock.restore();
  }
}

// Remote members used by the scenarios below.
const member = (world, id, labelName, extra = {}) => world.remote({ id, label: labelName, caps: { v: 1, forward: true, peers: [], gateway: null }, ...extra });
const announce = (world, r, at = 0) => setTimeout(() => world.dispatch(r, { kind: 'caps', caps: r.caps }), at);

// Today's ladder with every new option unset. Each entry is a scripted situation; the golden
// trace of each one is recorded in tools/baselines/ladder.json.
export const SCENARIOS = {
  'direct-impolite': {
    runMs: 20000, connect: ({ negotiated }) => negotiated ? pairs.direct : null,
    setup({ world, IDS }) { announce(world, member(world, IDS.B, 'B')); },
  },
  'direct-polite': {
    runMs: 20000, self: IDS.Z, connect: ({ negotiated }) => negotiated ? pairs.direct : null,
    setup({ world, IDS }) { const b = member(world, IDS.B, 'B'); announce(world, b); setTimeout(() => world.offer(b), 200); },
  },
  'own-gateway': {
    runMs: 20000, ownGateway: true,
    connect: ({ negotiated, configured }) => negotiated && configured(GATEWAYS.own.internalUrls[0]) ? pairs.relay(GATEWAYS.own.internalUrls[0], '198.18.0.10') : null,
    setup({ world, IDS }) { announce(world, member(world, IDS.B, 'B')); },
  },
  'peer-gateway': {
    runMs: 20000,
    connect: ({ negotiated, configured }) => negotiated && configured(GATEWAYS.B.urls[0]) ? pairs.relay(GATEWAYS.B.urls[0], '198.18.0.20') : null,
    setup({ world, IDS }) { announce(world, member(world, IDS.B, 'B', { caps: { v: 1, forward: true, peers: [], gateway: GATEWAYS.B } })); },
  },
  'session-gateway': {
    runMs: 40000,
    connect: ({ negotiated, configured }) => negotiated && configured(GATEWAYS.gw.urls[0]) ? pairs.relay(GATEWAYS.gw.urls[0], '198.18.0.30') : null,
    setup({ world, IDS }) {
      const gw = world.remote({ id: IDS.gw, label: 'gw', caps: { v: 1, role: 'gateway', forward: false, peers: [], gateway: GATEWAYS.gw } });
      announce(world, gw);
      announce(world, member(world, IDS.B, 'B'), 10);
    },
  },
  bridged: {
    runMs: 40000,
    connect: ({ negotiated, peer }) => negotiated && peer === IDS.C ? pairs.direct : null,
    setup({ world, IDS }) {
      announce(world, member(world, IDS.C, 'C', { forwards: true, caps: { v: 1, forward: true, peers: [IDS.B], gateway: null } }));
      announce(world, member(world, IDS.B, 'B', { caps: { v: 1, forward: true, peers: [IDS.C], gateway: null } }), 10);
    },
  },
  'unreachable-backoff': {
    runMs: 800000,
    setup({ world, IDS }) { announce(world, member(world, IDS.B, 'B')); },
  },
  'unreachable-polite': {
    runMs: 400000, self: IDS.Z,
    setup({ world, IDS }) { const b = member(world, IDS.B, 'B'); announce(world, b); setTimeout(() => world.offer(b), 200); },
  },
  grace: {
    runMs: 60000, responses: () => 2,
    setup({ world, IDS }) { announce(world, member(world, IDS.B, 'B')); },
  },
  recovery: {
    runMs: 40000, connect: ({ negotiated }) => negotiated ? pairs.direct : null,
    setup({ world, IDS }) { announce(world, member(world, IDS.B, 'B')); setTimeout(() => world.setState(IDS.B, 'disconnected'), 10000); },
  },
  failed: {
    runMs: 40000, connect: ({ negotiated }) => negotiated ? pairs.direct : null,
    setup({ world, IDS }) { announce(world, member(world, IDS.B, 'B')); setTimeout(() => world.setState(IDS.B, 'failed'), 10000); },
  },
  'offer-timeout': {
    runMs: 60000,
    setup({ world, IDS }) { announce(world, member(world, IDS.B, 'B', { answers: false })); },
  },
};

// ---------- opt-in rungs (classifyNat, portPrediction, turn) ----------
export const APP_TURN = Object.freeze([{ urls: ['turn:turn.invalid:3478?transport=udp'], username: 'u-app', credential: 'c-app' }]);
// A peer behind a sequential NAT: per generation g it reports srflx ports 41000+10g+1 and +2 to the
// two STUN servers, and its checks to us leave from 41000+10g+shift.
const sequentialPeer = g => [`candidate:1 1 udp 2122260223 10.9.0.2 50100 typ host generation 0`,
  `candidate:2 1 udp 1686052607 198.51.100.20 ${41000 + 10 * g + 1} typ srflx raddr 10.9.0.2 rport 50100 generation 0`,
  `candidate:3 1 udp 1686052351 198.51.100.20 ${41000 + 10 * g + 2} typ srflx raddr 10.9.0.2 rport 50100 generation 0`];
const generationOf = pc => Number(/r(\d+)$/.exec(pc.remoteUfrag ?? '')?.[1] ?? 0);
const probed = (pc, port) => pc.remoteCandidates.some(c => c.split(' ')[5] === String(port));
const mappedAt = shift => ({ pc, negotiated }) => negotiated && probed(pc, 41000 + 10 * generationOf(pc) + shift) ? pairs.direct : null;
const viaTurn = ({ negotiated, configured }) => negotiated && configured(APP_TURN[0].urls[0]) ? pairs.relay(APP_TURN[0].urls[0], '198.18.9.9') : null;
const directOpen = ({ negotiated, pc, world }) => negotiated && world.directAfter !== undefined && pc.localGeneration > world.directAfter;
const sequentialMember = (world, IDS, extra = {}) => member(world, IDS.B, 'B', { candidates: sequentialPeer, caps: { v: 1, forward: true, peers: [], gateway: null, nat: { type: 'sequential', delta: 1 } }, ...extra });

export const FEATURE_SCENARIOS = {
  'classify-sequential': {
    runMs: 20000, options: { classifyNat: true }, nat: { type: 'sequential', delta: 1 },
    connect: ({ negotiated }) => negotiated ? pairs.direct : null,
    setup({ world, IDS }) { announce(world, member(world, IDS.B, 'B')); },
  },
  'predict-eim-to-sequential': {
    runMs: 40000, options: { portPrediction: true }, connect: mappedAt(4),
    setup({ world, IDS }) { announce(world, sequentialMember(world, IDS)); },
  },
  'predict-random-peer': {
    runMs: 40000, options: { portPrediction: true }, connect: mappedAt(4),
    setup({ world, IDS }) { announce(world, member(world, IDS.B, 'B', { candidates: sequentialPeer, caps: { v: 1, forward: true, peers: [], gateway: null, nat: { type: 'random', delta: 0 } } })); },
  },
  'turn-rung': {
    runMs: 40000, options: { turn: APP_TURN }, connect: viaTurn,
    setup({ world, IDS }) { announce(world, member(world, IDS.B, 'B')); },
  },
  'turn-rung-polite': {
    runMs: 40000, self: IDS.Z, options: { turn: APP_TURN }, connect: viaTurn,
    setup({ world, IDS }) { const b = member(world, IDS.B, 'B'); announce(world, b); setTimeout(() => world.offer(b), 200); },
  },
  'predict-then-turn': {
    runMs: 60000, options: { portPrediction: true, turn: APP_TURN },
    connect: args => mappedAt(30)(args) ?? viaTurn(args),
    setup({ world, IDS }) { announce(world, sequentialMember(world, IDS)); },
  },
  // Leaving the relay once it carries a pair (test/turn-upgrade.test.mjs).
  'turn-stays': {
    runMs: 250000, mediaWatch: true, options: { turn: APP_TURN }, connect: viaTurn,
    setup({ world, IDS }) { announce(world, member(world, IDS.B, 'B')); },
  },
  'turn-upgrade-direct': {
    // A direct route opens 30 s in, findable only by a later ICE generation; at 120 s it breaks again.
    runMs: 200000, mediaWatch: true, options: { turn: APP_TURN },
    connect: args => directOpen(args) ? pairs.direct : viaTurn(args),
    reselect: args => directOpen(args) ? pairs.direct : null,
    setup({ world, IDS }) {
      announce(world, member(world, IDS.B, 'B'));
      setTimeout(() => { world.directAfter = world.linkFor(IDS.B).pc.localGeneration; }, 30000);
      setTimeout(() => { world.directAfter = Infinity; world.setState(IDS.B, 'failed'); }, 120000);
    },
  },
  'turn-upgrade-gateway': {
    // B's own gateway comes up 20 s into a call the relay carries.
    runMs: 120000, mediaWatch: true, options: { turn: APP_TURN }, connect: viaTurn,
    reselect: ({ negotiated, configured }) => negotiated && configured(GATEWAYS.B.urls[0]) ? pairs.relay(GATEWAYS.B.urls[0], '198.18.0.20') : null,
    setup({ world, IDS }) {
      const b = member(world, IDS.B, 'B');
      announce(world, b);
      setTimeout(() => { b.caps = { ...b.caps, gateway: GATEWAYS.B }; world.dispatch(b, { kind: 'caps', caps: b.caps }); }, 20000);
    },
  },
  'turn-upgrade-polite': {
    // The impolite member restarts ICE once a direct route exists; the polite side never restarts for it.
    runMs: 120000, self: IDS.Z, mediaWatch: true, options: { turn: APP_TURN },
    connect: args => directOpen(args) ? pairs.direct : viaTurn(args),
    reselect: args => directOpen(args) ? pairs.direct : null,
    setup({ world, IDS }) {
      const b = member(world, IDS.B, 'B'); announce(world, b); setTimeout(() => world.offer(b), 200);
      setTimeout(() => { world.directAfter = world.linkFor(IDS.B).pc.localGeneration; world.offer(b); }, 30000);
    },
  },
  'turn-configuration-refused': {
    runMs: 60000, options: { turn: APP_TURN }, connect: viaTurn,
    checkConfiguration({ config }) { if (config.iceServers.some(s => s.username === 'u-app')) throw new Error('InvalidAccessError: TURN refused'); },
    setup({ world, IDS }) { announce(world, member(world, IDS.B, 'B')); },
  },
};
