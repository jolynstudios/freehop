import {createAuthority} from 'freehop/authority';
import {createGate, GATE_PROTOCOL, GATE_LIMITS, randomTag, mintGateToken, verifyGateToken} from 'freehop/gate';
import {hostSession, sharedGateway, closeSharedGateway} from 'freehop/host';
import {startGateway, isPublicAddress} from 'freehop/relay';
import {joinAsGateway, GATEWAY_ID_PREFIX} from 'freehop/member';
import {createPortMapper, PortMapperError, parseDefaultGateway, detectGateway, parseIgdDescription, parseSoapFault, isPrivateIPv4} from 'freehop/port-mapper';
import {createTurnServer, classifyPeerAddress, DEFAULT_LIMITS} from 'freehop/turn';
import * as stun from 'freehop/stun';
import {installFreehopGateway, type GatewayIpcMain} from 'freehop/electron';
import {encodeTicket, decodeTicket, validTicket} from 'freehop/ticket';
import {mintGateToken as token} from 'freehop/tokens';
import {Buffer} from 'node:buffer';
import {createServer} from 'node:http';
const authority = createAuthority({app: 'test', gates: ['wss://example.com/gate'], gateTokenSecret: 'secret'});
const ticket = await authority.ticket('room', 'member');
const count: number = (await authority.openRoom('other')).members;
authority.describe('room')?.members.map((id) => id.toUpperCase());
const rotation = await authority.kick('room', 'member');
rotation.tickets.forEach((t) => encodeTicket(t));
const gate = await createGate({server: createServer(), authorize: (hello, req) => hello.v === GATE_PROTOCOL && !!req.url});
gate.url();
gate.stats();
gate.rooms();
await gate.close();
GATE_LIMITS.frame;
randomTag();
const hosted = await hostSession(ticket);
// @ts-expect-error availability must be narrowed before using gateway
hosted.gateway.info();
if (hosted.available) {
  hosted.gateway.info();
  hosted.drop('id');
  const ok: boolean = await hosted.update(ticket);
} else {
  const no: false = await hosted.refresh(ticket);
}
await hosted.close();
await closeSharedGateway();
const gateway = await startGateway({portMapping: false, relayScope: 'internal'});
const member = await joinAsGateway({gateway, gates: ticket.gates, secret: ticket.secret});
await member.rekey('next', {dropped: ['peer']});
member.setAuth();
await member.close();
GATEWAY_ID_PREFIX;
const mapper = await createPortMapper({methods: ['pcp', 'natpmp', 'upnp']});
mapper.on('renewed', (mapping) => {
  const port: number = mapping.externalPort;
});
mapper.on('lost', (mapping, error) => {
  const code: string = error.code;
});
const mapping = await mapper.map({protocol: 'udp', internalPort: 1234});
await mapper.unmap(mapping);
await mapper.probe();
await mapper.close();
new PortMapperError('bad', 'CODE');
parseDefaultGateway('linux', '');
await detectGateway();
parseIgdDescription('', 'http://example.com');
parseSoapFault('');
isPrivateIPv4('10.0.0.1');
const turn = await createTurnServer({
  authenticate: async () => 'password',
  listen: [{port: 0}, {transport: 'tls', key: Buffer.from('key'), cert: 'cert'}],
  mapRelayPort: async (port, family, signal) => (signal.aborted ? null : port),
});
turn.addresses();
turn.stats();
turn.relayedAddresses();
turn.revoke((u) => u === 'bad');
await turn.close();
DEFAULT_LIMITS.defaultLifetime;
classifyPeerAddress('127.0.0.1');
isPublicAddress('1.1.1.1');
const bytes: Buffer = stun.encode({method: stun.METHOD.BINDING, cls: stun.CLASS.REQUEST});
const msg = stun.decode(bytes);
if (msg) {
  stun.getAttr(msg, stun.ATTR.USERNAME)?.toString();
  const valid: boolean = stun.verifyFingerprint(msg).valid;
  stun.verifyIntegrity(msg, 'key');
}
stun.frameStreamMessages(bytes).rest;
stun.decodeAddress(stun.encodeAddress({address: '1.1.1.1', port: 1}));
declare const ipcMain: GatewayIpcMain;
const electron = installFreehopGateway({ipcMain, allowedOrigins: ['https://example.com']});
await electron.close();
const signed: string = mintGateToken('secret', {exp: 123});
verifyGateToken('secret', signed);
token('secret', {exp: 123});
decodeTicket(encodeTicket(ticket));
validTicket(ticket);
// @ts-expect-error expiry is required
mintGateToken('secret', {room: 'a'});
// @ts-expect-error no imaginary relay scope
startGateway({relayScope: 'global'});
// @ts-expect-error authentication hook returns credentials, not booleans
createTurnServer({authenticate: () => true});
// @ts-expect-error TLS listeners require key and cert
createTurnServer({authenticate: () => 'pw', listen: [{transport: 'tls'}]});
// @ts-expect-error transport must be UDP or TCP
mapper.map({protocol: 'quic', internalPort: 1234});
// @ts-expect-error no DOM ambient globals in a Node consumer
const domLeak: HTMLVideoElement = null;
