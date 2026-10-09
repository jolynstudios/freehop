import {connect, validTicket, encodeTicket, decodeTicket, type Session, type ConnectOptions, type Ticket, type DesktopGateway} from 'freehop';
import {connect as sdkConnect} from 'freehop/sdk';
import {join, Room, DEFAULT_LIMITS, DEFAULT_TIMING, PHASE, deriveRoom, randomId} from 'freehop/client';
import {type Ticket as TicketOnly} from 'freehop/ticket';
type IsAny<T> = 0 extends 1 & T ? true : false;
type Assert<T extends true> = T;
type TypedSession = Assert<IsAny<Awaited<ReturnType<typeof connect>>> extends false ? true : false>;
declare const ticket: Ticket;
declare const bridge: DesktopGateway;
const sameTicket: TicketOnly = ticket;
const options = {media: {audio: true, video: false}, desktopGateway: bridge, adaptiveVideo: true} satisfies ConnectOptions;
const session: Session = await connect(sameTicket, options);
const inferred = await sdkConnect(decodeTicket(encodeTicket(ticket)));
const id: string = inferred.id;
const unsubscribe = session.on('track', ({peer, track, stream, via}) => {
  const el: HTMLVideoElement = session.attach(track, document.createElement('video'));
  const origin: string | null = via;
  el.dataset.peer = peer;
  el.srcObject = stream;
  // @ts-expect-error event tracks are actual MediaStreamTrack values
  track.nonexistent();
});
unsubscribe();
session.on('message', ({data, from}) => {
  // @ts-expect-error incoming data must be validated first
  data.type;
  if (typeof data === 'string') document.title = from + data;
});
session.on('path', ({kind, rtt, localAddress}) => {
  const route: 'connecting' | 'direct' | 'gateway' | 'relay' | 'bridged' | 'unreachable' = kind;
  const address: string | null | undefined = localAddress;
  const latency: number | null | undefined = rtt;
});
session.on('video-quality', ({level}) => {
  const quality: 'normal' | 'reduced' | 'minimal' | 'paused' = level;
});
interface Cursor {
  type: string;
  x: number;
  label?: string;
}
const cursor: Cursor = {type: 'cursor', x: 3};
await session.send(cursor);
await session.send({type: 'cursor', x: 10, labels: ['one', null]});
const sent: number = await session.send('hello', {to: id});
const enabled: boolean = await session.setAdaptiveVideo(false);
await session.switchDevice('audio', null);
const snapshot = await session.stats();
snapshot.links.forEach((link) => {
  const rtt: number | null | undefined = link.path.rtt;
});
const levels: Record<string, number> = await session.levels();
await session.update(ticket, {dropped: ['peer-id']});
await session.refresh(ticket);
await session.disconnectPeer(id);
await session.leave();
declare const untrusted: unknown;
if (validTicket(untrusted)) {
  const version: 1 = untrusted.v;
}
const room: Room = await join({gates: ['wss://example.com/gate'], secret: 'secret', media: null});
await deriveRoom(new Uint8Array(32));
randomId(16);
DEFAULT_LIMITS.videoBitrate;
DEFAULT_TIMING.capsWaitMs;
PHASE.BRIDGED;
// @ts-expect-error media audio is a boolean
connect(ticket, {media: {audio: 'yes'}});
// @ts-expect-error no such event
session.on('unrecognized-event', () => {});
// @ts-expect-error callbacks receive the event's actual shape
session.on('track', ({madeUp}: {madeUp: string}) => {});
// @ts-expect-error JSON messages cannot contain bigint
session.send({value: 1n});
// @ts-expect-error functions cannot be sent
session.send(() => {});
// @ts-expect-error supported device kinds only
session.switchDevice('speaker', 'default');
// @ts-expect-error version is a literal
const badTicket: Ticket = {...ticket, v: 2};
// @ts-expect-error browser build has no Node ambient globals
const nodeLeak = process.version;

// Opt-in traversal aids: NAT classification, port prediction and an application TURN relay.
const traversal = {portPrediction: true, classifyNat: true, turn: [{urls: ['turn:turn.example.com:3478?transport=udp'], username: 'u', credential: 'c'}],
  timing: {predictMs: 8000, turnMs: 8000}, limits: {predictPorts: 4}} satisfies ConnectOptions;
const traversing = await connect(ticket, traversal);
const nat: 'eim' | 'sequential' | 'random' | 'unknown' | undefined = (await traversing.stats()).nat?.type;
const known: number | undefined = traversing.nat?.delta;
traversing.setTurn(null);
traversing.setTurn([{urls: 'turns:turn.example.com:5349?transport=tcp', username: 'u', credential: 'c'}]);
const ticketTurn: string | string[] | undefined = ticket.turn?.[0].urls;
// @ts-expect-error portPrediction is a boolean
connect(ticket, {portPrediction: 'yes'});
// @ts-expect-error TURN servers need credentials
connect(ticket, {turn: [{urls: 'turn:turn.example.com:3478'}]});
// @ts-expect-error no imaginary NAT type
const fullCone: typeof nat = 'full-cone';
// @ts-expect-error nested functions are not JSON messages
session.send({items: [() => {}]});
// @ts-expect-error undefined is not a top-level message
session.send(undefined);
