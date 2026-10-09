// The path ladder as a pure function, consistent with Freehop's client (room.mjs: escalate,
// sessionGatewayIds, bridgeCandidates) and with the NAT-lab scenarios in lab/nat-run.mjs.

export type Net = 'home' | 'strict' | 'udp' | 'v6' | 'upnp' | 'gateonly';
export type Kind = 'direct' | 'gateway' | 'relay' | 'bridged' | 'unreachable';
export type Extras = {desktop: boolean; host: boolean; third: boolean};

export const NETS: Record<Net, {label: string; tag: string; hint: string}> = {
  home: {
    label: 'Home router',
    tag: 'HOME',
    hint: 'An ordinary home router: it keeps one public port per socket (endpoint-independent mapping).',
  },
  strict: {
    label: 'Strict NAT',
    tag: 'STRICT NAT',
    hint: 'A symmetric NAT that picks a new random port for every destination, as some carrier and campus NATs do.',
  },
  udp: {
    label: 'UDP-blocked office',
    tag: 'NO UDP',
    hint: 'A firewall that drops all UDP. Outgoing TCP still works.',
  },
  v6: {
    label: 'IPv6',
    tag: 'IPv6',
    hint: 'A global IPv6 address behind a stateful firewall, with IPv4 UDP blocked.',
  },
  upnp: {
    label: 'Desktop app, UPnP router',
    tag: 'UPnP',
    hint: 'The desktop app runs its own gateway and the router maps its port (PCP, NAT-PMP or UPnP).',
  },
  gateonly: {
    label: 'Gate-only network',
    tag: 'GATE ONLY',
    hint: 'Only TCP to the gate host gets out. Nothing else does.',
  },
};

export type Verdict = {
  kind: Kind;
  /** Who carries the media when it is not direct. */
  via?: 'Ana' | 'Ben' | 'Dani' | 'host node' | 'Cleo';
  /** Escalation phase in which the route forms (0 endpoint, 1 session, 2 bridged). */
  phase: 0 | 1 | 2 | null;
  headline: string;
  why: string;
  lab?: {scenario: string; runs: string; gate: string; note?: string};
};

const udp4 = (n: Net) => n === 'home' || n === 'strict' || n === 'upnp';
const reachesPublic = (n: Net) => n !== 'gateonly';
const reachesOpenPeer = (n: Net) => udp4(n) || n === 'v6';

function canDirect(a: Net, b: Net) {
  if (a === 'gateonly' || b === 'gateonly' || a === 'udp' || b === 'udp') return false;
  if (a === 'v6' && b === 'v6') return true;
  if (a === 'v6' || b === 'v6') return false;
  if (a === 'strict' || b === 'strict') return false;
  return true;
}

function noDirectReason(a: Net, b: Net) {
  if (a === 'udp' || b === 'udp') {
    return a === b ? 'Both offices drop UDP, and browsers send media over UDP.' : `${a === 'udp' ? "Ana's" : "Ben's"} office drops UDP, and browsers send media over UDP.`;
  }
  if ((a === 'v6') !== (b === 'v6')) return `${a === 'v6' ? 'Ana' : 'Ben'} can only send UDP over IPv6, and the other side only has IPv4.`;
  if (a === 'strict' && b === 'strict') return 'Both strict NATs pick a new random port for every destination, so neither side can predict where to send.';
  if (a === 'strict' || b === 'strict') {
    return `${a === 'strict' ? "Ana's" : "Ben's"} strict NAT picks a new random port for every destination, and the other router only lets in replies from addresses it has already sent to.`;
  }
  return 'There is no common route between the two networks.';
}

function labFor(a: Net, b: Net, v: Omit<Verdict, 'lab'>): Verdict['lab'] {
  const pair = [a, b].sort().join('+');
  const via = v.via;
  if (a === 'gateonly' || b === 'gateonly') return {scenario: 'gate-only', runs: '3/3', gate: '207 KB', note: 'The gate-only peer stays unreachable there too, as expected.'};
  if (pair === 'home+home' && v.kind === 'direct') return {scenario: 'direct-eim', runs: '3/3 Chromium, 1/1 Firefox + WebKit', gate: '31–34 KB'};
  if (pair === 'v6+v6' && v.kind === 'direct') return {scenario: 'ipv6-direct', runs: '3/3 Chromium, 1/1 Firefox + WebKit', gate: '30–34 KB'};
  if (pair === 'strict+strict') {
    if (v.kind === 'unreachable') return {scenario: 'hard-pair', runs: '3/3', gate: '93 KB', note: 'The pair stays unreachable there too, as expected.'};
    if (v.kind === 'bridged') return {scenario: 'hard-pair-bridge', runs: '3/3 Chromium, 1/1 mixed engines', gate: '91–115 KB'};
    if (v.kind === 'relay' && via === 'Dani') return {scenario: 'hard-pair-gateway', runs: '3/3 Chromium, 1/1 mixed engines', gate: '143–201 KB'};
    if (v.kind === 'relay' && via === 'host node') return {scenario: 'hard-pair-host-node', runs: '3/3 Chromium, 1/1 Firefox + WebKit', gate: '62–73 KB'};
  }
  if (pair === 'strict+upnp' && v.kind === 'gateway') return {scenario: 'two-peer-desktop-host', runs: '3/3 Chromium, 1/1 WebKit + Firefox', gate: '34–66 KB'};
  if (pair === 'udp+upnp' && v.kind === 'gateway') return {scenario: 'udpblock-gateway', runs: '3/3 Chromium, 1/1 Firefox + Chromium', gate: '31–63 KB'};
  if (pair === 'udp+udp') {
    if (v.kind === 'relay' && via === 'Dani') return {scenario: 'udpblock-pair-gateway', runs: '3/3 Chromium', gate: '130–158 KB'};
    if (v.kind === 'relay' && via === 'host node') return {scenario: 'udpblock-pair-host-node', runs: '3/3 Chromium', gate: '65 KB'};
  }
  return undefined;
}

const list = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}` : items[0]);

export function decide(a: Net, b: Net, x: Extras): Verdict {
  const v = decideRoute(a, b, x);
  return {...v, lab: labFor(a, b, v)};
}

function decideRoute(a: Net, b: Net, x: Extras): Omit<Verdict, 'lab'> {
  if (a === 'gateonly' || b === 'gateonly') {
    const who = a === 'gateonly' && b === 'gateonly' ? 'Both networks only let' : `${a === 'gateonly' ? "Ana's" : "Ben's"} network only lets`;
    return {
      kind: 'unreachable',
      phase: null,
      headline: 'Unreachable, and Freehop says so.',
      why: `${who} TCP to the gate host out. Media could only pass through your gate, and Freehop never sends media through a gate. Desktop gateways, host nodes and participants cannot help either: nothing gets out to reach them. The pair reports unreachable and retries quietly.`,
    };
  }
  if (canDirect(a, b)) {
    const v6 = a === 'v6' && b === 'v6';
    return {
      kind: 'direct',
      phase: 0,
      headline: 'Direct, home to home.',
      why: v6
        ? 'Both have global IPv6 addresses. Each side sends first, so each firewall lets the replies in. No NAT is involved at all.'
        : 'Both routers keep one public port per socket, so the addresses each side learns from STUN also work for the other. ICE connects in the first phase.',
    };
  }
  const reason = noDirectReason(a, b);
  if (a === 'upnp' || b === 'upnp') {
    const owner = a === 'upnp' ? 'Ana' : 'Ben';
    const other = owner === 'Ana' ? 'Ben' : 'Ana';
    const otherNet = owner === 'Ana' ? b : a;
    const tcp = otherNet === 'udp' || otherNet === 'v6';
    return {
      kind: 'gateway',
      via: owner,
      phase: 0,
      headline: `Through ${owner}'s own front door.`,
      why: `${reason} But ${owner}'s desktop app runs a TURN gateway on ${owner}'s own machine, and the router mapped its port. ${other} reaches it${tcp ? ' over TCP' : ''} and the gateway hands the packets inside. ${owner}'s own gateway is offered in the very first phase, so no third party is involved.`,
    };
  }
  if ((x.desktop || x.host) && reachesPublic(a) && reachesPublic(b)) {
    const via = x.host ? 'host node' : 'Dani';
    const both = x.host && x.desktop;
    const tcp = a === 'udp' || b === 'udp' || a === 'v6' || b === 'v6';
    return {
      kind: 'relay',
      via,
      phase: 1,
      headline: via === 'host node' ? "Relayed by the session's host node." : "Relayed by Dani's desktop gateway.",
      why: `${reason} After the 5-second endpoint budget (plus a grace period if checks get answers), Freehop adds the gateways of other session members (up to two at a time${both ? ': here the host node and Dani' : ''}) and restarts ICE. ${via === 'host node' ? "The host node's" : "Dani's"} gateway is reachable from both of you${tcp ? ' (TCP where UDP is blocked)' : ''}, so media relays there. It stays encrypted end to end: the relay only moves ciphertext.`,
    };
  }
  if (x.third && reachesOpenPeer(a) && reachesOpenPeer(b)) {
    return {
      kind: 'bridged',
      via: 'Cleo',
      phase: 2,
      headline: 'Bridged by Cleo, who is in the call anyway.',
      why: `${reason} There is no gateway in the session, but Cleo has an open connection and is linked to both of you. After the gateway phase, she forwards your media: she already receives it, and re-encodes it for the other side (forwarded video is capped at 200 kbit/s).`,
    };
  }
  const missing: string[] = [];
  if (!x.desktop) missing.push('a desktop participant');
  if (!x.host) missing.push('a host node');
  if (!x.third) missing.push('a third participant');
  const thirdUseless = x.third && !(reachesOpenPeer(a) && reachesOpenPeer(b));
  return {
    kind: 'unreachable',
    phase: null,
    headline: 'Unreachable for now, and Freehop says so.',
    why: `${reason} ${thirdUseless ? 'Cleo cannot reach a UDP-blocked office either, so she cannot bridge. ' : ''}Nobody inside the session can carry the media, so by default Freehop reports unreachable instead of renting a relay, and retries with an ICE restart after 30 seconds, backing off to every 5 minutes.${missing.length ? ` Add ${list(missing)} with a working route to both endpoints to make another path possible.` : ''}`,
  };
}
