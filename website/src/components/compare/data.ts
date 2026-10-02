// One source for the comparison on the home page and in the docs. Facts were checked against
// each project's own documentation, code and pricing pages on 2 October 2026; the sources are
// listed in docs/comparison.mdx.

/** Who pays for the audio and video that cannot go directly between two people. */
export type Bill = 'none' | 'yours' | 'provider';

export type Option = {
  name: string;
  href: string;
  /** What it is, in a few words. */
  kind: string;
  /** How people find each other. */
  signalling: string;
  /** Where media goes when two people cannot connect directly. */
  fallback: string;
  bill: Bill;
  billText: string;
  /** The room size it is built for. */
  size: string;
  /** End-to-end encryption of the media. */
  e2e: string;
  license: string;
  /** Shown on the home page as well as in the docs. */
  home?: boolean;
  ours?: boolean;
};

export const OPTIONS: Option[] = [
  {
    name: 'Freehop',
    href: '/docs',
    kind: 'Peer-to-peer SDK plus small signalling gates',
    signalling: 'Your gates, community gates and public WebTorrent trackers, all at once; sealed end to end',
    fallback: "Machines in the session: a participant's desktop gateway, the host node, or a forwarding participant",
    bill: 'none',
    billText: 'No operator media bill; session machines carry the traffic',
    size: '2 to 8 people (mesh)',
    e2e: 'Direct and gateway paths: yes. A forwarding participant decodes and re-encodes the media',
    license: 'Apache-2.0',
    home: true,
    ours: true,
  },
  {
    name: 'WebRTC + your own TURN',
    href: 'https://github.com/coturn/coturn',
    kind: 'The browser API, plus the servers you build (e.g. coturn)',
    signalling: 'You build it: WebRTC does not define signalling',
    fallback: 'Your TURN server',
    bill: 'yours',
    billText: 'Every relayed byte',
    size: 'Small groups (mesh), more with an SFU you add',
    e2e: 'Yes, between peers; TURN relays only see ciphertext',
    license: 'coturn: BSD-3-Clause',
    home: true,
  },
  {
    name: 'PeerJS',
    href: 'https://peerjs.com',
    kind: 'Library for one-to-one connections by peer id, with a signalling server (PeerServer)',
    signalling: 'PeerServer: the free shared cloud server or your own',
    fallback: 'A TURN server you supply. Its free TURN service closed in December 2023',
    bill: 'yours',
    billText: 'Yours, once you add TURN',
    size: 'One-to-one; groups are a mesh you build',
    e2e: 'Yes, between peers',
    license: 'MIT',
    home: true,
  },
  {
    name: 'Trystero',
    href: 'https://github.com/dmotz/trystero',
    kind: 'Serverless peer-to-peer rooms (mesh)',
    signalling: 'Nostr by default; also BitTorrent trackers, MQTT, Supabase, Firebase, IPFS or your own relay. Encrypted; a password makes the key private',
    fallback: 'A TURN server you add; by default only STUN, so hard-NAT pairs fail',
    bill: 'yours',
    billText: 'Yours, once you add TURN',
    size: 'Small groups (mesh)',
    e2e: 'Yes, between peers',
    license: 'MIT',
  },
  {
    name: 'LiveKit',
    href: 'https://livekit.io',
    kind: 'Open-source SFU server and SDKs, or LiveKit Cloud',
    signalling: 'The LiveKit server',
    fallback: 'Always the server: every stream goes through the SFU, with built-in TURN',
    bill: 'yours',
    billText: "Your servers' bandwidth, or Cloud pricing per minute and GB",
    size: 'Large rooms, livestreams, AI agents',
    e2e: 'Optional end-to-end encryption; otherwise the server can access the media',
    license: 'Apache-2.0',
    home: true,
  },
  {
    name: 'Jitsi Meet',
    href: 'https://jitsi.org',
    kind: 'Complete meeting app: Videobridge SFU with XMPP signalling',
    signalling: 'An XMPP server (Prosody)',
    fallback: 'With 2 people it tries a direct link; with 3 or more, every stream goes through the Videobridge',
    bill: 'yours',
    billText: "Your servers' bandwidth, or 8x8's hosted JaaS",
    size: 'Meetings with dozens of people',
    e2e: 'Optional, where the browser supports it; otherwise the Videobridge can access the media',
    license: 'Apache-2.0',
    home: true,
  },
  {
    name: 'mediasoup',
    href: 'https://mediasoup.org',
    kind: 'SFU library for Node.js or Rust, with a C++ media worker',
    signalling: 'You build it',
    fallback: 'Always your SFU server',
    bill: 'yours',
    billText: "Your servers' bandwidth",
    size: 'Large rooms you build yourself',
    e2e: 'Not built in; you can add it in your app',
    license: 'ISC',
  },
  {
    name: 'simple-peer',
    href: 'https://github.com/feross/simple-peer',
    kind: 'Thin wrapper around one WebRTC connection',
    signalling: 'You build it',
    fallback: 'A TURN server you add; by default only STUN',
    bill: 'yours',
    billText: 'Yours, once you add TURN',
    size: 'One-to-one; groups are a mesh you build',
    e2e: 'Yes, between peers',
    license: 'MIT',
  },
  {
    name: 'Hosted video APIs',
    href: 'https://developers.cloudflare.com/realtime/',
    kind: 'Managed services such as Daily, Agora, Twilio Video and Cloudflare Realtime',
    signalling: 'The provider',
    fallback: "The provider's servers: most send every stream through them",
    bill: 'provider',
    billText: 'Per participant-minute, or per GB (Cloudflare)',
    size: 'Large rooms, nothing to run',
    e2e: 'Varies by provider and mode; verify its E2EE options',
    license: 'Proprietary',
    home: true,
  },
  {
    name: 'Game platform networks',
    href: 'https://dev.epicgames.com/docs/epic-online-services/multiplayer/nat-p2p-interface/p2p-reference',
    kind: 'Steam Datagram Relay and Epic Online Services P2P: native game SDKs, not browsers',
    signalling: 'The platform',
    fallback: "The platform's relays: Valve's backbone, or Epic's relays on AWS",
    bill: 'provider',
    billText: 'The platform carries it (Epic: EOS is free; Steam relays need a Steam release)',
    size: 'Native games on those platforms',
    e2e: 'Depends on the platform',
    license: 'Proprietary (Valve open-sources the protocol library, without the relays)',
  },
];
