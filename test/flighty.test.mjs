import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
// Emit inside the repo so bare imports (@bufbuild/protobuf, etc.) resolve to node_modules.
mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
const out = mkdtempSync(path.join(repoRoot, 'dist', 'flighty-'));
execFileSync(
  'npx',
  ['--no-install', 'tsc', '--outDir', out, '--declaration', 'false', '--sourceMap', 'false', '--pretty', 'false'],
  { cwd: repoRoot, stdio: 'inherit' },
);

const base = pathToFileURL(out).href;
const { setEnv } = await import(`${base}/env.js`);
const proto = await import(`${base}/proto.js`);
const { FlightyClient, clearCache } = await import(`${base}/client.js`);
const { FlightyService } = await import(`${base}/service.js`);
const { loadSettings } = await import(`${base}/config.js`);
const { ENDPOINTS } = await import(`${base}/endpoints.js`);
const { FlightyError, WritesDisabled } = await import(`${base}/errors.js`);

// Synthetic fixtures only. Unmocked upstream fetches fail.
const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const FLIGHT = '10000000-0000-4000-8000-000000000001';
const SECOND_FLIGHT = '10000000-0000-4000-8000-000000000002';
const AIRPORT_A = '20000000-0000-4000-8000-000000000001';
const AIRPORT_B = '20000000-0000-4000-8000-000000000002';
const AIRLINE = '30000000-0000-4000-8000-000000000001';
const API = 'https://api.flightyapp.com';
const SYNC = `${API}/v1/sync/full`;

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function fakeToken(subject = OWNER, salt = 'test-only') {
  return `${b64url({ alg: 'HS512', typ: 'JWT' })}.${b64url({ sub: subject, iss: 'flighty-api', iat: 0 })}.${salt}`;
}
const TOKEN = fakeToken();
const OTHER_TOKEN = fakeToken(OTHER);

function flightRecord(owner = OWNER, flightId = FLIGHT, overrides = {}) {
  return {
    id: flightId,
    userId: owner,
    isMine: true,
    flight: {
      id: flightId,
      flightNumber: '123',
      airlineId: AIRLINE,
      departure: { airportId: AIRPORT_A, gate: 'A1', schedule: { gateOriginal: '2099-01-02T20:00:00Z' } },
      arrival: { scheduledAirportId: AIRPORT_B, schedule: { gateOriginal: '2099-01-03T01:00:00Z' } },
    },
    created: '2000-01-01T00:00:00Z',
    updated: '2000-01-02T00:00:00Z',
    ...overrides,
  };
}

function syncBody(records = [flightRecord()], { more = false, cursor } = {}) {
  const data = [
    { remoteUser: { id: OWNER, token: 'synthetic-secret-never-return-this', type: 'ANONYMOUS' } },
    { remoteAirport: { id: AIRPORT_A, name: 'Example Origin', iata: 'AAA', timezone: 'America/Los_Angeles' } },
    { remoteAirport: { id: AIRPORT_B, name: 'Example Destination', iata: 'BBB', timezone: 'Europe/London' } },
    { remoteAirline: { id: AIRLINE, name: 'Example Air', iata: 'ZZ' } },
    ...records.map((record) => ({ remoteUserFlight: record })),
  ];
  const pagination = { moreData: more };
  if (cursor) pagination.nextUrl = cursor;
  return proto.encode('SyncResponseProto', { data, pagination });
}

/** Replace global fetch with routes of [method, url-prefix-or-predicate, responder]. Records every call. */
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body == null ? new Uint8Array() : typeof init.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array(init.body);
    const call = { method: init.method ?? 'GET', url, headers: new Headers(init.headers), body };
    calls.push(call);
    for (const [method, match, respond] of routes) {
      const ok = typeof match === 'function' ? match(call) : `${url.origin}${url.pathname}` === match;
      if (method === call.method && ok) return respond(call);
    }
    throw new TypeError('unmocked fetch: synthetic-secret');
  };
  return calls;
}
const protoResponse = (bytes, status = 200) => new Response(bytes, { status, headers: { 'Content-Type': 'application/x-protobuf' } });
const syncRoute = (bytes = syncBody()) => ['POST', SYNC, () => protoResponse(bytes)];

function settings(overrides = {}) {
  return { ...loadSettings(), buildToken: 'synthetic-build-credential', allowWrites: false, ...overrides };
}
const reader = (o) => new FlightyClient(settings(o));
const writer = (o) => new FlightyClient(settings({ allowWrites: true, ...o }));

test.beforeEach(() => {
  setEnv({ MCP_TOKEN: 'x', FLIGHTY_TOKEN: TOKEN });
  clearCache();
  mockFetch([]);
});

// ---- protobuf ----

test('empty sync has no mutations', () => {
  assert.equal(proto.encode('SyncRequestProto', { changes: [] }).length, 0);
});

test('string request matches independent wire fixture', () => {
  assert.equal(Buffer.from(proto.encode('UserLinkRequestProto', { token: 'fake' })).toString('hex'), '0a0466616b65');
});

test('double coordinates match IEEE754 wire', () => {
  const wire = Buffer.alloc(18);
  wire[0] = 0x09; wire.writeDoubleLE(-12.5, 1); wire[9] = 0x11; wire.writeDoubleLE(130.25, 10);
  assert.deepEqual(proto.decode('RemoteLocation', wire), { latitude: -12.5, longitude: 130.25 });
  assert.deepEqual(Buffer.from(proto.encode('RemoteLocation', { latitude: -12.5, longitude: 130.25 })), wire);
});

test('negative int32 decodes signed', () => {
  const wire = Uint8Array.from([0x08, ...Array(9).fill(0xff), 0x01]);
  assert.equal(proto.decode('RemoteFlight.AirportDelay', wire).averageDelayMinutes, -1);
});

test('packed and unpacked repeated enums', () => {
  assert.deepEqual(proto.decode('RemoteFlight.FaaPlannedInitiative', Uint8Array.from([0x0a, 0x02, 0x00, 0x01])).tmiType, ['GROUND_STOP', 'GROUND_DELAY']);
  assert.deepEqual(proto.decode('RemoteFlight.FaaPlannedInitiative', Uint8Array.from([0x08, 0x00, 0x08, 0x01])).tmiType, ['GROUND_STOP', 'GROUND_DELAY']);
});

test('optional zero has presence', () => {
  const name = 'SyncChangeRequestProto.EditPushSettingChangeAction';
  assert.deepEqual(proto.decode(name, proto.encode(name, { active: false })), {});
  const [msg, def] = Object.entries(proto.SCHEMA).find(([, d]) => d.kind === 'message' && d.fields.some((f) => f.type === 'uint32' && f.optional));
  const field = def.fields.find((f) => f.type === 'uint32' && f.optional);
  assert.equal(proto.decode(msg, proto.encode(msg, { [field.json_name]: 0 }))[field.json_name], 0);
});

test('map and timestamp JSON conventions', () => {
  const name = 'CreateUserRequestProto';
  assert.deepEqual(proto.decode(name, proto.encode(name, { clientFeatureFlags: { example: 'on' } })).clientFeatureFlags, { example: 'on' });
  const payload = { timestamp: '2000-01-01T01:00:00+01:00', flightSetMineAction: { flightId: 'example' } };
  assert.equal(proto.decode('SyncChangeRequestProto', proto.encode('SyncChangeRequestProto', payload)).timestamp, '2000-01-01T00:00:00Z');
});

test('bytes round trip as base64', () => {
  const data = Buffer.from('synthetic binary\x00\xff', 'latin1').toString('base64');
  const name = 'SyncChangeRequestProto.ProfileUploadAvatarAction';
  assert.deepEqual(proto.decode(name, proto.encode(name, { imageData: data })), { imageData: data });
});

test('storage oneofs resolved including id variants', () => {
  const value = { airlineId: 'example-airline', departure: { airportId: 'example-airport', predicted: { gate: 'A1', isUnlocked: true } } };
  assert.deepEqual(proto.decode('RemoteFlight', proto.encode('RemoteFlight', value)), value);
  assert.throws(() => proto.encode('RemoteFlight', { airlineId: 'x', airline: { id: 'y' } }), FlightyError);
});

test('unknown fields and conflicting oneofs rejected', () => {
  for (const payload of [{ noSuchField: 1 }, { flightNumberSearch: {}, routeSearchProto: {} }, { departureDate: 42 }]) {
    assert.throws(() => proto.encode('SearchRequestProto', payload), FlightyError);
  }
});

test('unknown response fields are detected and preserved', () => {
  const parsed = proto.parse('SyncResponseProto', Uint8Array.from([0xa0, 0x06, 0x01]));
  assert.ok(proto.unknownFieldsPresent(parsed));
  assert.ok(!proto.unknownFieldsPresent(proto.parse('SyncResponseProto', syncBody())));
});

test('malformed wire fails safely', () => {
  assert.throws(() => proto.decode('SyncResponseProto', Uint8Array.from([0x0a, 0xff])), /Response does not match/);
});

test('parse error does not echo secrets', () => {
  assert.throws(() => proto.encode('SyncRequestProto', { changes: 'SYNTHETIC-PRIVATE-VALUE' }), (e) => !e.message.includes('SYNTHETIC-PRIVATE-VALUE'));
});

test('recursive redaction', () => {
  const data = { nested: [{ token: 'f', pushToken: 'f', secret: 'f', name: 'visible' }], storekit1Receipt: 'f' };
  assert.deepEqual(proto.redact(data), {
    nested: [{ token: '[REDACTED]', pushToken: '[REDACTED]', secret: '[REDACTED]', name: 'visible' }],
    storekit1Receipt: '[REDACTED]',
  });
});

test('every contract builds and all references resolve', () => {
  for (const [name, definition] of Object.entries(proto.SCHEMA)) {
    if (definition.kind === 'message') assert.deepEqual(proto.decode(name, proto.encode(name, {})), {}, name);
  }
  assert.equal(Object.keys(proto.SCHEMA).length, 281);
});

test('schema description and search', () => {
  assert.deepEqual(proto.describe('NoSuchType').matches, []);
  assert.equal(proto.describe('RemoteTicket.CabinClass').kind, 'enum');
  assert.ok(proto.describe('SyncRequest').matches.includes('SyncRequestProto'));
});

// ---- client ----

test('full sync sends no body and app headers', async () => {
  const calls = mockFetch([syncRoute()]);
  const snapshot = await reader().snapshot(TOKEN);
  const [call] = calls;
  assert.equal(call.method, 'POST');
  assert.equal(call.body.length, 0);
  assert.equal(call.headers.get('authorization'), 'Bearer ' + TOKEN);
  assert.equal(call.headers.get('x-flighty-build-token'), 'synthetic-build-credential');
  assert.equal(call.headers.get('user-agent'), 'Flighty 4.11.1 (4818) com.flightyapp.flighty');
  assert.equal(call.headers.get('x-flighty-locale'), 'en_US');
  assert.equal(call.headers.get('accept'), 'application/x-protobuf');
  assert.equal(call.headers.get('device'), null);
  assert.equal(snapshot.accountId, OWNER);
  assert.equal(snapshot.items('remoteUser')[0].token, '[REDACTED]');
});

test('pagination uses only query, never server-supplied host', async () => {
  const calls = mockFetch([
    ['POST', (c) => c.url.searchParams.get('cursor') === 'two', () => protoResponse(syncBody())],
    ['POST', SYNC, () => protoResponse(syncBody(undefined, { more: true, cursor: 'https://untrusted.invalid/unrelated?cursor=two' }))],
  ]);
  const result = await reader().snapshot(TOKEN);
  assert.equal(result.pages, 2);
  assert.ok(calls.every((c) => c.url.host === 'api.flightyapp.com' && c.body.length === 0));
});

for (const cursor of [undefined, `${API}/v1/sync/full`, '?cursor=loop']) {
  test(`bad pagination does not cache partial data (${cursor})`, async () => {
    const calls = mockFetch([syncRoute(syncBody(undefined, { more: true, cursor }))]);
    await assert.rejects(reader().snapshot(TOKEN), /pagination|cursor/);
    const before = calls.length;
    await assert.rejects(reader().snapshot(TOKEN));
    assert.ok(calls.length > before, 'failure was cached');
  });
}

test('page limit is enforced', async () => {
  mockFetch([syncRoute(syncBody(undefined, { more: true, cursor: '?cursor=two' }))]);
  await assert.rejects(reader({ maxPages: 1 }).snapshot(TOKEN), /max-pages/);
});

test('same flight, different owners not overwritten', async () => {
  mockFetch([syncRoute(syncBody([flightRecord(), flightRecord(OTHER)]))]);
  const snapshot = await reader().snapshot(TOKEN);
  assert.equal(snapshot.items('remoteUserFlight').length, 2);
  assert.equal(snapshot.owned('remoteUserFlight').length, 1);
});

test('newer deletion marker wins', async () => {
  const newer = flightRecord(OWNER, FLIGHT, { updated: '2000-01-03T00:00:00Z', deleted: '2000-01-03T00:00:00Z' });
  mockFetch([syncRoute(syncBody([newer, flightRecord()]))]);
  const snapshot = await reader().snapshot(TOKEN);
  assert.equal(snapshot.owned('remoteUserFlight').length, 0);
  assert.equal(snapshot.owned('remoteUserFlight', true).length, 1);
});

test('cache isolated by credential, deep copied, refresh limited', async () => {
  const calls = mockFetch([syncRoute()]);
  const client = reader();
  const first = await client.snapshot(TOKEN);
  await client.snapshot(fakeToken(OWNER, 'different-credential'));
  assert.equal(calls.length, 2);
  first.records = {};
  for (const key of Object.keys(first)) if (key === 'records') delete first[key];
  assert.ok(Object.keys((await client.snapshot(TOKEN)).records).length);
  const refreshed = await client.snapshot(TOKEN, { refresh: true });
  assert.ok(refreshed.refreshLimited);
  assert.equal(calls.length, 2);
});

test('parallel reads coalesce', async () => {
  const calls = mockFetch([syncRoute()]);
  const client = reader();
  await Promise.all(Array.from({ length: 5 }, () => client.snapshot(TOKEN)));
  assert.equal(calls.length, 1);
});

test('bounded cache evicts oldest', async () => {
  const calls = mockFetch([syncRoute()]);
  const client = reader({ maxCacheAccounts: 1 });
  await client.snapshot(TOKEN);
  await client.snapshot(OTHER_TOKEN);
  await client.snapshot(TOKEN);
  assert.equal(calls.length, 3);
});

test('every mutating route disabled before HTTP', async () => {
  const calls = mockFetch([]);
  for (const [operation, endpoint] of Object.entries(ENDPOINTS)) {
    if (endpoint.read_only) continue;
    await assert.rejects(reader().request(operation, TOKEN), WritesDisabled, operation);
  }
  assert.equal(calls.length, 0);
});

test('read-only sync cannot accept a change body', async () => {
  await assert.rejects(reader().request('sync_account', TOKEN, { payload: { changes: [] } }), /must not contain/);
});

for (const status of [301, 302, 307, 400, 401, 403, 404, 429, 500, 503]) {
  test(`HTTP ${status} is never retried or echoed`, async () => {
    const calls = mockFetch([['GET', `${API}/v1/radar/layers`, () => new Response('PRIVATE RESPONSE MUST NOT LEAK', {
      status, headers: { Location: 'https://untrusted.invalid', 'Retry-After': '30' },
    })]]);
    await assert.rejects(reader().request('get_radar_layers', TOKEN), (e) => e instanceof FlightyError && !e.message.includes('PRIVATE') && !e.message.includes(TOKEN));
    assert.equal(calls.length, 1);
  });
}

test('network exception hides details', async () => {
  await assert.rejects(reader().request('get_radar_layers', TOKEN), (e) => e instanceof FlightyError && !e.message.includes('synthetic-secret'));
});

test('response size limit', async () => {
  mockFetch([['GET', `${API}/v1/radar/layers`, () => protoResponse(new TextEncoder().encode('long'))]]);
  await assert.rejects(reader({ maxResponseBytes: 2 }).request('get_radar_layers', TOKEN), /size limit/);
});

test('conditional poll uses default priority and returns 304', async () => {
  const calls = mockFetch([['POST', `${API}/v1/sync/content/flight/${FLIGHT}`, () => new Response(null, { status: 304 })]]);
  const result = await reader().request('poll_flight', TOKEN, { path: { flight_id: FLIGHT }, headers: { 'If-None-Match': '"e"' } });
  assert.equal(result.not_modified, true);
  assert.equal(calls[0].headers.get('x-sync-priority'), '0');
  assert.equal(calls[0].headers.get('if-none-match'), '"e"');
});

test('rejects arbitrary destination and headers', async () => {
  const calls = mockFetch([]);
  await assert.rejects(reader().request('https://untrusted.invalid', TOKEN), FlightyError);
  await assert.rejects(reader().request('get_flight', TOKEN, { path: { flight_id: '../../user' } }), FlightyError);
  await assert.rejects(reader().request('get_radar_layers', TOKEN, { headers: { Authorization: 'wrong' } }), FlightyError);
  assert.equal(calls.length, 0);
});

test('account delete has a separate gate', async () => {
  await assert.rejects(writer().request('delete_account', TOKEN), /separately/);
});

const ACTIONS = proto.SCHEMA.SyncChangeRequestProto.fields.filter((f) => f.oneof === 'change');

test('all 43 change actions encode on correct tag', async () => {
  assert.equal(ACTIONS.length, 43);
  const calls = mockFetch([['POST', SYNC, () => protoResponse(new Uint8Array())]]);
  const varint = (value) => { const out = []; while (value > 127) { out.push((value & 127) | 128); value >>>= 7; } out.push(value); return out; };
  for (const action of ACTIONS) {
    await writer().applyChanges(TOKEN, [{ timestamp: '2000-01-01T00:00:00Z', [action.json_name]: {} }], { confirmDestructive: true });
    const wire = calls.at(-1).body;
    assert.deepEqual(proto.decode('SyncRequestProto', wire).changes[0][action.json_name], {});
    const tail = [...varint(action.number * 8 + 2), 0];
    assert.deepEqual([...wire.slice(-tail.length)], tail, action.json_name);
  }
});

test('invalid or destructive changes refused before HTTP', async () => {
  const calls = mockFetch([]);
  const cases = [
    [[], false], [[{}], false], [[{ notAnAction: {} }], false],
    [[{ flightSetMineAction: {}, flightUnsetMineAction: {} }], false],
    [[{ flightDeleteAction: { flightId: FLIGHT } }], false],
    [[{ flightDeleteAction: { flightId: FLIGHT, ownerUserId: OTHER } }], true],
    [[{ flightSetMineAction: { flightId: FLIGHT, unexpected: true } }], false],
  ];
  for (const [changes, confirm] of cases) {
    await assert.rejects(writer().applyChanges(TOKEN, changes, { confirmDestructive: confirm }), FlightyError, JSON.stringify(changes));
  }
  assert.equal(calls.length, 0);
});

test('successful write invalidates only own cache', async () => {
  const calls = mockFetch([syncRoute(), ['POST', `${API}/v1/flight/${FLIGHT}/subscribe`, () => new Response(null, { status: 200 })]]);
  const client = writer();
  await client.snapshot(TOKEN);
  await client.snapshot(OTHER_TOKEN);
  await client.request('subscribe_flight', TOKEN, { path: { flight_id: FLIGHT }, params: { is_passenger: 'true' } });
  assert.equal(calls.at(-1).url.searchParams.get('is_passenger'), 'true');
  const syncs = () => calls.filter((c) => c.url.pathname === '/v1/sync/full').length;
  await client.snapshot(OTHER_TOKEN);
  assert.equal(syncs(), 2);
  await client.snapshot(TOKEN);
  assert.equal(syncs(), 3);
});

test('empty mutation ack requires readback', async () => {
  const calls = mockFetch([['POST', SYNC, () => new Response(null, { status: 200 })]]);
  const result = await writer().applyChanges(TOKEN, [{ flightSetMineAction: { flightId: FLIGHT } }]);
  assert.equal(result.submitted_changes, 1);
  assert.deepEqual(result.data, { returned_record_counts: {}, more_data: false });
  assert.equal(result.readback_required, true);
  assert.equal(calls.length, 1);
});

test('JSON mutation uses JSON, not protobuf', async () => {
  const calls = mockFetch([['POST', `${API}/v1/user/settings/viewedYearInReview`, () => Response.json({ ok: true })]]);
  const result = await writer().request('mark_year_in_review_viewed', TOKEN, { payload: { year: '2000' } });
  assert.deepEqual(JSON.parse(new TextDecoder().decode(calls[0].body)), { year: '2000' });
  assert.equal(calls[0].headers.get('content-type'), 'application/json');
  assert.deepEqual(result.data, { ok: true });
});

test('avatar binary response', async () => {
  mockFetch([['GET', `${API}/v1/user/${OWNER}/avatar`, () => new Response('fake-image', { headers: { 'Content-Type': 'image/png' } })]]);
  assert.equal((await reader().request('get_avatar', TOKEN, { path: { user_id: OWNER } })).base64, 'ZmFrZS1pbWFnZQ==');
});

test('search rate limit is not an empty success', async () => {
  mockFetch([['POST', `${API}/v1/search`, () => protoResponse(proto.encode('SearchResponseProto', { error: 'TOO_MANY_REQUESTS' }))]]);
  await assert.rejects(reader().request('search_flights', TOKEN, {
    payload: { departureDate: '2099-01-02', flightNumberSearch: { airlineId: FLIGHT, flightNumber: '123' } },
  }), /search rate limit/);
});

test('fresh-for-write requires write permission and bypasses cache', async () => {
  await assert.rejects(reader().snapshot(TOKEN, { freshForWrite: true }), WritesDisabled);
  const calls = mockFetch([syncRoute()]);
  const client = writer();
  await client.snapshot(TOKEN);
  await client.snapshot(TOKEN, { refresh: true, freshForWrite: true });
  assert.equal(calls.length, 2);
});

// ---- service ----

test('listing keeps friends and archived flights and drops deletions', async () => {
  mockFetch([syncRoute(syncBody([
    flightRecord(OTHER, SECOND_FLIGHT, { importSource: 'CONNECTED_FRIEND' }),
    flightRecord(OWNER, FLIGHT, { archived: true }),
    flightRecord(OWNER, '10000000-0000-4000-8000-000000000003', { deleted: '2000-01-01T00:00:00Z' }),
  ]))]);
  const service = new FlightyService(reader());
  const result = await service.listFlights(TOKEN);
  assert.equal(result.total, 2);
  const own = result.flights.find((flight) => flight.owner_user_id === OWNER);
  const friend = result.flights.find((flight) => flight.owner_user_id === OTHER);
  assert.equal(own.archived, true);
  assert.equal(own.relationship, 'mine');
  assert.equal(own.friend_id, null);
  assert.equal(own.shared, false);
  assert.equal(own.flight_number, 'ZZ 123');
  assert.equal(own.origin.iata, 'AAA');
  assert.equal(own.destination.iata, 'BBB');
  assert.equal(own.departure_local, '2099-01-02T12:00:00-08:00');
  assert.equal(own.arrival_local, '2099-01-03T01:00:00+00:00');
  assert.equal(friend.friend_id, OTHER);
  assert.equal(friend.relationship, 'friend');
  assert.equal(friend.shared, true);
  assert.equal((await service.listFlights(TOKEN, { mine_only: true })).total, 1);
});

test('local date and airport filters', async () => {
  mockFetch([syncRoute()]);
  const service = new FlightyService(reader());
  const filtered = await service.listFlights(TOKEN, {
    when: 'upcoming', mine_only: true, origin: 'aaa', destination: 'Example Destination', start_date: '2099-01-02', end_date: '2099-01-02',
  });
  assert.equal(filtered.total, 1);
  assert.equal((await service.listFlights(TOKEN, { when: 'past' })).total, 0);
  assert.equal((await service.listFlights(TOKEN, { archived: true })).total, 0);
  assert.equal((await service.listFlights(TOKEN, { origin: 'no-match' })).total, 0);
  assert.equal((await service.listFlights(TOKEN, { end_date: '2000-01-01' })).total, 0);
});

test('local pagination and full details', async () => {
  const calls = mockFetch([syncRoute(syncBody([flightRecord(), flightRecord(OWNER, SECOND_FLIGHT)]))]);
  const service = new FlightyService(reader());
  const first = await service.listFlights(TOKEN, { limit: 1, details: true });
  const second = await service.listFlights(TOKEN, { limit: 1, offset: 1 });
  assert.equal(first.total, 2);
  assert.equal(first.next_offset, 1);
  assert.ok('record' in first.flights[0]);
  assert.equal(second.next_offset, null);
  assert.notEqual(first.flights[0].id, second.flights[0].id);
  assert.equal(calls.length, 1);
});

test('invalid filters never make a request', async () => {
  const calls = mockFetch([]);
  for (const opts of [{ limit: 0 }, { limit: 201 }, { offset: -1 }, { when: 'bogus' }, { start_date: 'yesterday' }, { start_date: '2099-01-02', end_date: '2099-01-01' }]) {
    await assert.rejects(new FlightyService(reader()).listFlights(TOKEN, opts), FlightyError, JSON.stringify(opts));
  }
  assert.equal(calls.length, 0);
});

test('catalog search and account records', async () => {
  mockFetch([syncRoute()]);
  const service = new FlightyService(reader());
  assert.equal((await service.searchCatalog(TOKEN, 'remoteAirport', 'aAa')).results[0].iata, 'AAA');
  assert.equal((await service.searchCatalog(TOKEN, 'remoteAirline', 'Example Air')).total, 1);
  assert.equal((await service.searchCatalog(TOKEN, 'remoteAirport', '')).total, 2);
  assert.equal((await service.accountRecords(TOKEN, 'remoteUser')).records[0].token, '[REDACTED]');
  await assert.rejects(service.accountRecords(TOKEN, 'not-a-record'), FlightyError);
});

test('friends and tracked flights are named and get_flight reads the cache', async () => {
  const friendId = SECOND_FLIGHT;
  const trackedId = '10000000-0000-4000-8000-000000000003';
  const unknownId = '10000000-0000-4000-8000-000000000099';
  const body = proto.encode('SyncResponseProto', {
    data: [
      { remoteAirport: { id: AIRPORT_A, name: 'Example Origin', iata: 'AAA', timezone: 'America/Los_Angeles' } },
      { remoteAirline: { id: AIRLINE, name: 'Example Air', iata: 'ZZ' } },
      { remoteProfile: { id: OTHER, fullName: 'Friend Flyer', firstName: 'Friend' } },
      { remoteConnectedFriendRelationship: { id: 'rel-1', senderUserId: OWNER, receiverUserId: OTHER, receiverFirstName: 'Fallback', senderFirstName: 'Owner' } },
      { remoteUserFlight: flightRecord(OWNER, FLIGHT, { isMine: true }) },
      { remoteUserFlight: flightRecord(OWNER, trackedId, { isMine: false }) },
      { remoteUserFlight: flightRecord(OTHER, friendId, { isMine: false, importSource: 'SHARED_WITH_YOU', sharingUrl: 'https://live.flighty.app/s/example' }) },
    ],
    pagination: { moreData: false },
  });
  const calls = mockFetch([
    syncRoute(body),
    ['GET', `${API}/v1/flight/${unknownId}`, () => protoResponse(proto.encode('GetSharingLinkResponseProto', {}))],
  ]);
  const service = new FlightyService(reader());
  const listed = await service.listFlights(TOKEN);
  assert.equal(listed.total, 3);
  const friend = listed.flights.find((flight) => flight.id === friendId);
  const tracked = listed.flights.find((flight) => flight.id === trackedId);
  assert.equal(friend.owner_name, 'Friend Flyer');
  assert.equal(friend.friend_id, OTHER);
  assert.equal(friend.shared, true);
  assert.equal(friend.relationship, 'friend');
  assert.equal(tracked.relationship, 'tracked');
  assert.equal(tracked.friend_id, null);
  assert.equal(tracked.shared, false);
  assert.equal((await service.listFlights(TOKEN, { mine_only: true })).flights.map((flight) => flight.id).join(), FLIGHT);
  const before = calls.length;
  const cached = await service.getFlight(TOKEN, friendId);
  assert.equal(calls.length, before);
  assert.equal(cached.source, 'cache');
  assert.equal(cached.flights[0].friend_id, OTHER);
  const live = await service.getFlight(TOKEN, unknownId);
  assert.equal(live.meta.operation, 'get_flight');
  assert.equal(calls.at(-1).url.pathname, `/v1/flight/${unknownId}`);
});

test('update_ticket preserves editable fields and drops server metadata', async () => {
  const ticket = { flightId: FLIGHT, userId: OWNER, pnr: 'ABC123', seatNumber: '1A', cabinClass: 'ECONOMY' };
  const body = proto.encode('SyncResponseProto', { data: [{ remoteTicket: ticket }], pagination: { moreData: false } });
  const calls = mockFetch([
    ['POST', (c) => c.url.pathname === '/v1/sync/full' && c.body.length === 0, () => protoResponse(body)],
    ['POST', SYNC, () => new Response(null, { status: 200 })],
  ]);
  await new FlightyService(writer()).updateTicket(TOKEN, FLIGHT, { seatNumber: '2B' });
  const sent = proto.decode('SyncRequestProto', calls.at(-1).body).changes[0].ticketInfoAction;
  assert.deepEqual(sent, { flightId: FLIGHT, pnr: 'ABC123', seatNumber: '2B', cabinClass: 'ECONOMY' });
});
