// SPDX-License-Identifier: Apache-2.0
// Port mapper tests against in-process fake gateways on 127.0.0.1 (no real router is touched).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createPortMapper, parseDefaultGateway, parseIgdDescription, parseSoapFault, isPrivateIPv4, PortMapperError } from '../src/relay/port-mapper.mjs';
import { startFakePcpNatpmp, startFakeUpnp, closedUdpPort } from './fakes/fake-gateways.mjs';

const LOOP = { gateway: '127.0.0.1', localAddress: '127.0.0.1' };

const waitFor = async (predicate, label, timeoutMs = 4000) => {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await delay(20);
  }
};

// One mapper wired to fresh fakes; everything is torn down after the test.
async function setup(t, { gw, upnp, mapper = {} } = {}) {
  const dead = await closedUdpPort();
  const gateway = gw === undefined ? null : await startFakePcpNatpmp(gw);
  const igd = upnp === undefined ? null : await startFakeUpnp(upnp);
  const logs = [];
  const instance = await createPortMapper({
    ...LOOP, timeoutMs: 600,
    pcpPort: gateway?.port ?? dead, natpmpPort: gateway?.port ?? dead, ssdpAddress: '127.0.0.1', ssdpPort: igd?.ssdpPort ?? dead,
    log: (event, details) => logs.push({ event, ...details }),
    ...mapper,
  });
  t.after(async () => {
    await instance.close();
    await gateway?.close();
    await igd?.close();
  });
  const events = (name) => logs.filter((l) => l.event === name);
  return { gw: gateway, upnp: igd, mapper: instance, logs, events, attempts: () => events('map-attempt').map((l) => l.method) };
}

const mapFailure = async (promise) => {
  const err = await promise.then(() => assert.fail('map() should have failed'), (e) => e);
  assert.ok(err instanceof PortMapperError, `expected PortMapperError, got ${err}`);
  assert.equal(err.code, 'MAP_FAILED');
  return err;
};

describe('PCP (RFC 6887)', () => {
  it('maps with a v2 MAP request and parses the granted mapping', async (t) => {
    const { gw, mapper } = await setup(t, { gw: {}, mapper: { methods: ['pcp'] } });
    const before = Date.now();
    const m = await mapper.map({ protocol: 'udp', internalPort: 40000, suggestedExternalPort: 40001, lifetimeSeconds: 600 });
    assert.equal(m.method, 'pcp');
    assert.equal(m.protocol, 'udp');
    assert.equal(m.internalAddress, '127.0.0.1');
    assert.equal(m.internalPort, 40000);
    assert.equal(m.externalPort, 40001);
    assert.equal(m.externalAddress, '203.0.113.7');
    assert.equal(m.externalAddressIsPrivate, false);
    assert.equal(m.lifetimeSeconds, 600);
    assert.ok(m.expiresAt >= before + 600_000 && m.expiresAt <= Date.now() + 600_000);

    const [req] = gw.requests.filter((r) => r.kind === 'pcp-map');
    assert.equal(req.version, 2);
    assert.equal(req.length, 60);
    assert.equal(req.clientAddress, '::ffff:127.0.0.1');
    assert.equal(req.suggestedAddress, '::ffff:0.0.0.0');
    assert.equal(req.protocol, 17);
    assert.equal(req.nonce.length, 12);
    assert.notDeepEqual(req.nonce, Buffer.alloc(12));
    assert.equal(req.lifetime, 600);
    assert.equal(req.suggestedPort, 40001);

    const tcp = await mapper.map({ protocol: 'tcp', internalPort: 40000 });
    assert.equal(gw.requests.filter((r) => r.kind === 'pcp-map').at(-1).protocol, 6);
    assert.notDeepEqual(gw.requests.filter((r) => r.kind === 'pcp-map').at(-1).nonce, req.nonce);
    assert.equal(tcp.externalPort, 40000);

    const count = gw.requests.length;
    assert.equal(await mapper.map({ protocol: 'udp', internalPort: 40000 }), m, 'map() is idempotent while the mapping is live');
    assert.equal(gw.requests.length, count);
    assert.deepEqual(mapper.mappings, [m, tcp]);
  });

  it('ignores a response whose mapping nonce does not match', async (t) => {
    const { mapper, events } = await setup(t, { gw: { nonceMismatchFirst: true }, mapper: { methods: ['pcp'] } });
    const m = await mapper.map({ protocol: 'udp', internalPort: 40010 });
    assert.equal(m.externalPort, 40010);
    assert.ok(events('pcp-ignored').some((e) => e.reason === 'nonce-mismatch'));
  });

  it('turns PCP result codes into typed errors', async (t) => {
    const { gw, mapper } = await setup(t, { gw: { pcpResult: 2 }, mapper: { methods: ['pcp'] } });
    let err = await mapFailure(mapper.map({ protocol: 'udp', internalPort: 40020 }));
    assert.equal(err.errors[0].code, 'NOT_AUTHORIZED');
    assert.equal(err.errors[0].resultCode, 2);
    assert.equal(err.errors[0].method, 'pcp');
    assert.equal(err.errors[0].transient, false);

    gw.set({ pcpResult: 8 });
    err = await mapFailure(mapper.map({ protocol: 'udp', internalPort: 40021 }));
    assert.equal(err.errors[0].code, 'NO_RESOURCES');
    assert.equal(err.errors[0].transient, true);
  });

  it('retransmits with backoff and gives up within timeoutMs when the gateway is silent', async (t) => {
    const { gw, mapper } = await setup(t, { gw: { silent: true }, mapper: { methods: ['pcp'], timeoutMs: 400 } });
    const started = Date.now();
    const err = await mapFailure(mapper.map({ protocol: 'udp', internalPort: 40030 }));
    const elapsed = Date.now() - started;
    assert.equal(err.errors[0].code, 'TIMEOUT');
    assert.ok(elapsed >= 380 && elapsed < 1500, `elapsed ${elapsed} ms`);
    assert.equal(gw.requests.length, 0, 'silent fake records nothing');
  });
});

describe('NAT-PMP (RFC 6886)', () => {
  it('maps UDP (opcode 1) and TCP (opcode 2) and reads the external address (opcode 0)', async (t) => {
    const { gw, mapper } = await setup(t, { gw: { pcp: false, externalAddress: '100.64.12.34' }, mapper: { methods: ['natpmp'] } });
    const udp = await mapper.map({ protocol: 'udp', internalPort: 41000, suggestedExternalPort: 41005, lifetimeSeconds: 900 });
    const tcp = await mapper.map({ protocol: 'tcp', internalPort: 41001 });
    assert.equal(udp.method, 'natpmp');
    assert.equal(udp.externalPort, 41005);
    assert.equal(udp.lifetimeSeconds, 900);
    assert.equal(udp.externalAddress, '100.64.12.34');
    assert.equal(udp.externalAddressIsPrivate, true, 'CGNAT external address is flagged');
    assert.equal(tcp.externalPort, 41001);
    const maps = gw.requests.filter((r) => r.kind === 'natpmp-map');
    assert.deepEqual(maps.map((r) => [r.op, r.internalPort, r.suggestedPort, r.lifetime]), [[1, 41000, 41005, 900], [2, 41001, 41001, 7200]]);
    assert.ok(gw.requests.some((r) => r.kind === 'natpmp-address'));
  });

  it('surfaces NAT-PMP result codes as errors', async (t) => {
    const { gw, mapper } = await setup(t, { gw: { pcp: false, natpmpMapResult: 2 }, mapper: { methods: ['natpmp'] } });
    let err = await mapFailure(mapper.map({ protocol: 'udp', internalPort: 41010 }));
    assert.equal(err.errors[0].code, 'NOT_AUTHORIZED');
    assert.equal(err.errors[0].resultCode, 2);
    assert.equal(err.errors[0].method, 'natpmp');

    gw.set({ natpmpMapResult: 3 });
    err = await mapFailure(mapper.map({ protocol: 'udp', internalPort: 41011 }));
    assert.equal(err.errors[0].code, 'NETWORK_FAILURE');
    assert.equal(err.errors[0].transient, true);
  });
});

describe('UPnP IGD', () => {
  it('discovers via SSDP, reads rootDesc.xml and maps with AddPortMapping', async (t) => {
    const { upnp, mapper } = await setup(t, { upnp: {}, mapper: { methods: ['upnp'] } });
    const m = await mapper.map({ protocol: 'tcp', internalPort: 42000, lifetimeSeconds: 3600, description: 'peer<lane> & "co"' });
    assert.equal(m.method, 'upnp');
    assert.equal(m.externalPort, 42000);
    assert.equal(m.externalAddress, '203.0.113.7');
    assert.equal(m.lifetimeSeconds, 3600);

    assert.ok(upnp.searches.some((s) => s.st === 'urn:schemas-upnp-org:device:InternetGatewayDevice:2'));
    assert.ok(upnp.searches.some((s) => s.st === 'urn:schemas-upnp-org:device:InternetGatewayDevice:1'));
    assert.ok(upnp.searches.every((s) => s.man === '"ssdp:discover"' && Number(s.mx) >= 1));
    assert.deepEqual(upnp.httpRequests[0], { method: 'GET', url: '/rootDesc.xml' });

    const add = upnp.soapCalls.find((c) => c.action === 'AddPortMapping');
    assert.equal(add.soapAction, '"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"');
    assert.match(add.contentType, /^text\/xml/);
    assert.deepEqual(add.args, {
      NewRemoteHost: '', NewExternalPort: '42000', NewProtocol: 'TCP', NewInternalPort: '42000', NewInternalClient: '127.0.0.1',
      NewEnabled: '1', NewPortMappingDescription: 'peer<lane> & "co"', NewLeaseDuration: '3600',
    });
    assert.match(add.body, /peer&lt;lane&gt; &amp; &quot;co&quot;/, 'outgoing values are XML-escaped');
    assert.equal(upnp.mappings.get('TCP:42000').client, '127.0.0.1');
  });

  it('retries another external port on 718 ConflictInMappingEntry', async (t) => {
    const { upnp, mapper, events } = await setup(t, { upnp: { conflicts: { 'UDP:43000': '10.9.9.9' } }, mapper: { methods: ['upnp'] } });
    const m = await mapper.map({ protocol: 'udp', internalPort: 43000 });
    assert.notEqual(m.externalPort, 43000);
    assert.ok(m.externalPort >= 1024 && m.externalPort <= 65535);
    assert.deepEqual(upnp.soapActions().filter((a) => a !== 'GetExternalIPAddress'), ['AddPortMapping', 'GetSpecificPortMappingEntry', 'AddPortMapping']);
    assert.equal(upnp.mappings.get('UDP:43000').client, '10.9.9.9', 'the other host keeps its mapping');
    assert.equal(upnp.mappings.get(`UDP:${m.externalPort}`).client, '127.0.0.1');
    assert.equal(events('upnp-conflict').length, 1);
  });

  it('retries with a permanent lease on 725 OnlyPermanentLeasesSupported', async (t) => {
    const { upnp, mapper } = await setup(t, { upnp: { permanentOnly: true }, mapper: { methods: ['upnp'] } });
    const m = await mapper.map({ protocol: 'udp', internalPort: 43010 });
    assert.equal(m.lifetimeSeconds, 0);
    assert.equal(m.expiresAt, null);
    assert.deepEqual(upnp.soapCalls.filter((c) => c.action === 'AddPortMapping').map((c) => c.args.NewLeaseDuration), ['7200', '0']);
  });

  it('parses SOAP faults (UPnPError errorCode/errorDescription) into errors', async (t) => {
    const { mapper } = await setup(t, { upnp: { faults: { AddPortMapping: { code: 606, description: 'Action not authorized' } } }, mapper: { methods: ['upnp'] } });
    const err = await mapFailure(mapper.map({ protocol: 'udp', internalPort: 43020 }));
    const [cause] = err.errors;
    assert.equal(cause.code, 'UPNP_ERROR');
    assert.equal(cause.upnpErrorCode, 606);
    assert.equal(cause.upnpErrorDescription, 'Action not authorized');
    assert.equal(cause.httpStatus, 500);
    assert.equal(cause.action, 'AddPortMapping');

    const raw = '<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body>'
      + '<SOAP-ENV:Fault><faultcode>SOAP-ENV:Client</faultcode><faultstring>UPnPError</faultstring><detail>'
      + '<u:UPnPError xmlns:u="urn:schemas-upnp-org:control-1-0"><u:errorCode> 718 </u:errorCode>'
      + '<u:errorDescription>Conflict&amp;InMappingEntry</u:errorDescription></u:UPnPError></detail></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>';
    assert.deepEqual(parseSoapFault(raw), { errorCode: 718, errorDescription: 'Conflict&InMappingEntry', faultCode: 'SOAP-ENV:Client', faultString: 'UPnPError' });
    assert.equal(parseSoapFault('<s:Envelope><s:Body><u:AddPortMappingResponse xmlns:u="x"/></s:Body></s:Envelope>'), null);
  });

  it('uses IGDv2 AddAnyPortMapping and its NewReservedPort', async (t) => {
    const { upnp, mapper } = await setup(t, { upnp: { version: 2, conflicts: { 'UDP:44000': '10.9.9.9' } }, mapper: { methods: ['upnp'] } });
    const m = await mapper.map({ protocol: 'udp', internalPort: 44000 });
    assert.equal(m.externalPort, 44001);
    const any = upnp.soapCalls.find((c) => c.action === 'AddAnyPortMapping');
    assert.equal(any.soapAction, '"urn:schemas-upnp-org:service:WANIPConnection:2#AddAnyPortMapping"');
    assert.ok(!upnp.soapActions().includes('AddPortMapping'));
  });

  it('falls back to a filtered ssdp:all search', async (t) => {
    const { upnp, mapper } = await setup(t, { upnp: { onlyAll: true }, mapper: { methods: ['upnp'] } });
    const m = await mapper.map({ protocol: 'udp', internalPort: 44010 });
    assert.equal(m.method, 'upnp');
    assert.ok(upnp.searches.some((s) => s.st === 'ssdp:all'));
    assert.ok(!upnp.httpRequests.some((r) => r.url === '/printer.xml'), 'non-IGD devices from ssdp:all are ignored');
  });

  it('rejects a LOCATION off the local subnet or not an IPv4 literal (SSRF guard)', async (t) => {
    const { upnp, mapper, events } = await setup(t, { upnp: { location: 'http://10.255.255.1:80/rootDesc.xml' }, mapper: { methods: ['upnp'] } });
    let err = await mapFailure(mapper.map({ protocol: 'udp', internalPort: 44020 }));
    assert.equal(err.errors[0].code, 'NO_IGD');
    assert.ok(events('upnp-location-rejected').some((e) => e.location === 'http://10.255.255.1:80/rootDesc.xml'));

    upnp.set({ location: `http://localhost:${upnp.httpPort}/rootDesc.xml` });
    await delay(10);
    const fresh = await createPortMapper({ ...LOOP, timeoutMs: 600, methods: ['upnp'], ssdpAddress: '127.0.0.1', ssdpPort: upnp.ssdpPort });
    t.after(() => fresh.close());
    err = await mapFailure(fresh.map({ protocol: 'udp', internalPort: 44021 }));
    assert.equal(err.errors[0].code, 'NO_IGD');
    assert.equal(upnp.httpRequests.length, 0, 'no HTTP request reached any rejected LOCATION');
  });

  it('rejects a control URL that URLBase points off the local subnet', async (t) => {
    const { upnp, mapper, events } = await setup(t, { upnp: { urlBase: 'http://10.255.255.1:80/' }, mapper: { methods: ['upnp'] } });
    const err = await mapFailure(mapper.map({ protocol: 'udp', internalPort: 44030 }));
    assert.equal(err.errors[0].code, 'NO_IGD');
    assert.ok(events('upnp-control-rejected').some((e) => e.controlURL === 'http://10.255.255.1/ctl/IPConn'));
    assert.deepEqual(upnp.soapCalls, []);
  });

  it('refuses device descriptions larger than 64 KiB', async (t) => {
    const { mapper, events } = await setup(t, { upnp: { descriptionPadding: 70 * 1024 }, mapper: { methods: ['upnp'] } });
    const err = await mapFailure(mapper.map({ protocol: 'udp', internalPort: 44040 }));
    assert.equal(err.errors[0].code, 'NO_IGD');
    assert.ok(events('upnp-description-failed').some((e) => e.code === 'TOO_LARGE'));
  });

  it('parses descriptions: URLBase, relative control URLs, service preference', () => {
    const xml = `<root><URLBase>http://192.168.1.1:5000/</URLBase><device><serviceList>
      <service><serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType><controlURL>ctl/PPPConn</controlURL></service>
      <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service>
      <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/ctl/L3F</controlURL></service>
    </serviceList></device></root>`;
    assert.deepEqual(parseIgdDescription(xml, 'http://192.168.1.1:1900/rootDesc.xml').map((s) => [s.serviceType.split(':').at(-2), s.controlURL]), [
      ['WANIPConnection', 'http://192.168.1.1:5000/ctl/IPConn'],
      ['WANPPPConnection', 'http://192.168.1.1:5000/ctl/PPPConn'],
    ]);
  });
});

describe('method fallback', () => {
  it('PCP unsupported (NAT-PMP-only gateway) falls back to NAT-PMP', async (t) => {
    const { mapper, events, attempts } = await setup(t, { gw: { pcp: false } });
    const m = await mapper.map({ protocol: 'udp', internalPort: 45000 });
    assert.equal(m.method, 'natpmp');
    assert.deepEqual(attempts(), ['pcp', 'natpmp']);
    assert.equal(events('map-failed')[0].code, 'UNSUPP_VERSION');
  });

  it('PCP unsupported -> NAT-PMP refused -> UPnP, in order', async (t) => {
    const { mapper, events, attempts } = await setup(t, { gw: { pcp: false, natpmpMapResult: 2 }, upnp: {} });
    const m = await mapper.map({ protocol: 'udp', internalPort: 45010 });
    assert.equal(m.method, 'upnp');
    assert.deepEqual(attempts(), ['pcp', 'natpmp', 'upnp']);
    assert.deepEqual(events('map-failed').map((e) => [e.method, e.code]), [['pcp', 'UNSUPP_VERSION'], ['natpmp', 'NOT_AUTHORIZED']]);
  });

  it('closed PCP/NAT-PMP ports fail fast and are skipped on the next map()', async (t) => {
    const { mapper, events, attempts } = await setup(t, { upnp: {} });
    const started = Date.now();
    const first = await mapper.map({ protocol: 'udp', internalPort: 45020 });
    assert.equal(first.method, 'upnp');
    assert.ok(Date.now() - started < 1500, 'ICMP port unreachable short-circuits the timeouts');
    assert.deepEqual(events('map-failed').map((e) => [e.method, e.code]), [['pcp', 'UNREACHABLE'], ['natpmp', 'UNREACHABLE']]);
    await mapper.map({ protocol: 'udp', internalPort: 45021 });
    // NAT-PMP never got a mapping request (its parallel read-only probe already failed); the second map() skips both
    assert.deepEqual(attempts(), ['pcp', 'upnp', 'upnp']);
  });
});

describe('renewal', () => {
  it('renews at half the granted lifetime with the same nonce, then emits lost when the gateway stops answering', async (t) => {
    const { gw, mapper } = await setup(t, { gw: { grantLifetime: 2 }, mapper: { methods: ['pcp'], timeoutMs: 300 } });
    const m = await mapper.map({ protocol: 'udp', internalPort: 46000, lifetimeSeconds: 3600 });
    assert.equal(m.lifetimeSeconds, 2);
    const mappedAt = Date.now();
    const [renewed] = await once(mapper, 'renewed', { signal: AbortSignal.timeout(5000) });
    const renewedAfter = Date.now() - mappedAt;
    assert.equal(renewed, m, 'the same mapping object is updated in place');
    assert.ok(renewedAfter >= 900 && renewedAfter < 1600, `renewed after ${renewedAfter} ms`);
    const [first, second] = gw.requests.filter((r) => r.kind === 'pcp-map');
    assert.deepEqual(second.nonce, first.nonce);
    assert.equal(second.suggestedPort, m.externalPort);
    assert.equal(second.suggestedAddress, '::ffff:203.0.113.7');

    gw.set({ silent: true });
    const [lost, err] = await once(mapper, 'lost', { signal: AbortSignal.timeout(6000) });
    assert.equal(lost, m);
    assert.equal(err.code, 'TIMEOUT');
    assert.deepEqual(mapper.mappings, []);
    assert.equal(await mapper.unmap(m), false, 'a lost mapping is no longer tracked');
  });

  it('re-mapping after lost reuses the PCP nonce, so a gateway that still holds the mapping accepts it', async (t) => {
    const { gw, mapper } = await setup(t, { gw: { grantLifetime: 1 }, mapper: { methods: ['pcp'], timeoutMs: 200 } });
    const first = await mapper.map({ protocol: 'tcp', internalPort: 46005 });
    gw.set({ silent: true }); // unreachable for a moment; the fake keeps its mapping state
    await once(mapper, 'lost', { signal: AbortSignal.timeout(5000) });
    gw.set({ silent: false });
    const again = await mapper.map({ protocol: 'tcp', internalPort: 46005 });
    assert.notEqual(again, first);
    assert.equal(again.externalPort, first.externalPort);
    const nonces = gw.requests.filter((r) => r.kind === 'pcp-map').map((r) => r.nonce.toString('hex'));
    assert.equal(new Set(nonces).size, 1, 'one nonce owns the mapping across lost + re-map');
  });

  it('UPnP renewal re-adds the same external port; HTTP gone means lost', async (t) => {
    const { upnp, mapper } = await setup(t, { upnp: {}, mapper: { methods: ['upnp'], timeoutMs: 300 } });
    const m = await mapper.map({ protocol: 'udp', internalPort: 46010, lifetimeSeconds: 1 });
    await once(mapper, 'renewed', { signal: AbortSignal.timeout(5000) });
    const adds = upnp.soapCalls.filter((c) => c.action === 'AddPortMapping');
    assert.equal(adds.length, 2);
    assert.equal(adds[1].args.NewExternalPort, String(m.externalPort));
    await upnp.stopHttp();
    const [lost, err] = await once(mapper, 'lost', { signal: AbortSignal.timeout(5000) });
    assert.equal(lost, m);
    assert.ok(['HTTP_ERROR', 'NO_IGD', 'TIMEOUT'].includes(err.code), err.code);
  });

  it('a NAT-PMP epoch reset (gateway reboot) refreshes the other mappings at once', async (t) => {
    const { gw, mapper, events } = await setup(t, { gw: { pcp: false, epochOffset: 1000 }, mapper: { methods: ['natpmp'] } });
    const renewed = [];
    mapper.on('renewed', (m) => renewed.push(m.internalPort));
    await mapper.map({ protocol: 'udp', internalPort: 47000, lifetimeSeconds: 3600 });
    await mapper.map({ protocol: 'tcp', internalPort: 47001, lifetimeSeconds: 3600 });
    gw.set({ epochOffset: 0 }); // the gateway "rebooted": its epoch restarts near zero
    await mapper.map({ protocol: 'udp', internalPort: 47002, lifetimeSeconds: 3600 });
    await waitFor(() => renewed.length >= 2, 'both earlier mappings to be renewed');
    assert.deepEqual(renewed.sort(), [47000, 47001]);
    assert.equal(events('epoch-reset').length, 1);
  });
});

describe('unmap and close', () => {
  it('unmap() sends the protocol-specific delete', async (t) => {
    const { gw, upnp, mapper } = await setup(t, { gw: {}, upnp: {} });
    const viaNatpmp = await createPortMapper({ ...LOOP, timeoutMs: 600, methods: ['natpmp'], natpmpPort: gw.port });
    const viaUpnp = await createPortMapper({ ...LOOP, timeoutMs: 600, methods: ['upnp'], ssdpAddress: '127.0.0.1', ssdpPort: upnp.ssdpPort });
    t.after(() => Promise.all([viaNatpmp.close(), viaUpnp.close()]));

    const pcp = await mapper.map({ protocol: 'udp', internalPort: 48000 });
    assert.equal(await mapper.unmap(pcp), true);
    const pcpReqs = gw.requests.filter((r) => r.kind === 'pcp-map');
    assert.equal(pcpReqs.at(-1).lifetime, 0);
    assert.deepEqual(pcpReqs.at(-1).nonce, pcpReqs[0].nonce, 'PCP delete reuses the mapping nonce');
    assert.equal(gw.mappings.has('pcp:17:48000'), false);

    const nat = await viaNatpmp.map({ protocol: 'tcp', internalPort: 48001 });
    assert.equal(await viaNatpmp.unmap(nat), true);
    const del = gw.requests.filter((r) => r.kind === 'natpmp-map').at(-1);
    assert.deepEqual([del.op, del.internalPort, del.suggestedPort, del.lifetime], [2, 48001, 0, 0]);
    assert.equal(gw.mappings.has('natpmp:2:48001'), false);

    const up = await viaUpnp.map({ protocol: 'udp', internalPort: 48002 });
    assert.equal(await viaUpnp.unmap({ ...up }), true, 'a copy of the mapping is accepted too');
    assert.deepEqual(upnp.soapCalls.filter((c) => c.action === 'DeletePortMapping').map((c) => c.args), [{ NewRemoteHost: '', NewExternalPort: '48002', NewProtocol: 'UDP' }]);
    assert.equal(upnp.mappings.size, 0);
    assert.equal(await viaUpnp.unmap(up), false, 'second unmap is a no-op');
  });

  it('close() unmaps everything, rejects in-flight work and is idempotent', async (t) => {
    const { gw, upnp, mapper } = await setup(t, { gw: {}, upnp: {} });
    await mapper.map({ protocol: 'udp', internalPort: 49000 });
    await mapper.map({ protocol: 'tcp', internalPort: 49001 });
    assert.equal(gw.mappings.size, 2);
    const closing = mapper.close();
    assert.equal(mapper.close(), closing, 'close() returns the same promise');
    await closing;
    assert.equal(gw.mappings.size, 0);
    assert.equal(mapper.closed, true);
    await assert.rejects(mapper.map({ protocol: 'udp', internalPort: 49002 }), { code: 'CLOSED' });
    await assert.rejects(mapper.probe(), { code: 'CLOSED' });

    const quiet = await startFakePcpNatpmp({ silent: true });
    const stuck = await createPortMapper({ ...LOOP, timeoutMs: 2000, pcpPort: quiet.port, natpmpPort: quiet.port, ssdpAddress: '127.0.0.1', ssdpPort: upnp.ssdpPort });
    t.after(() => quiet.close());
    const pending = stuck.map({ protocol: 'udp', internalPort: 49003 });
    await delay(50);
    const started = Date.now();
    await stuck.close();
    await assert.rejects(pending, { code: 'CLOSED' });
    assert.ok(Date.now() - started < 500, 'close() does not wait for in-flight timeouts');
  });

  it('leaves no open handles: a child process exits by itself after close()', async () => {
    const moduleUrl = new URL('../src/relay/port-mapper.mjs', import.meta.url).href;
    const fakesUrl = new URL('./fakes/fake-gateways.mjs', import.meta.url).href;
    const script = `
      import { createPortMapper } from ${JSON.stringify(moduleUrl)};
      import { startFakePcpNatpmp, startFakeUpnp } from ${JSON.stringify(fakesUrl)};
      const gw = await startFakePcpNatpmp();
      const quiet = await startFakePcpNatpmp({ silent: true });
      const upnp = await startFakeUpnp();
      const base = { gateway: '127.0.0.1', localAddress: '127.0.0.1', timeoutMs: 500, ssdpAddress: '127.0.0.1', ssdpPort: upnp.ssdpPort };
      const mapper = await createPortMapper({ ...base, pcpPort: gw.port, natpmpPort: gw.port });
      const viaUpnp = await createPortMapper({ ...base, methods: ['upnp'] });
      const stuck = await createPortMapper({ ...base, methods: ['pcp'], pcpPort: quiet.port });
      await mapper.map({ protocol: 'udp', internalPort: 50000, lifetimeSeconds: 2 });
      await mapper.map({ protocol: 'tcp', internalPort: 50001 });
      await viaUpnp.map({ protocol: 'udp', internalPort: 50002, lifetimeSeconds: 2 });
      await mapper.probe();
      const pending = stuck.map({ protocol: 'udp', internalPort: 50003 }).then(() => 'mapped', (e) => e.code);
      await Promise.all([mapper.close(), viaUpnp.close(), stuck.close(), mapper.close()]);
      const outcome = await pending;
      const leftover = gw.mappings.size + upnp.mappings.size;
      await Promise.all([gw.close(), quiet.close(), upnp.close()]);
      process.stdout.write(JSON.stringify({ outcome, leftover }) + '\\n');
    `;
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', reportedAt = 0;
    child.stdout.on('data', (chunk) => { stdout += chunk; if (!reportedAt && stdout.includes('\n')) reportedAt = Date.now(); });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const [code, signal] = await once(child, 'exit');
    clearTimeout(killer);
    const exitedAt = Date.now();
    assert.equal(signal, null, `child had to be killed (open handles?) stderr=${stderr}`);
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout.trim()), { outcome: 'CLOSED', leftover: 0 });
    assert.ok(exitedAt - reportedAt < 1500, `child lingered ${exitedAt - reportedAt} ms after closing everything`);
  });
});

describe('probe() and helpers', () => {
  it('probe() reports availability and the external address without mapping anything', async (t) => {
    const { gw, upnp, mapper } = await setup(t, { gw: {}, upnp: {} });
    const result = await mapper.probe();
    assert.equal(result.gateway, '127.0.0.1');
    assert.equal(result.localAddress, '127.0.0.1');
    assert.deepEqual(result.available, { pcp: true, natpmp: true, upnp: true });
    assert.equal(result.externalAddress, '203.0.113.7');
    assert.equal(result.externalAddressIsPrivate, false);
    assert.deepEqual(gw.requests.map((r) => r.kind).sort(), ['natpmp-address', 'pcp-announce']);
    assert.deepEqual(upnp.soapActions(), ['GetExternalIPAddress']);
    assert.equal(gw.mappings.size + upnp.mappings.size, 0);

    gw.set({ pcp: false });
    await upnp.close();
    const again = await mapper.probe();
    assert.deepEqual(again.available, { pcp: false, natpmp: true, upnp: false });
    assert.match(again.details.pcp.error, /UNSUPP_VERSION/);
  });

  it('parses default routes for linux, ip, darwin and win32', () => {
    const procRoute = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'wlan0\t00000000\t0102A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
      'eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
      'eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
    ].join('\n');
    assert.deepEqual(parseDefaultGateway('linux', procRoute), { gateway: '192.168.1.1', interface: 'eth0' });
    assert.deepEqual(parseDefaultGateway('ip', 'default via 10.0.0.1 dev enp3s0 proto dhcp src 10.0.0.23 metric 100\n'), { gateway: '10.0.0.1', interface: 'enp3s0' });
    const darwin = '   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.178.1\n  interface: en0\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>\n';
    assert.deepEqual(parseDefaultGateway('darwin', darwin), { gateway: '192.168.178.1', interface: 'en0' });
    assert.equal(parseDefaultGateway('darwin', '   route to: default\n  interface: utun4\n'), null);
    const win = [
      '===========================================================================',
      'IPv4 Route Table',
      '===========================================================================',
      'Active Routes:',
      'Network Destination        Netmask          Gateway       Interface  Metric',
      '          0.0.0.0          0.0.0.0     192.168.0.254    192.168.0.42     55',
      '          0.0.0.0          0.0.0.0      192.168.0.1     192.168.0.42     25',
      '===========================================================================',
      'Persistent Routes:',
      '  Network Address          Netmask  Gateway Address  Metric',
      '          0.0.0.0          0.0.0.0      10.10.10.10  Default',
    ].join('\r\n');
    assert.deepEqual(parseDefaultGateway('win32', win), { gateway: '192.168.0.1', interface: '192.168.0.42' });
    assert.equal(parseDefaultGateway('linux', ''), null);
  });

  it('classifies private, CGNAT and other non-public external addresses', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '100.127.255.254', '127.0.0.1', '169.254.1.1', '0.0.0.0', '192.0.0.2', '198.18.0.1', '224.0.0.1', '255.255.255.255']) {
      assert.equal(isPrivateIPv4(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.7', '100.128.0.1', '172.32.0.1', '192.169.0.1']) assert.equal(isPrivateIPv4(ip), false, ip);
    assert.equal(isPrivateIPv4('not-an-ip'), false);
  });

  it('validates options and map() arguments', async () => {
    await assert.rejects(createPortMapper({ methods: ['carrier-pigeon'] }), TypeError);
    await assert.rejects(createPortMapper({ gateway: 'router.local' }), TypeError);
    await assert.rejects(createPortMapper({ timeoutMs: 0 }), TypeError);
    const mapper = await createPortMapper({ ...LOOP, methods: ['pcp'] });
    await assert.rejects(mapper.map({ protocol: 'sctp', internalPort: 1 }), TypeError);
    await assert.rejects(mapper.map({ protocol: 'udp', internalPort: 70000 }), TypeError);
    await assert.rejects(mapper.map({ protocol: 'udp', internalPort: 1000, lifetimeSeconds: 0 }), TypeError);
    await assert.rejects(mapper.unmap(null), TypeError);
    await mapper.close();
  });
});
