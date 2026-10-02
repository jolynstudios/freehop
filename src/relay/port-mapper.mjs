// SPDX-License-Identifier: Apache-2.0
// peerlane port mapper: asks the home router to forward an inbound UDP/TCP port so a desktop player or a
// volunteer relay becomes directly reachable. Speaks PCP (RFC 6887), NAT-PMP (RFC 6886) and UPnP IGD v1/v2
// (SSDP discovery + SOAP WANIPConnection/WANPPPConnection). Node built-ins only.
//
//   const mapper = await createPortMapper({ log: (event, details) => console.debug(event, details) });
//   const status = await mapper.probe();
//   const mapping = await mapper.map({ protocol: 'udp', internalPort: 3478 });
//   mapper.on('renewed', (m) => {}).on('lost', (m, err) => {});
//   await mapper.close();

import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { randomBytes, randomInt } from 'node:crypto';

const METHODS = ['pcp', 'natpmp', 'upnp'];
const DEFAULTS = { methods: METHODS, timeoutMs: 2500, pcpPort: 5351, natpmpPort: 5351, ssdpAddress: '239.255.255.250', ssdpPort: 1900 };

const PCP_VERSION = 2;
const OP_ANNOUNCE = 0;
const OP_MAP = 1;
const PCP_RESULTS = ['SUCCESS', 'UNSUPP_VERSION', 'NOT_AUTHORIZED', 'MALFORMED_REQUEST', 'UNSUPP_OPCODE', 'UNSUPP_OPTION', 'MALFORMED_OPTION',
  'NETWORK_FAILURE', 'NO_RESOURCES', 'UNSUPP_PROTOCOL', 'USER_EX_QUOTA', 'CANNOT_PROVIDE_EXTERNAL', 'ADDRESS_MISMATCH', 'EXCESSIVE_REMOTE_PEERS'];
const PCP_SHORT_LIVED = new Set([7, 8, 10, 11]); // RFC 6887 §7.4: short-lifetime errors, worth retrying later
const NATPMP_RESULTS = ['SUCCESS', 'UNSUPP_VERSION', 'NOT_AUTHORIZED', 'NETWORK_FAILURE', 'OUT_OF_RESOURCES', 'UNSUPP_OPCODE'];
const NATPMP_RETRYABLE = new Set([3, 4]);

const IGD_TARGETS = ['urn:schemas-upnp-org:device:InternetGatewayDevice:2', 'urn:schemas-upnp-org:device:InternetGatewayDevice:1'];
const WAN_SERVICES = ['urn:schemas-upnp-org:service:WANIPConnection:2', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];
const IGD_HINT = /InternetGatewayDevice|WAN(?:IP|PPP)Connection|WANConnectionDevice|WANDevice/i;
const UPNP_ERRORS = {
  401: 'Invalid Action', 402: 'Invalid Args', 501: 'Action Failed', 602: 'Optional Action Not Implemented', 606: 'Action Not Authorized',
  714: 'NoSuchEntryInArray', 715: 'WildCardNotPermittedInSrcIP', 716: 'WildCardNotPermittedInExtPort', 718: 'ConflictInMappingEntry',
  724: 'SamePortValuesRequired', 725: 'OnlyPermanentLeasesSupported', 726: 'RemoteHostOnlySupportsWildcard', 727: 'ExternalPortOnlySupportsWildcard',
  728: 'NoPortMapsAvailable', 729: 'ConflictWithOtherMechanisms', 732: 'WildCardNotPermittedInIntPort',
};
const XML_LIMIT = 64 * 1024;
const SSDP_LIMIT = 4096;
const UPNP_MAX_LEASE = 604800; // IGDv2 upper bound; several v1 routers reject more as well
const CONFLICT_ATTEMPTS = 5;
const UNAVAILABLE_TTL_MS = 30_000;
const MIN_RETRY_MS = 250;
const MAX_TIMER_MS = 2 ** 31 - 1;

// ---------------------------------------------------------------------------------------------------------------
// errors

export class PortMapperError extends Error {
  constructor(message, code, { cause, ...details } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PortMapperError';
    this.code = code;
    Object.assign(this, details); // method, transient, unavailable, resultCode, upnpErrorCode, errors, ...
  }
}
const fail = (message, code, details) => new PortMapperError(message, code, details);
const aborted = () => fail('operation aborted: port mapper closed', 'ABORTED');
const closedError = () => fail('port mapper is closed', 'CLOSED');

// ---------------------------------------------------------------------------------------------------------------
// IPv4 helpers

const isV4 = (ip) => typeof ip === 'string' && net.isIPv4(ip);
const v4Int = (ip) => ip.split('.').reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
const inCidr = (ip, base, bits) => bits <= 0 || ((v4Int(ip) ^ v4Int(base)) >>> (32 - bits)) === 0;
const maskBits = (mask) => { let n = v4Int(mask), bits = 0; while (n & 0x80000000) { bits++; n = (n << 1) >>> 0; } return bits; };
const isV4Family = (entry) => entry.family === 'IPv4' || entry.family === 4;
const validPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535;
const externalOrNull = (ip) => (isV4(ip) && ip !== '0.0.0.0' ? ip : null);

// Not globally routable: RFC 1918, RFC 6598 CGNAT, loopback, link-local, "this network", IETF protocol assignments
// (DS-Lite B4 192.0.0.2), benchmarking, multicast/reserved/broadcast. A router reporting one of these as its WAN
// address sits behind another NAT, so a mapping on it does not make the host reachable from the Internet.
const NON_PUBLIC_V4 = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]];
export const isPrivateIPv4 = (ip) => isV4(ip) && NON_PUBLIC_V4.some(([base, bits]) => inCidr(ip, base, bits));

const writeMappedV4 = (buf, offset, ip) => { buf.fill(0, offset, offset + 10); buf.writeUInt16BE(0xffff, offset + 10); buf.writeUInt32BE(v4Int(ip), offset + 12); };
const readMappedV4 = (buf, offset) => {
  for (let i = offset; i < offset + 10; i++) if (buf[i] !== 0) return null;
  return buf.readUInt16BE(offset + 10) === 0xffff ? [...buf.subarray(offset + 12, offset + 16)].join('.') : null;
};

// ---------------------------------------------------------------------------------------------------------------
// gateway and local address discovery

/** Parse default-route output: platform 'linux' (/proc/net/route), 'ip' (`ip -4 route show default`), 'win32' (`route print -4`), else BSD/darwin (`route -n get default`). */
export function parseDefaultGateway(platform, text) {
  const out = String(text ?? '');
  let best = null;
  const consider = (gateway, iface, metric) => {
    if (isV4(gateway) && gateway !== '0.0.0.0' && (!best || metric < best.metric)) best = { gateway, interface: iface, metric };
  };
  if (platform === 'linux') {
    for (const line of out.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 8 || f[1] !== '00000000' || f[7] !== '00000000' || (parseInt(f[3], 16) & 3) !== 3) continue; // default, RTF_UP|RTF_GATEWAY
      const g = parseInt(f[2], 16) >>> 0;
      consider([0, 8, 16, 24].map((shift) => (g >>> shift) & 255).join('.'), f[0], Number(f[6]) || 0); // little-endian hex
    }
  } else if (platform === 'ip') {
    for (const m of out.matchAll(/^default\s+via\s+(\S+)\s+dev\s+(\S+)(?:.*?\bmetric\s+(\d+))?/gm)) consider(m[1], m[2], Number(m[3] ?? 0));
  } else if (platform === 'win32') {
    for (const m of out.matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s*$/gm)) consider(m[1], m[2], Number(m[3]));
  } else {
    consider(/^\s*gateway:\s*(\S+)\s*$/m.exec(out)?.[1], /^\s*interface:\s*(\S+)\s*$/m.exec(out)?.[1], 0);
  }
  return best && { gateway: best.gateway, interface: best.interface ?? null };
}

/** Find the default IPv4 gateway. Fixed argv, no shell, bounded time. Resolves { gateway, interface } or null. */
export async function detectGateway({ timeoutMs = 2500, signal } = {}) {
  const run = (file, args) => new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024, signal, env: { ...process.env, LC_ALL: 'C' } },
        (err, stdout) => resolve(err ? '' : String(stdout)));
    } catch { resolve(''); }
  });
  if (process.platform === 'win32') {
    const exe = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\route.exe` : 'route';
    return parseDefaultGateway('win32', await run(exe, ['print', '-4', '0.0.0.0'])) ?? parseDefaultGateway('win32', await run(exe, ['print', '-4']));
  }
  if (process.platform === 'linux' || process.platform === 'android') {
    const table = await readFile('/proc/net/route', 'utf8').catch(() => '');
    return parseDefaultGateway('linux', table) ?? parseDefaultGateway('ip', await run('ip', ['-4', 'route', 'show', 'default']));
  }
  const out = (await run('/sbin/route', ['-n', 'get', 'default'])) || (await run('route', ['-n', 'get', 'default']));
  return parseDefaultGateway(process.platform, out);
}

function localAddressFor(gateway, hint) {
  const matches = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (!isV4Family(a) || !isV4(a.address) || !isV4(a.netmask)) continue;
      const bits = maskBits(a.netmask);
      if (bits > 0 && inCidr(gateway, a.address, bits)) matches.push({ name, address: a.address });
    }
  }
  return (matches.find((m) => m.name === hint || m.address === hint) ?? matches[0])?.address ?? null;
}

function prefixFor(localAddress) {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (isV4Family(a) && a.address === localAddress && isV4(a.netmask)) return maskBits(a.netmask);
  }
  return 32;
}

// Ask the kernel which source address it would use towards the gateway (UDP connect sends nothing).
async function routedLocalAddress(gateway) {
  const sock = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => { sock.once('error', reject); sock.connect(9, gateway, resolve); });
    const { address } = sock.address();
    return isV4(address) && address !== '0.0.0.0' ? address : null;
  } catch {
    return null;
  } finally {
    try { sock.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------------------------------------------
// transports

// One request/response over a fresh *connected* UDP socket (the kernel drops datagrams from anyone but the gateway
// port, and ICMP port-unreachable surfaces as ECONNREFUSED for a fast fallback). Retransmits with doubling backoff
// (250 ms, 500 ms, ...) inside timeoutMs. decode(msg) returns a value, undefined (not ours: keep waiting) or throws.
function udpExchange({ host, port, localAddress, payload, timeoutMs, signal, decode, label }) {
  return new Promise((resolve, reject) => {
    let sock = null, done = false, resend = null, rto = 250;
    const until = Date.now() + timeoutMs;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(resend);
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      try { sock?.close(); } catch {}
      if (err) reject(err); else resolve(value);
    };
    const onAbort = () => finish(aborted());
    const netError = (err) => finish(['ECONNREFUSED', 'ECONNRESET'].includes(err?.code)
      ? fail(`${label}: ${host}:${port} is unreachable (port closed)`, 'UNREACHABLE', { transient: true, unavailable: true, cause: err })
      : fail(`${label}: socket error ${err?.code ?? err?.message}`, 'SOCKET_ERROR', { transient: true, unavailable: true, cause: err }));
    const deadline = setTimeout(() => finish(fail(`${label}: no response from ${host}:${port} within ${timeoutMs} ms`, 'TIMEOUT', { transient: true, unavailable: true })), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const send = () => {
      if (done) return;
      try { sock.send(payload, (err) => err && netError(err)); } catch (err) { return netError(err); }
      const wait = Math.min(rto, until - Date.now());
      rto *= 2;
      if (wait > 0) resend = setTimeout(send, wait);
    };
    try {
      sock = dgram.createSocket('udp4');
      sock.on('error', netError);
      sock.on('message', (msg) => {
        if (done) return;
        let value;
        try { value = decode(msg); } catch (err) { return finish(err); }
        if (value !== undefined) finish(null, value);
      });
      sock.bind({ address: localAddress, port: 0 }, () => {
        if (done) return;
        try { sock.connect(port, host, (err) => (err ? netError(err) : send())); } catch (err) { netError(err); }
      });
    } catch (err) {
      netError(err);
    }
  });
}

// Single HTTP/1.1 request (no keep-alive agent, so no socket outlives the call), total-time bounded, body capped.
function httpExchange(url, { method = 'GET', headers = {}, body, timeoutMs, signal, localAddress, limit = XML_LIMIT }) {
  return new Promise((resolve, reject) => {
    let req = null, done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { req?.destroy(); } catch {}
      if (err) reject(err); else resolve(value);
    };
    const onAbort = () => finish(aborted());
    const where = `HTTP ${method} ${url.host}${url.pathname}`;
    const transportError = (err) => finish(fail(`${where}: ${err?.code ?? err?.message}`, 'HTTP_ERROR', { transient: true, cause: err }));
    const tooLarge = () => finish(fail(`${where}: response larger than ${limit} bytes`, 'TOO_LARGE'));
    const timer = setTimeout(() => finish(fail(`${where}: no complete response within ${timeoutMs} ms`, 'TIMEOUT', { transient: true })), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      req = http.request({
        host: url.hostname, port: url.port || 80, path: `${url.pathname}${url.search}`, method, agent: false, localAddress,
        insecureHTTPParser: true, // consumer router firmware ships sloppy HTTP; one request per connection, size-capped
        headers: body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) },
      });
    } catch (err) {
      return transportError(err);
    }
    req.on('error', transportError);
    req.on('response', (res) => {
      if (Number(res.headers['content-length']) > limit) return tooLarge();
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => { size += chunk.length; if (size > limit) tooLarge(); else chunks.push(chunk); });
      res.on('error', transportError);
      res.on('end', () => finish(null, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('close', () => { if (!res.complete) transportError(new Error('connection closed mid-response')); });
    });
    req.end(body);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// PCP (RFC 6887) and NAT-PMP (RFC 6886) wire formats

function encodePcp(op, { lifetime = 0, client, nonce, protocol, internalPort, externalPort = 0, externalAddress = '0.0.0.0' }) {
  const buf = Buffer.alloc(op === OP_MAP ? 60 : 24);
  buf[0] = PCP_VERSION;
  buf[1] = op; // R bit 0: request
  buf.writeUInt32BE(lifetime, 4);
  writeMappedV4(buf, 8, client); // client IP as IPv4-mapped IPv6
  if (op === OP_MAP) {
    nonce.copy(buf, 24);
    buf[36] = protocol === 'tcp' ? 6 : 17;
    buf.writeUInt16BE(internalPort, 40);
    buf.writeUInt16BE(externalPort, 42);
    writeMappedV4(buf, 44, externalAddress); // ::ffff:0.0.0.0 = no preference
  }
  return buf;
}

const pcpError = (op, result, lifetime, extra) => {
  const name = PCP_RESULTS[result] ?? `PCP_RESULT_${result}`;
  return fail(`PCP ${op === OP_MAP ? 'MAP' : 'ANNOUNCE'} refused: ${name}`, name, {
    method: 'pcp', resultCode: result, errorLifetime: lifetime, transient: PCP_SHORT_LIVED.has(result),
    unavailable: result === 1 || (op === OP_MAP && result === 4), ...extra,
  });
};

function decodePcp(msg, { op, nonce, protocol, internalPort }, ignore) {
  if (msg.length < 4) return ignore('short');
  if (msg[0] !== PCP_VERSION) {
    // A NAT-PMP-only gateway answers a v2 request with a v0 "unsupported version" (RFC 6887 §9 / RFC 6886 §3.5);
    // a PCP server speaking another version answers UNSUPP_VERSION with its own version number.
    if ((msg[0] === 0 && msg[1] >= 128) || ((msg[1] & 0x80) && msg[3] === 1)) throw pcpError(op, 1, 0, { serverVersion: msg[0] });
    return ignore('version');
  }
  if (msg.length < 24 || msg.length > 1100 || msg.length % 4) return ignore('length');
  if (!(msg[1] & 0x80) || (msg[1] & 0x7f) !== op) return ignore('opcode');
  const result = msg[3], lifetime = msg.readUInt32BE(4), epoch = msg.readUInt32BE(8);
  if (op === OP_MAP) {
    if (msg.length >= 60) {
      if (!msg.subarray(24, 36).equals(nonce)) return ignore('nonce-mismatch');
      if (msg[36] !== (protocol === 'tcp' ? 6 : 17) || msg.readUInt16BE(40) !== internalPort) return ignore('mapping-mismatch');
    } else if (result === 0) {
      return ignore('length');
    }
  }
  if (result !== 0) throw pcpError(op, result, lifetime, { epoch });
  return op === OP_MAP ? { epoch, lifetime, externalPort: msg.readUInt16BE(42), externalAddress: readMappedV4(msg, 44) } : { epoch };
}

function encodeNatpmpMap(protocol, internalPort, externalPort, lifetime) {
  const buf = Buffer.alloc(12);
  buf[1] = protocol === 'udp' ? 1 : 2;
  buf.writeUInt16BE(internalPort, 4);
  buf.writeUInt16BE(externalPort, 6);
  buf.writeUInt32BE(lifetime, 8);
  return buf;
}

const natpmpError = (result, extra) => {
  const name = NATPMP_RESULTS[result] ?? `NATPMP_RESULT_${result}`;
  return fail(`NAT-PMP request refused: ${name}`, name, { method: 'natpmp', resultCode: result, transient: NATPMP_RETRYABLE.has(result), unavailable: result === 1 || result === 5, ...extra });
};

function decodeNatpmp(msg, op, internalPort, ignore) {
  if (msg.length < 4) return ignore('short');
  if (msg[0] !== 0) {
    if ((msg[1] & 0x80) && msg[3] === 1) throw natpmpError(1, { serverVersion: msg[0] }); // PCP-only server (RFC 6887 §9)
    return ignore('version');
  }
  if (msg[1] !== 128 + op) return ignore('opcode');
  const result = msg.readUInt16BE(2);
  if (result !== 0) throw natpmpError(result);
  if (op === 0) return msg.length < 12 ? ignore('length') : { epoch: msg.readUInt32BE(4), externalAddress: [...msg.subarray(8, 12)].join('.') };
  if (msg.length < 16) return ignore('length');
  if (msg.readUInt16BE(8) !== internalPort) return ignore('mapping-mismatch');
  return { epoch: msg.readUInt32BE(4), externalPort: msg.readUInt16BE(10), lifetime: msg.readUInt32BE(12) };
}

// ---------------------------------------------------------------------------------------------------------------
// minimal bounded XML handling (router descriptions and SOAP bodies are capped at 64 KiB before parsing)

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s) => s.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos));/gi, (_, hex, dec, named) => {
  if (named) return XML_ENTITIES[named.toLowerCase()];
  const cp = hex ? parseInt(hex, 16) : Number(dec);
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
});
const escapeXml = (value) => String(value).replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[c]};`);
const openTag = (tag) => `<(?:[\\w.-]{1,32}:)?${tag}(?:\\s[^<>]{0,512})?>`;
const closeTag = (tag) => `<\\/(?:[\\w.-]{1,32}:)?${tag}\\s*>`;

/** Text content of the first <tag> (any namespace prefix), entity-decoded and trimmed; null if absent. */
function xmlText(xml, tag) {
  const m = new RegExp(`${openTag(tag)}([^<]{0,4096})${closeTag(tag)}`, 'i').exec(xml);
  return m ? decodeXml(m[1]).trim() : null;
}

function* xmlElements(xml, tag, max = 64) {
  const open = new RegExp(openTag(tag), 'gi');
  const close = new RegExp(closeTag(tag), 'gi');
  for (let n = 0; n < max && open.exec(xml); n++) {
    close.lastIndex = open.lastIndex;
    const end = close.exec(xml);
    if (!end) return;
    yield xml.slice(open.lastIndex, end.index);
    open.lastIndex = close.lastIndex;
  }
}

/** WAN connection services in an IGD description, best first (WANIPConnection:2, :1, WANPPPConnection:1). */
export function parseIgdDescription(xml, location) {
  let base = location;
  const urlBase = xmlText(xml, 'URLBase');
  if (urlBase) try { base = new URL(urlBase).href; } catch {}
  const services = [];
  for (const block of xmlElements(xml, 'service')) {
    const serviceType = xmlText(block, 'serviceType'), control = xmlText(block, 'controlURL');
    const rank = serviceType ? WAN_SERVICES.findIndex((s) => s.toLowerCase() === serviceType.toLowerCase()) : -1;
    if (rank < 0 || !control) continue;
    try { services.push({ serviceType, version: rank === 0 ? 2 : 1, rank, controlURL: new URL(control, base).href }); } catch {}
  }
  return services.sort((a, b) => a.rank - b.rank);
}

/** { errorCode, errorDescription, faultCode, faultString } for a SOAP fault / UPnPError body, else null. */
export function parseSoapFault(xml) {
  if (typeof xml !== 'string' || !/<(?:[\w.-]{1,32}:)?(?:Fault|UPnPError)[\s>]/i.test(xml)) return null;
  const code = xmlText(xml, 'errorCode');
  return {
    errorCode: code && /^\d{1,4}$/.test(code) ? Number(code) : null,
    errorDescription: xmlText(xml, 'errorDescription'),
    faultCode: xmlText(xml, 'faultcode'),
    faultString: xmlText(xml, 'faultstring'),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// the mapper

function normalizeRequest(request) {
  const protocol = String(request?.protocol ?? '').toLowerCase();
  if (protocol !== 'udp' && protocol !== 'tcp') throw new TypeError("map(): protocol must be 'udp' or 'tcp'");
  const { internalPort } = request;
  const suggestedExternalPort = request.suggestedExternalPort ?? internalPort, lifetimeSeconds = request.lifetimeSeconds ?? 7200;
  if (!validPort(internalPort)) throw new TypeError('map(): internalPort must be an integer 1-65535');
  if (!(suggestedExternalPort === 0 || validPort(suggestedExternalPort))) throw new TypeError('map(): suggestedExternalPort must be an integer 0-65535');
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 0xffffffff) throw new TypeError('map(): lifetimeSeconds must be a positive integer');
  const description = String(request.description ?? 'peerlane').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64) || 'peerlane';
  return { protocol, internalPort, suggestedExternalPort, lifetimeSeconds, description };
}

const brief = ({ mapping: m }) => ({ method: m.method, protocol: m.protocol, internalPort: m.internalPort, externalAddress: m.externalAddress, externalPort: m.externalPort, lifetimeSeconds: m.lifetimeSeconds });

class PortMapper extends EventEmitter {
  #o;
  #methods;
  #timeoutMs;
  #ac = new AbortController(); // in-flight probe/map/renew work, aborted by close()
  #teardown = new AbortController(); // deletes keep their own budget so close() can still unmap
  #closed = false;
  #closing = null;
  #net = null;
  #netPromise = null;
  #active = new Map(); // `${protocol}:${internalPort}` -> record
  #pending = new Map(); // same key -> in-flight map() promise
  #deleting = new Set();
  #unavailable = new Map(); // method -> skip-until timestamp
  #igdCache = null; // { promise, value }
  #epochs = new Map(); // method -> { server, client } (seconds)
  #resetAt = new Map();
  #nonces = new Map(); // `${protocol}:${internalPort}` -> PCP nonce, kept until a confirmed delete

  constructor(options) {
    super();
    const o = { ...DEFAULTS };
    for (const [key, value] of Object.entries(options ?? {})) if (value !== undefined) o[key] = value;
    if (o.gateway !== undefined && !isV4(o.gateway)) throw new TypeError('createPortMapper(): gateway must be an IPv4 address');
    if (o.localAddress !== undefined && !isV4(o.localAddress)) throw new TypeError('createPortMapper(): localAddress must be an IPv4 address');
    const methods = [...new Set(Array.isArray(o.methods) ? o.methods : [o.methods])];
    if (!methods.length || methods.some((m) => !METHODS.includes(m))) throw new TypeError(`createPortMapper(): methods must be a non-empty subset of ${METHODS.join(', ')}`);
    if (!(Number.isFinite(o.timeoutMs) && o.timeoutMs >= 50 && o.timeoutMs <= 60_000)) throw new TypeError('createPortMapper(): timeoutMs must be 50-60000');
    for (const key of ['pcpPort', 'natpmpPort', 'ssdpPort']) if (!validPort(o[key])) throw new TypeError(`createPortMapper(): ${key} must be a port number`);
    if (!isV4(o.ssdpAddress)) throw new TypeError('createPortMapper(): ssdpAddress must be an IPv4 address');
    if (o.log !== undefined && typeof o.log !== 'function') throw new TypeError('createPortMapper(): log must be a function');
    this.#o = o;
    this.#methods = methods;
    this.#timeoutMs = o.timeoutMs;
  }

  get gateway() { return this.#net?.gateway ?? this.#o.gateway ?? null; }
  get localAddress() { return this.#net?.localAddress ?? this.#o.localAddress ?? null; }
  get closed() { return this.#closed; }
  get mappings() { return [...this.#active.values()].map((r) => r.mapping); }

  /** Read-only capability check: PCP ANNOUNCE, NAT-PMP external address, UPnP discovery + GetExternalIPAddress. */
  async probe() {
    this.#assertOpen();
    let netInfo;
    try {
      netInfo = await this.#network();
    } catch (err) {
      this.#assertOpen();
      return { gateway: this.#o.gateway ?? null, localAddress: this.#o.localAddress ?? null, available: { pcp: false, natpmp: false, upnp: false },
        externalAddress: null, externalAddressIsPrivate: null, details: { error: `${err.code}: ${err.message}` } };
    }
    const signal = this.#ac.signal;
    const check = (method, run) => (this.#methods.includes(method)
      ? run().then((value) => { this.#unavailable.delete(method); return { ok: true, ...value }; },
        (err) => { if (err.unavailable) this.#markUnavailable(method); return { ok: false, error: `${err.code}: ${err.message}` }; })
      : Promise.resolve({ ok: false, skipped: true }));
    const [pcp, natpmp, upnp] = await Promise.all([
      check('pcp', async () => ({ epoch: (await this.#pcp(OP_ANNOUNCE, {}, signal)).epoch })),
      check('natpmp', () => this.#natpmpExternal(signal)),
      check('upnp', async () => {
        const igd = await this.#getIgd(signal, true);
        return { location: igd.location, serviceType: igd.serviceType, controlURL: igd.controlURL, externalAddress: igd.externalAddress };
      }),
    ]);
    this.#assertOpen();
    const externalAddress = natpmp.externalAddress ?? upnp.externalAddress ?? null;
    return {
      gateway: netInfo.gateway, localAddress: netInfo.localAddress,
      available: { pcp: pcp.ok, natpmp: natpmp.ok, upnp: upnp.ok },
      externalAddress, externalAddressIsPrivate: externalAddress ? isPrivateIPv4(externalAddress) : null,
      details: { pcp, natpmp, upnp },
    };
  }

  /** Map an inbound port; idempotent per (protocol, internalPort) while the mapping is live. */
  async map(request = {}) {
    this.#assertOpen();
    const req = normalizeRequest(request);
    const key = `${req.protocol}:${req.internalPort}`;
    const live = this.#active.get(key);
    if (live) return live.mapping;
    if (!this.#pending.has(key)) this.#pending.set(key, this.#mapFresh(req, key).finally(() => this.#pending.delete(key)));
    return this.#pending.get(key);
  }

  /** Best-effort delete. Resolves true when the gateway acknowledged it, false otherwise; never rejects for network reasons. */
  async unmap(mapping) {
    if (mapping === null || typeof mapping !== 'object') throw new TypeError('unmap(): expected a mapping returned by map()');
    const record = this.#find(mapping);
    if (!record) return false;
    this.#active.delete(record.key);
    clearTimeout(record.timer);
    // tracked right away (not after the in-flight renewal) so a concurrent close() waits for this delete too
    return this.#track((record.busy ?? Promise.resolve()).then(() => this.#delete(record)));
  }

  /** Unmaps everything best-effort, aborts in-flight work, clears timers and sockets. Idempotent. */
  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#ac.abort();
    const records = [...this.#active.values()];
    this.#active.clear();
    for (const record of records) clearTimeout(record.timer);
    this.#closing = (async () => {
      const guard = setTimeout(() => this.#teardown.abort(), this.#timeoutMs + 1000);
      try {
        for (const record of records) this.#track((record.busy ?? Promise.resolve()).then(() => this.#delete(record)));
        while (this.#deleting.size) await Promise.allSettled([...this.#deleting]);
      } finally {
        clearTimeout(guard);
        this.#teardown.abort();
      }
      this.#log('closed', { unmapped: records.length });
    })();
    return this.#closing;
  }

  // ---- map / renew / delete ----------------------------------------------------------------------------------

  async #mapFresh(req, key) {
    try { await this.#network(); } catch (err) { this.#assertOpen(); throw err; }
    this.#assertOpen();
    const signal = this.#ac.signal;
    // Read-only discovery for the later methods runs in parallel, so a silently dropping first method does not
    // serialize timeouts; the mapping attempts themselves stay strictly in the configured order.
    const warm = new Map();
    for (const method of this.#methods.slice(1)) if (!this.#isUnavailable(method)) warm.set(method, this.#discover(method, signal));
    const errors = [];
    for (const method of this.#methods) {
      if (this.#closed) break;
      if (this.#isUnavailable(method)) {
        errors.push(fail(`${method} skipped: unavailable on this gateway (cached ${UNAVAILABLE_TTL_MS / 1000} s)`, 'SKIPPED', { method }));
        continue;
      }
      try {
        try { await warm.get(method); } catch (err) { if (err.unavailable || this.#closed) throw err; }
        this.#log('map-attempt', { method, protocol: req.protocol, internalPort: req.internalPort, suggestedExternalPort: req.suggestedExternalPort });
        const state = await this.#attempt(method, req, signal, null);
        const record = this.#newRecord(method, req, key, state);
        if (this.#closed) { this.#track(this.#delete(record)); break; }
        this.#unavailable.delete(method);
        this.#active.set(key, record);
        this.#scheduleRenewal(record);
        this.#log('mapped', brief(record));
        return record.mapping;
      } catch (err) {
        if (this.#closed) break;
        err.method ??= method;
        errors.push(err);
        if (err.unavailable) this.#markUnavailable(method);
        this.#log('map-failed', { method, code: err.code, message: err.message });
      }
    }
    if (this.#closed) throw closedError();
    throw fail(`port mapping failed: ${errors.map((e) => `[${e.method}] ${e.message}`).join('; ')}`, 'MAP_FAILED', { errors, cause: errors.at(-1) });
  }

  #attempt(method, req, signal, record) {
    if (method === 'pcp') return this.#pcpMap(req, signal, record);
    if (method === 'natpmp') return this.#natpmpMap(req, signal, record);
    return this.#upnpMap(req, signal, record);
  }

  #discover(method, signal) {
    const p = method === 'pcp' ? this.#pcp(OP_ANNOUNCE, {}, signal) : method === 'natpmp' ? this.#natpmpExternal(signal) : this.#getIgd(signal);
    p.catch(() => {});
    return p;
  }

  #newRecord(method, req, key, state) {
    const { gateway, localAddress } = this.#net;
    const record = {
      key, method, request: req, nonce: null, lease: null, timer: null, busy: null, lifetimeMs: 0, expiresAtMs: 0,
      mapping: {
        method, protocol: req.protocol, internalAddress: localAddress, internalPort: req.internalPort, externalAddress: null, externalPort: 0,
        lifetimeSeconds: 0, expiresAt: null, externalAddressIsPrivate: null, gateway, description: req.description,
      },
    };
    this.#applyState(record, state);
    return record;
  }

  #applyState(record, state) {
    const granted = state.lifetime; // seconds; 0 = permanent UPnP lease
    record.nonce = state.nonce ?? record.nonce;
    record.lease = state.lease ?? record.lease;
    // permanent leases are still refreshed on the requested cadence so a router reboot is noticed and repaired
    record.lifetimeMs = (granted || Math.min(record.request.lifetimeSeconds, UPNP_MAX_LEASE)) * 1000;
    record.expiresAtMs = Date.now() + record.lifetimeMs;
    const externalAddress = state.externalAddress ?? record.mapping.externalAddress ?? null;
    Object.assign(record.mapping, {
      externalAddress, externalPort: state.externalPort, lifetimeSeconds: granted, expiresAt: granted ? record.expiresAtMs : null,
      externalAddressIsPrivate: externalAddress ? isPrivateIPv4(externalAddress) : null,
    });
  }

  #scheduleRenewal(record, delay = record.lifetimeMs / 2) {
    clearTimeout(record.timer);
    record.timer = null;
    if (this.#closed || this.#active.get(record.key) !== record) return;
    record.timer = setTimeout(() => {
      record.timer = null;
      record.busy = this.#renew(record).catch(() => {}).finally(() => { record.busy = null; });
    }, Math.min(Math.max(delay, 0), MAX_TIMER_MS));
    record.timer.unref?.(); // renewals alone never keep the process alive
  }

  async #renew(record) {
    const live = () => !this.#closed && this.#active.get(record.key) === record;
    if (!live()) return;
    let state;
    try {
      state = await this.#attempt(record.method, record.request, this.#ac.signal, record);
    } catch (err) {
      if (!live()) return;
      const remaining = record.expiresAtMs - Date.now();
      const retryIn = Math.min(remaining / 2, remaining - this.#timeoutMs - 100);
      this.#log('renew-failed', { ...brief(record), code: err.code, message: err.message, transient: !!err.transient, remainingMs: Math.max(0, Math.round(remaining)) });
      if (err.transient && retryIn >= MIN_RETRY_MS) return this.#scheduleRenewal(record, retryIn);
      return this.#lose(record, err);
    }
    if (!live()) return;
    const before = record.mapping.externalPort;
    this.#applyState(record, state);
    this.#scheduleRenewal(record);
    this.#log('renewed', { ...brief(record), ...(before !== record.mapping.externalPort && { previousExternalPort: before }) });
    this.#emitSafe('renewed', record.mapping);
  }

  #lose(record, err) {
    if (this.#active.get(record.key) !== record) return;
    this.#active.delete(record.key);
    clearTimeout(record.timer);
    this.#log('lost', { ...brief(record), code: err.code, message: err.message });
    this.#emitSafe('lost', record.mapping, err);
  }

  async #delete(record) {
    const signal = this.#teardown.signal;
    try {
      const { method, mapping: m } = record;
      if (method === 'pcp') {
        await this.#pcp(OP_MAP, { lifetime: 0, nonce: record.nonce, protocol: m.protocol, internalPort: m.internalPort, externalPort: m.externalPort, externalAddress: m.externalAddress ?? '0.0.0.0' }, signal);
        this.#nonces.delete(record.key);
      } else if (method === 'natpmp') {
        await this.#natpmp(m.protocol === 'udp' ? 1 : 2, encodeNatpmpMap(m.protocol, m.internalPort, 0, 0), m.internalPort, signal);
      } else {
        const igd = await this.#getIgd(signal);
        try {
          await this.#soap(igd, 'DeletePortMapping', [['NewRemoteHost', ''], ['NewExternalPort', m.externalPort], ['NewProtocol', m.protocol.toUpperCase()]], signal);
        } catch (err) {
          if (err.upnpErrorCode !== 714) throw err; // NoSuchEntryInArray: already gone
        }
      }
      this.#log('unmapped', brief(record));
      return true;
    } catch (err) {
      this.#log('unmap-failed', { ...brief(record), code: err.code, message: err.message });
      return false;
    }
  }

  #track(promise) {
    this.#deleting.add(promise);
    promise.finally(() => this.#deleting.delete(promise)).catch(() => {});
    return promise;
  }

  #find(m) {
    const records = [...this.#active.values()];
    return records.find((r) => r.mapping === m)
      ?? records.find(({ mapping: x }) => x.protocol === m.protocol && x.internalPort === m.internalPort
        && (m.method === undefined || m.method === x.method) && (m.externalPort === undefined || m.externalPort === x.externalPort))
      ?? null;
  }

  // ---- PCP ---------------------------------------------------------------------------------------------------

  async #pcp(op, fields, signal) {
    const { gateway, localAddress } = this.#net;
    const res = await udpExchange({
      host: gateway, port: this.#o.pcpPort, localAddress, timeoutMs: this.#timeoutMs, signal, label: 'PCP',
      payload: encodePcp(op, { ...fields, client: localAddress }),
      decode: (msg) => decodePcp(msg, { op, ...fields }, (reason) => this.#log('pcp-ignored', { reason, bytes: msg.length })),
    }).catch((err) => { err.method ??= 'pcp'; throw err; });
    this.#noteEpoch('pcp', res.epoch);
    return res;
  }

  async #pcpMap(req, signal, record) {
    // The nonce proves ownership: refreshes reuse it, and so does a re-map after 'lost' (the gateway may still hold
    // the old mapping and would answer NOT_AUTHORIZED to a new nonce until it expires).
    const key = `${req.protocol}:${req.internalPort}`;
    const nonce = record?.nonce ?? this.#nonces.get(key) ?? randomBytes(12);
    this.#nonces.set(key, nonce);
    const prev = record?.mapping;
    const res = await this.#pcp(OP_MAP, {
      lifetime: req.lifetimeSeconds, nonce, protocol: req.protocol, internalPort: req.internalPort,
      externalPort: prev?.externalPort ?? req.suggestedExternalPort, externalAddress: prev?.externalAddress ?? '0.0.0.0',
    }, signal);
    if (!res.lifetime) throw fail('PCP: gateway granted a zero lifetime', 'ZERO_LIFETIME', { method: 'pcp', transient: true });
    if (!validPort(res.externalPort)) throw fail(`PCP: invalid assigned external port ${res.externalPort}`, 'BAD_RESPONSE', { method: 'pcp' });
    return { nonce, lifetime: res.lifetime, externalPort: res.externalPort, externalAddress: externalOrNull(res.externalAddress) };
  }

  // ---- NAT-PMP -----------------------------------------------------------------------------------------------

  async #natpmp(op, payload, internalPort, signal) {
    const { gateway, localAddress } = this.#net;
    const res = await udpExchange({
      host: gateway, port: this.#o.natpmpPort, localAddress, timeoutMs: this.#timeoutMs, signal, label: 'NAT-PMP', payload,
      decode: (msg) => decodeNatpmp(msg, op, internalPort, (reason) => this.#log('natpmp-ignored', { reason, bytes: msg.length })),
    }).catch((err) => { err.method ??= 'natpmp'; throw err; });
    this.#noteEpoch('natpmp', res.epoch);
    return res;
  }

  async #natpmpExternal(signal) {
    const { externalAddress, epoch } = await this.#natpmp(0, Buffer.from([0, 0]), 0, signal);
    return { externalAddress: externalOrNull(externalAddress), epoch };
  }

  async #natpmpMap(req, signal, record) {
    const op = req.protocol === 'udp' ? 1 : 2;
    const suggested = record?.mapping.externalPort ?? req.suggestedExternalPort;
    const [res, ext] = await Promise.all([
      this.#natpmp(op, encodeNatpmpMap(req.protocol, req.internalPort, suggested, req.lifetimeSeconds), req.internalPort, signal),
      this.#natpmpExternal(signal).catch(() => null),
    ]);
    if (!res.lifetime) throw fail('NAT-PMP: gateway granted a zero lifetime', 'ZERO_LIFETIME', { method: 'natpmp', transient: true });
    if (!validPort(res.externalPort)) throw fail(`NAT-PMP: invalid mapped external port ${res.externalPort}`, 'BAD_RESPONSE', { method: 'natpmp' });
    return { lifetime: res.lifetime, externalPort: res.externalPort, externalAddress: ext?.externalAddress ?? null };
  }

  // Epoch sanity (RFC 6887 §8.5, RFC 6886 §3.6): a gateway whose epoch went backwards or drifted too far lost its
  // mapping state (reboot), so every mapping relying on it is refreshed right away.
  #noteEpoch(method, epoch) {
    if (!Number.isFinite(epoch)) return;
    const now = Date.now() / 1000;
    const prev = this.#epochs.get(method);
    this.#epochs.set(method, { server: epoch, client: now });
    if (!prev) return;
    const clientDelta = now - prev.client, serverDelta = epoch - prev.server;
    if (epoch + 1 >= prev.server && serverDelta + 2 >= clientDelta - clientDelta / 16 && clientDelta + 2 >= serverDelta - serverDelta / 16) return;
    this.#log('epoch-reset', { method, previous: prev.server, current: epoch });
    if (now - (this.#resetAt.get(method) ?? -Infinity) < 5) return;
    this.#resetAt.set(method, now);
    for (const record of this.#active.values()) if (record.method === method && !record.busy) this.#scheduleRenewal(record, 0);
  }

  // ---- UPnP IGD ----------------------------------------------------------------------------------------------

  #getIgd(signal, fresh = false) {
    if (!fresh && this.#igdCache) return this.#igdCache.promise;
    const entry = { promise: null, value: null };
    entry.promise = this.#discoverIgd(signal).then(
      (igd) => (entry.value = igd),
      (err) => { if (this.#igdCache === entry) this.#igdCache = null; throw err; });
    entry.promise.catch(() => {});
    this.#igdCache = entry;
    return entry.promise;
  }

  #forgetIgd(igd) {
    if (this.#igdCache?.value === igd) this.#igdCache = null;
  }

  async #discoverIgd(signal) {
    const candidates = await this.#ssdpSearch(signal);
    if (!candidates.length) throw fail('UPnP: no Internet Gateway Device answered the SSDP search', 'NO_IGD', { method: 'upnp', transient: true, unavailable: true });
    const errors = [];
    let fallback = null;
    for (const { location } of candidates.slice(0, 4)) {
      try {
        const res = await httpExchange(new URL(location), { timeoutMs: this.#timeoutMs, signal, localAddress: this.#net.localAddress, headers: { Accept: 'text/xml, application/xml' } });
        if (res.status !== 200) throw fail(`UPnP: ${location} answered HTTP ${res.status}`, 'HTTP_STATUS', { method: 'upnp' });
        for (const service of parseIgdDescription(res.body, location)) {
          if (!this.#lanUrl(service.controlURL)) {
            this.#log('upnp-control-rejected', { location, controlURL: service.controlURL, reason: 'not on the local subnet' });
            continue;
          }
          const igd = { ...service, location, externalAddress: null, noAddAny: false };
          try {
            igd.externalAddress = externalOrNull(xmlText(await this.#soap(igd, 'GetExternalIPAddress', [], signal), 'NewExternalIPAddress'));
          } catch (err) {
            if (err.code === 'ABORTED') throw err;
            errors.push(err);
          }
          if (igd.externalAddress) {
            this.#log('upnp-igd', { location, serviceType: igd.serviceType, controlURL: igd.controlURL, externalAddress: igd.externalAddress });
            return igd;
          }
          fallback ??= igd; // e.g. WAN reported down or GetExternalIPAddress unsupported; mapping may still work
        }
      } catch (err) {
        if (err.code === 'ABORTED') throw err;
        errors.push(err);
        this.#log('upnp-description-failed', { location, code: err.code, message: err.message });
      }
    }
    if (fallback) {
      this.#log('upnp-igd', { location: fallback.location, serviceType: fallback.serviceType, controlURL: fallback.controlURL, externalAddress: null });
      return fallback;
    }
    throw fail('UPnP: no usable WANIPConnection/WANPPPConnection service found', 'NO_IGD', { method: 'upnp', transient: true, unavailable: true, errors });
  }

  #ssdpSearch(signal) {
    const { localAddress } = this.#net;
    const { ssdpAddress: host, ssdpPort: port } = this.#o;
    const mx = Math.max(1, Math.min(5, Math.floor(this.#timeoutMs / 2000)));
    const search = (st) => Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${host}:${port}\r\nMAN: "ssdp:discover"\r\nMX: ${mx}\r\nST: ${st}\r\n\r\n`, 'latin1');
    return new Promise((resolve, reject) => {
      const found = new Map(), timers = [];
      let sock = null, done = false, bound = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        timers.forEach(clearTimeout);
        signal?.removeEventListener('abort', onAbort);
        try { sock?.close(); } catch {}
        if (err) reject(err); else resolve([...found.values()].sort((a, b) => b.score - a.score));
      };
      const onAbort = () => finish(aborted());
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const blast = (targets) => {
        for (const st of targets) {
          if (done) return;
          try { sock.send(search(st), port, host, (err) => err && this.#log('ssdp-send-failed', { st, code: err.code })); } catch {}
        }
      };
      timers.push(setTimeout(() => finish(), this.#timeoutMs));
      try {
        sock = dgram.createSocket('udp4');
        sock.on('error', (err) => {
          this.#log('ssdp-error', { code: err.code, message: err.message });
          if (!bound) finish(fail(`UPnP: SSDP socket error ${err.code ?? err.message}`, 'SOCKET_ERROR', { method: 'upnp', transient: true, unavailable: true, cause: err }));
        });
        sock.on('message', (msg, rinfo) => {
          if (done) return;
          let candidate = null;
          try { candidate = this.#ssdpCandidate(msg, rinfo); } catch {}
          if (!candidate || found.has(candidate.location)) return;
          found.set(candidate.location, candidate);
          if (found.size === 1) timers.push(setTimeout(() => finish(), 200)); // short grace: let IGD:2 / gateway answers land
          if (found.size >= 8) finish();
        });
        sock.bind({ address: localAddress, port: 0 }, () => {
          if (done) return;
          bound = true;
          if (inCidr(host, '224.0.0.0', 4)) {
            try { sock.setMulticastInterface(localAddress); sock.setMulticastTTL(2); } catch (err) { this.#log('ssdp-error', { code: err.code, message: err.message }); }
          }
          blast(IGD_TARGETS);
          // UDP is lossy: repeat, adding a filtered ssdp:all for gateways that only answer generic searches
          timers.push(setTimeout(() => { if (!found.size) blast([...IGD_TARGETS, 'ssdp:all']); }, Math.floor(this.#timeoutMs / 3)));
        });
      } catch (err) {
        finish(fail(`UPnP: SSDP socket error ${err.code ?? err.message}`, 'SOCKET_ERROR', { method: 'upnp', transient: true, unavailable: true, cause: err }));
      }
    });
  }

  #ssdpCandidate(msg, rinfo) {
    if (msg.length > SSDP_LIMIT) return null;
    const lines = msg.toString('latin1').split(/\r?\n/, 32);
    if (!/^HTTP\/1\.[01]\s+200\b/i.test(lines[0] ?? '')) return null;
    const headers = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const { gateway } = this.#net;
    const st = headers.st ?? '', usn = headers.usn ?? '';
    if (!IGD_HINT.test(st) && !IGD_HINT.test(usn) && !(rinfo.address === gateway && /^upnp:rootdevice$/i.test(st))) return null; // ssdp:all noise
    if (!this.#isLanHost(rinfo.address)) {
      this.#log('ssdp-ignored', { from: rinfo.address, reason: 'sender not on the local subnet' });
      return null;
    }
    const url = headers.location ? this.#lanUrl(headers.location) : null;
    if (!url) {
      this.#log('upnp-location-rejected', { from: rinfo.address, location: headers.location ?? null, reason: 'LOCATION must be http:// on the gateway or the local subnet' });
      return null;
    }
    const score = (url.hostname === gateway ? 4 : 0) + (url.hostname === rinfo.address ? 2 : 0) + (/InternetGatewayDevice:2/i.test(st) ? 1 : 0);
    return { location: url.href, st, from: rinfo.address, score };
  }

  // SSRF guard: only plain-http URLs whose host is an IPv4 literal on the gateway or the local subnet.
  #lanUrl(href) {
    let url;
    try { url = new URL(href); } catch { return null; }
    return url.protocol === 'http:' && !url.username && !url.password && this.#isLanHost(url.hostname) ? url : null;
  }

  #isLanHost(ip) {
    if (!isV4(ip) || !this.#net) return false;
    const { gateway, localAddress, prefix } = this.#net;
    if (ip === gateway) return true;
    if (ip === '0.0.0.0' || inCidr(ip, '224.0.0.0', 3)) return false;
    return prefix >= 8 && inCidr(ip, localAddress, prefix);
  }

  async #soap(igd, action, args, signal) {
    const url = this.#lanUrl(igd.controlURL);
    if (!url) throw fail(`UPnP: refusing control URL ${igd.controlURL} outside the local subnet`, 'UNSAFE_URL', { method: 'upnp' });
    const body = '<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
      + `<u:${action} xmlns:u="${escapeXml(igd.serviceType)}">${args.map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`).join('')}</u:${action}>`
      + '</s:Body></s:Envelope>\r\n';
    let res;
    try {
      res = await httpExchange(url, {
        method: 'POST', body, signal, timeoutMs: this.#timeoutMs, localAddress: this.#net.localAddress,
        headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${igd.serviceType}#${action}"` },
      });
    } catch (err) {
      if (err.code !== 'ABORTED') this.#forgetIgd(igd); // rebooted router or new HTTP port: rediscover next time
      err.method ??= 'upnp';
      throw err;
    }
    const fault = parseSoapFault(res.body);
    if (!fault && res.status === 200) return res.body;
    const code = fault?.errorCode ?? null;
    const description = fault?.errorDescription ?? UPNP_ERRORS[code] ?? null;
    this.#log('upnp-soap-fault', { action, httpStatus: res.status, upnpErrorCode: code, upnpErrorDescription: description });
    throw fail(`UPnP ${action} failed: ${code ? `${code} ${description ?? ''}`.trim() : `HTTP ${res.status}`}`, code ? 'UPNP_ERROR' : 'HTTP_STATUS', {
      method: 'upnp', action, httpStatus: res.status, upnpErrorCode: code, upnpErrorDescription: description,
      transient: code === 501 || (!code && res.status >= 500),
    });
  }

  async #upnpOwns(igd, protocol, externalPort, internalPort, signal) {
    try {
      const body = await this.#soap(igd, 'GetSpecificPortMappingEntry', [['NewRemoteHost', ''], ['NewExternalPort', externalPort], ['NewProtocol', protocol]], signal);
      return xmlText(body, 'NewInternalClient') === this.#net.localAddress && Number(xmlText(body, 'NewInternalPort')) === internalPort;
    } catch {
      return false;
    }
  }

  async #upnpMap(req, signal, record) {
    const igd = await this.#getIgd(signal);
    const protocol = req.protocol.toUpperCase();
    const { internalPort } = req;
    let lease = record ? record.lease : Math.min(req.lifetimeSeconds, UPNP_MAX_LEASE);
    let port = record?.mapping.externalPort ?? (req.suggestedExternalPort || internalPort);
    const add = (action, externalPort, leaseSeconds) => this.#soap(igd, action, [
      ['NewRemoteHost', ''], ['NewExternalPort', externalPort], ['NewProtocol', protocol], ['NewInternalPort', internalPort],
      ['NewInternalClient', this.#net.localAddress], ['NewEnabled', 1], ['NewPortMappingDescription', req.description], ['NewLeaseDuration', leaseSeconds],
    ], signal);
    let mapped = null;
    if (!record && igd.version >= 2 && !igd.noAddAny) {
      try {
        const reserved = Number(xmlText(await add('AddAnyPortMapping', port, lease), 'NewReservedPort'));
        if (validPort(reserved)) mapped = reserved;
        else igd.noAddAny = true;
      } catch (err) {
        if (!err.upnpErrorCode || [606, 728, 729].includes(err.upnpErrorCode)) throw err;
        igd.noAddAny = true; // non-conforming IGDv2: fall back to AddPortMapping
        this.#log('upnp-addany-unsupported', { upnpErrorCode: err.upnpErrorCode });
      }
    }
    const tried = new Set();
    for (let conflicts = 0, leaseRetried = false, sameTried = false, reclaimed = false; mapped === null;) {
      tried.add(port);
      try {
        await add('AddPortMapping', port, lease);
        mapped = port;
      } catch (err) {
        const code = err.upnpErrorCode;
        if (code === 725 && lease !== 0 && !leaseRetried) { // OnlyPermanentLeasesSupported
          leaseRetried = true;
          lease = 0;
          this.#log('upnp-permanent-lease', { protocol, externalPort: port });
          continue;
        }
        if (code === 724 && port !== internalPort && !sameTried) { sameTried = true; port = internalPort; continue; } // SamePortValuesRequired
        if (code === 718) { // ConflictInMappingEntry
          if (!reclaimed && await this.#upnpOwns(igd, protocol, port, internalPort, signal)) {
            // ours already (stale entry, or firmware that refuses refreshes): replace it
            reclaimed = true;
            await this.#soap(igd, 'DeletePortMapping', [['NewRemoteHost', ''], ['NewExternalPort', port], ['NewProtocol', protocol]], signal).catch(() => {});
            continue;
          }
          if (!record && ++conflicts < CONFLICT_ATTEMPTS) {
            do port = randomInt(1024, 65536); while (tried.has(port));
            this.#log('upnp-conflict', { protocol, retryExternalPort: port, attempt: conflicts });
            continue;
          }
        }
        throw err;
      }
    }
    const externalAddress = await this.#soap(igd, 'GetExternalIPAddress', [], signal)
      .then((body) => externalOrNull(xmlText(body, 'NewExternalIPAddress')), () => null);
    if (externalAddress) igd.externalAddress = externalAddress;
    return { lease, lifetime: lease, externalPort: mapped, externalAddress: externalAddress ?? igd.externalAddress ?? null };
  }

  // ---- plumbing ----------------------------------------------------------------------------------------------

  #network() {
    if (this.#net) return Promise.resolve(this.#net);
    this.#netPromise ??= this.#detectNetwork().then((info) => (this.#net = info), (err) => { this.#netPromise = null; throw err; });
    return this.#netPromise;
  }

  async #detectNetwork() {
    let { gateway, localAddress } = this.#o, hint = null;
    if (!gateway) {
      const found = await detectGateway({ timeoutMs: this.#timeoutMs, signal: this.#ac.signal });
      if (!found) throw fail('could not detect the default IPv4 gateway', 'NO_GATEWAY', { transient: true, unavailable: true });
      ({ gateway, interface: hint } = found);
    }
    localAddress ??= localAddressFor(gateway, hint) ?? (await routedLocalAddress(gateway));
    if (!localAddress) throw fail(`no local IPv4 address on the subnet of gateway ${gateway}`, 'NO_LOCAL_ADDRESS', { transient: true, unavailable: true });
    const info = { gateway, localAddress, prefix: prefixFor(localAddress) };
    this.#log('network', info);
    return info;
  }

  #isUnavailable(method) { return (this.#unavailable.get(method) ?? 0) > Date.now(); }
  #markUnavailable(method) { this.#unavailable.set(method, Date.now() + UNAVAILABLE_TTL_MS); }
  #assertOpen() { if (this.#closed) throw closedError(); }

  #log(event, details = {}) {
    const log = this.#o.log;
    if (log) try { log(event, details); } catch {}
  }

  #emitSafe(event, ...args) {
    try { this.emit(event, ...args); } catch (err) { this.#log('listener-error', { event, message: err?.message }); }
  }
}

/** Create a port mapper (an EventEmitter emitting 'renewed'(mapping) and 'lost'(mapping, error)). */
export async function createPortMapper(options = {}) {
  return new PortMapper(options);
}
