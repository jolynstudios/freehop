// SPDX-License-Identifier: Apache-2.0
// In-process fake home-router endpoints for the port-mapper tests, all on 127.0.0.1 with ephemeral ports:
//  - startFakePcpNatpmp(): PCP (RFC 6887) and NAT-PMP (RFC 6886) on one UDP port, like a real gateway's 5351
//  - startFakeUpnp(): UPnP IGD v1/v2 = SSDP responder (unicast UDP) + HTTP server (rootDesc.xml + SOAP control)
// Every fake records what it received so tests can assert on the wire traffic. Loading this module has no side effects.

import dgram from 'node:dgram';
import http from 'node:http';

const bindUdp = () => new Promise((resolve, reject) => {
  const sock = dgram.createSocket('udp4');
  sock.once('error', reject);
  sock.bind(0, '127.0.0.1', () => { sock.off('error', reject); resolve(sock); });
});
const closeUdp = (sock) => new Promise((resolve) => { try { sock.close(resolve); } catch { resolve(); } });

/** A UDP port on 127.0.0.1 that nothing listens on (ICMP port unreachable). */
export async function closedUdpPort() {
  const sock = await bindUdp();
  const { port } = sock.address();
  await closeUdp(sock);
  return port;
}

const readMapped = (buf, offset) => {
  const b = buf.subarray(offset, offset + 16);
  return b.subarray(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff ? `::ffff:${[...b.subarray(12)].join('.')}` : b.toString('hex');
};
const writeMapped = (buf, offset, ip) => {
  buf.fill(0, offset, offset + 10);
  buf[offset + 10] = 0xff;
  buf[offset + 11] = 0xff;
  ip.split('.').forEach((octet, i) => { buf[offset + 12 + i] = Number(octet); });
};

/**
 * Fake PCP + NAT-PMP gateway. Options (all changeable later through set()):
 *  pcp/natpmp: protocol enabled (a disabled protocol answers "unsupported version" in the other protocol's format)
 *  externalAddress, grantLifetime (null = grant what was asked), silent (drop everything),
 *  pcpResult (PCP result code for MAP), natpmpResult (all NAT-PMP opcodes), natpmpMapResult (mapping opcodes only),
 *  nonceMismatchFirst (answer each PCP MAP first with a wrong nonce), epochOffset (seconds added to the epoch),
 *  assignPort(request) -> external port
 */
export async function startFakePcpNatpmp(options = {}) {
  const cfg = { pcp: true, natpmp: true, externalAddress: '203.0.113.7', grantLifetime: null, silent: false, pcpResult: 0, natpmpResult: 0,
    natpmpMapResult: 0, nonceMismatchFirst: false, epochOffset: 0, assignPort: null, ...options };
  const sock = await bindUdp();
  const started = Date.now();
  const requests = [];
  const mappings = new Map();
  const timers = new Set();
  const epoch = () => Math.max(0, Math.floor((Date.now() - started) / 1000) + cfg.epochOffset);
  const reply = (buf, rinfo) => { try { sock.send(buf, rinfo.port, rinfo.address); } catch {} };
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };

  const onPcp = (msg, rinfo) => {
    const op = msg[1] & 0x7f;
    if (!cfg.pcp) { // NAT-PMP-only gateway: NAT-PMP "unsupported version" (RFC 6886 §3.5)
      requests.push({ kind: 'pcp-rejected', op });
      const b = Buffer.alloc(8);
      b[1] = 128 + op;
      b.writeUInt16BE(1, 2);
      b.writeUInt32BE(epoch(), 4);
      return reply(b, rinfo);
    }
    const clientAddress = readMapped(msg, 8);
    const res = Buffer.alloc(op === 1 ? 60 : 24);
    res[0] = 2;
    res[1] = 0x80 | op;
    res.writeUInt32BE(epoch(), 8);
    if (op === 0) {
      requests.push({ kind: 'pcp-announce', clientAddress });
      return reply(res, rinfo);
    }
    if (op !== 1 || msg.length < 60) {
      res[3] = 4; // UNSUPP_OPCODE
      return reply(res.subarray(0, 24), rinfo);
    }
    const req = {
      kind: 'pcp-map', version: msg[0], lifetime: msg.readUInt32BE(4), clientAddress, nonce: Buffer.from(msg.subarray(24, 36)), protocol: msg[36],
      internalPort: msg.readUInt16BE(40), suggestedPort: msg.readUInt16BE(42), suggestedAddress: readMapped(msg, 44), length: msg.length,
    };
    requests.push(req);
    msg.copy(res, 24, 24, 60); // opcode-specific data: nonce, protocol, internal port, ...
    const key = `pcp:${req.protocol}:${req.internalPort}`;
    const existing = mappings.get(key);
    if (clientAddress !== `::ffff:${rinfo.address}`) res[3] = 12; // ADDRESS_MISMATCH
    else if (cfg.pcpResult) { res[3] = cfg.pcpResult; res.writeUInt32BE(30, 4); }
    else if (existing && !existing.nonce.equals(req.nonce)) { res[3] = 2; res.writeUInt32BE(30, 4); } // NOT_AUTHORIZED: someone else's mapping
    else if (req.lifetime === 0) mappings.delete(key);
    else {
      const port = existing?.externalPort ?? cfg.assignPort?.(req) ?? (req.suggestedPort || req.internalPort);
      mappings.set(key, { nonce: req.nonce, externalPort: port, internalPort: req.internalPort, protocol: req.protocol });
      res.writeUInt32BE(cfg.grantLifetime ?? req.lifetime, 4);
      res.writeUInt16BE(port, 42);
      writeMapped(res, 44, cfg.externalAddress);
    }
    if (cfg.nonceMismatchFirst) {
      const bogus = Buffer.from(res);
      bogus[24] ^= 0xff;
      reply(bogus, rinfo);
      return later(() => reply(res, rinfo), 20);
    }
    reply(res, rinfo);
  };

  const onNatpmp = (msg, rinfo) => {
    const op = msg[1];
    if (!cfg.natpmp) { // PCP-only server: PCP-format UNSUPP_VERSION (RFC 6887 §9)
      requests.push({ kind: 'natpmp-rejected', op });
      const b = Buffer.alloc(24);
      b[0] = 2;
      b[1] = 0x80 | op;
      b[3] = 1;
      b.writeUInt32BE(epoch(), 8);
      return reply(b, rinfo);
    }
    if (op === 0) {
      requests.push({ kind: 'natpmp-address' });
      const b = Buffer.alloc(12);
      b[1] = 128;
      b.writeUInt16BE(cfg.natpmpResult, 2);
      b.writeUInt32BE(epoch(), 4);
      if (!cfg.natpmpResult) cfg.externalAddress.split('.').forEach((octet, i) => { b[8 + i] = Number(octet); });
      return reply(b, rinfo);
    }
    if ((op !== 1 && op !== 2) || msg.length < 12) {
      const b = Buffer.alloc(8);
      b[1] = 128 + op;
      b.writeUInt16BE(5, 2); // unsupported opcode
      return reply(b, rinfo);
    }
    const req = { kind: 'natpmp-map', op, internalPort: msg.readUInt16BE(4), suggestedPort: msg.readUInt16BE(6), lifetime: msg.readUInt32BE(8) };
    requests.push(req);
    const b = Buffer.alloc(16);
    b[1] = 128 + op;
    b.writeUInt32BE(epoch(), 4);
    b.writeUInt16BE(req.internalPort, 8);
    const result = cfg.natpmpMapResult || cfg.natpmpResult;
    if (result) {
      b.writeUInt16BE(result, 2);
      return reply(b, rinfo);
    }
    const key = `natpmp:${op}:${req.internalPort}`;
    if (req.lifetime === 0) {
      mappings.delete(key);
      return reply(b, rinfo);
    }
    const port = mappings.get(key)?.externalPort ?? cfg.assignPort?.(req) ?? (req.suggestedPort || req.internalPort);
    mappings.set(key, { externalPort: port, internalPort: req.internalPort, op });
    b.writeUInt16BE(port, 10);
    b.writeUInt32BE(cfg.grantLifetime ?? req.lifetime, 12);
    reply(b, rinfo);
  };

  sock.on('message', (msg, rinfo) => {
    if (cfg.silent || msg.length < 2) return;
    if (msg[0] === 2) onPcp(msg, rinfo);
    else if (msg[0] === 0) onNatpmp(msg, rinfo);
  });

  return {
    port: sock.address().port,
    requests,
    mappings,
    set(patch) { Object.assign(cfg, patch); },
    async close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      await closeUdp(sock);
    },
  };
}

const decodeXml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]);
const envelope = (inner) => '<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
  + `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${inner}</s:Body></s:Envelope>\r\n`;
const service = (type, id, name) => `<service><serviceType>${type}</serviceType><serviceId>${id}</serviceId>`
  + `<controlURL>/ctl/${name}</controlURL><eventSubURL>/evt/${name}</eventSubURL><SCPDURL>/${name}.xml</SCPDURL></service>`;

/**
 * Fake UPnP Internet Gateway Device. Options (changeable through set()):
 *  version (1 | 2), externalAddress, location (override the advertised LOCATION), urlBase (emit <URLBase>),
 *  permanentOnly (725 unless NewLeaseDuration is 0), conflicts ({ 'UDP:1234': '10.1.2.3' } owned by other clients),
 *  faults ({ AddPortMapping: { code, description } }), silentSsdp, noise (extra non-IGD device on ssdp:all),
 *  onlyAll (answer ssdp:all searches only), descriptionPadding (bytes of XML comment appended to rootDesc.xml)
 */
export async function startFakeUpnp(options = {}) {
  const cfg = { version: 1, externalAddress: '203.0.113.7', location: null, urlBase: null, permanentOnly: false, conflicts: {}, faults: {},
    silentSsdp: false, noise: true, onlyAll: false, descriptionPadding: 0, ...options };
  const mappings = new Map(); // 'UDP:1234' -> { client, internalPort, lease, description, enabled, remoteHost }
  for (const [key, client] of Object.entries(cfg.conflicts)) mappings.set(key, { client, internalPort: Number(key.split(':')[1]), lease: 0, description: 'another host' });
  const searches = [], httpRequests = [], soapCalls = [];

  const rootDesc = () => {
    const v = cfg.version;
    return `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" configId="1337">
<specVersion><major>1</major><minor>${v === 2 ? 1 : 0}</minor></specVersion>${cfg.urlBase ? `\n<URLBase>${cfg.urlBase}</URLBase>` : ''}
<device>
<deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:${v}</deviceType>
<friendlyName>peerlane fake router</friendlyName>
<manufacturer>peerlane tests</manufacturer>
<manufacturerURL>http://example.invalid/</manufacturerURL>
<modelDescription>Fake Internet Gateway Device</modelDescription>
<modelName>FakeIGD</modelName>
<modelNumber>${v}</modelNumber>
<serialNumber>00000001</serialNumber>
<UDN>uuid:fa4e0000-0000-4000-8000-000000000001</UDN>
<serviceList>
${service('urn:schemas-upnp-org:service:Layer3Forwarding:1', 'urn:upnp-org:serviceId:L3Forwarding1', 'L3F')}
</serviceList>
<deviceList>
<device>
<deviceType>urn:schemas-upnp-org:device:WANDevice:${v}</deviceType>
<friendlyName>WANDevice</friendlyName>
<manufacturer>peerlane tests</manufacturer>
<modelName>FakeIGD WAN</modelName>
<UDN>uuid:fa4e0000-0000-4000-8000-000000000002</UDN>
<serviceList>
${service('urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1', 'urn:upnp-org:serviceId:WANCommonIFC1', 'CmnIfCfg')}
</serviceList>
<deviceList>
<device>
<deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:${v}</deviceType>
<friendlyName>WANConnectionDevice</friendlyName>
<manufacturer>peerlane tests</manufacturer>
<modelName>FakeIGD WAN connection</modelName>
<UDN>uuid:fa4e0000-0000-4000-8000-000000000003</UDN>
<serviceList>
${service(`urn:schemas-upnp-org:service:WANIPConnection:${v}`, 'urn:upnp-org:serviceId:WANIPConn1', 'IPConn')}
</serviceList>
</device>
</deviceList>
</device>
</deviceList>
<presentationURL>http://127.0.0.1/</presentationURL>
</device>
</root>
${cfg.descriptionPadding ? `<!--${'x'.repeat(cfg.descriptionPadding)}-->\n` : ''}`;
  };

  const sendXml = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': Buffer.byteLength(body), Server: 'FakeOS/1.0 UPnP/1.1 peerlane-fake/1.0' });
    res.end(body);
  };
  const ok = (res, action, out = {}) => sendXml(res, 200, envelope(`<u:${action}Response xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:${cfg.version}">`
    + `${Object.entries(out).map(([k, v]) => `<${k}>${v}</${k}>`).join('')}</u:${action}Response>`));
  const fault = (res, code, description) => sendXml(res, 500, envelope('<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>'
    + `<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${description}</errorDescription></UPnPError></detail></s:Fault>`));

  const soap = (req, res, body) => {
    const action = /#(\w+)"?\s*$/.exec(req.headers.soapaction ?? '')?.[1] ?? null;
    const args = Object.fromEntries([...body.matchAll(/<(New\w+)>([^<]*)<\/\1>/g)].map(([, k, v]) => [k, decodeXml(v)]));
    soapCalls.push({ action, args, soapAction: req.headers.soapaction, contentType: req.headers['content-type'], body });
    if (cfg.faults[action]) return fault(res, cfg.faults[action].code, cfg.faults[action].description);
    const key = `${args.NewProtocol}:${args.NewExternalPort}`;
    switch (action) {
      case 'GetExternalIPAddress':
        return ok(res, action, { NewExternalIPAddress: cfg.externalAddress });
      case 'AddPortMapping': {
        const lease = Number(args.NewLeaseDuration);
        if (cfg.permanentOnly && lease !== 0) return fault(res, 725, 'OnlyPermanentLeasesSupported');
        const existing = mappings.get(key);
        if (existing && existing.client !== args.NewInternalClient) return fault(res, 718, 'ConflictInMappingEntry');
        mappings.set(key, { client: args.NewInternalClient, internalPort: Number(args.NewInternalPort), lease, description: args.NewPortMappingDescription,
          enabled: args.NewEnabled, remoteHost: args.NewRemoteHost });
        return ok(res, action);
      }
      case 'AddAnyPortMapping': {
        if (cfg.version < 2) return fault(res, 401, 'Invalid Action');
        let port = Number(args.NewExternalPort);
        while (mappings.has(`${args.NewProtocol}:${port}`)) port++;
        mappings.set(`${args.NewProtocol}:${port}`, { client: args.NewInternalClient, internalPort: Number(args.NewInternalPort), lease: Number(args.NewLeaseDuration),
          description: args.NewPortMappingDescription, enabled: args.NewEnabled, remoteHost: args.NewRemoteHost });
        return ok(res, action, { NewReservedPort: port });
      }
      case 'DeletePortMapping':
        return mappings.delete(key) ? ok(res, action) : fault(res, 714, 'NoSuchEntryInArray');
      case 'GetSpecificPortMappingEntry': {
        const m = mappings.get(key);
        if (!m) return fault(res, 714, 'NoSuchEntryInArray');
        return ok(res, action, { NewInternalPort: m.internalPort, NewInternalClient: m.client, NewEnabled: 1, NewPortMappingDescription: m.description, NewLeaseDuration: m.lease });
      }
      default:
        return fault(res, 401, 'Invalid Action');
    }
  };

  const server = http.createServer((req, res) => {
    httpRequests.push({ method: req.method, url: req.url });
    if (req.method === 'GET' && req.url === '/rootDesc.xml') return sendXml(res, 200, rootDesc());
    if (req.method === 'POST' && req.url === '/ctl/IPConn') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => soap(req, res, body));
      return;
    }
    res.writeHead(404, { 'Content-Length': 0 });
    res.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const httpPort = server.address().port;
  let httpOpen = true;

  const ssdp = await bindUdp();
  const ssdpResponse = (st, location, uuid = 'fa4e0000-0000-4000-8000-000000000001') => Buffer.from('HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\n'
    + `ST: ${st}\r\nUSN: uuid:${uuid}::${st}\r\nEXT:\r\nSERVER: FakeOS/1.0 UPnP/1.1 peerlane-fake/1.0\r\nLOCATION: ${location}\r\n\r\n`);
  ssdp.on('message', (msg, rinfo) => {
    const text = msg.toString('latin1');
    if (!text.startsWith('M-SEARCH * HTTP/1.1')) return;
    const st = /^ST:\s*(.+?)\s*$/im.exec(text)?.[1] ?? '';
    searches.push({ st, man: /^MAN:\s*(.+?)\s*$/im.exec(text)?.[1] ?? null, mx: /^MX:\s*(\d+)/im.exec(text)?.[1] ?? null });
    if (cfg.silentSsdp) return;
    const location = cfg.location ?? `http://127.0.0.1:${httpPort}/rootDesc.xml`;
    const igdTypes = cfg.version === 2
      ? ['urn:schemas-upnp-org:device:InternetGatewayDevice:2', 'urn:schemas-upnp-org:device:InternetGatewayDevice:1']
      : ['urn:schemas-upnp-org:device:InternetGatewayDevice:1'];
    const send = (buf) => { try { ssdp.send(buf, rinfo.port, rinfo.address); } catch {} };
    if (st === 'ssdp:all') {
      if (cfg.noise) send(ssdpResponse('urn:schemas-upnp-org:device:Printer:1', `http://127.0.0.1:${httpPort}/printer.xml`, 'feed0000-0000-4000-8000-000000000009'));
      for (const type of ['upnp:rootdevice', igdTypes[0], `urn:schemas-upnp-org:service:WANIPConnection:${cfg.version}`]) send(ssdpResponse(type, location));
    } else if (igdTypes.includes(st) && !cfg.onlyAll) {
      send(ssdpResponse(st, location));
    }
  });

  return {
    ssdpPort: ssdp.address().port,
    httpPort,
    location: `http://127.0.0.1:${httpPort}/rootDesc.xml`,
    searches, httpRequests, soapCalls, mappings,
    set(patch) { Object.assign(cfg, patch); },
    soapActions: () => soapCalls.map((c) => c.action),
    /** Stop answering HTTP (router web server gone) while SSDP keeps answering. */
    async stopHttp() {
      if (!httpOpen) return;
      httpOpen = false;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
    async close() {
      await Promise.all([closeUdp(ssdp), this.stopHttp()]);
    },
  };
}
