import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
const out = mkdtempSync(path.join(repoRoot, 'dist', 'flighty-cache-'));
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
const { runSyncJob } = await import(`${base}/refresh.js`);
const { AccountStore } = await import(`${base}/store.js`);
const { ownerAllowed } = await import(`${base}/owner.js`);
const { verifyAccessIdToken } = await import(`${base}/access-handler.js`);
const { handleScheduled, handleSyncMessage } = await import(`${base}/schedule.js`);

const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const FLIGHT = '10000000-0000-4000-8000-000000000001';
const SECOND_FLIGHT = '10000000-0000-4000-8000-000000000002';
const AIRPORT_A = '20000000-0000-4000-8000-000000000001';
const AIRPORT_B = '20000000-0000-4000-8000-000000000002';
const AIRLINE = '30000000-0000-4000-8000-000000000001';
const API = 'https://api.flightyapp.com';
const SYNC = `${API}/v1/sync/full`;

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
function fakeToken(subject = OWNER, salt = 'test-only') {
  return `${b64url({ alg: 'HS512', typ: 'JWT' })}.${b64url({ sub: subject, iss: 'flighty-api', iat: 0 })}.${salt}`;
}
const TOKEN = fakeToken();

function flightRecord(owner = OWNER, flightId = FLIGHT, overrides = {}) {
  return {
    id: flightId,
    userId: owner,
    isMine: owner === OWNER,
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
    throw new TypeError('unmocked fetch');
  };
  return calls;
}
const protoResponse = (bytes, status = 200) => new Response(bytes, { status, headers: { 'Content-Type': 'application/x-protobuf' } });

function createSqliteD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(path.join(repoRoot, 'migrations/0001_account_cache.sql'), 'utf8'));
  const d1 = {
    prepare(sql) {
      return {
        _args: [],
        bind(...args) {
          this._args = args;
          return this;
        },
        async run() {
          const info = db.prepare(sql).run(...this._args);
          return { success: true, meta: { changes: Number(info.changes ?? 0) } };
        },
        async all() {
          return { results: db.prepare(sql).all(...this._args) };
        },
        async first() {
          return db.prepare(sql).get(...this._args) ?? null;
        },
      };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db, d1 };
}

function settings() {
  return { ...loadSettings(), buildToken: 'synthetic-build-credential', allowWrites: false, syncPagesPerRun: 1 };
}

test.beforeEach(() => {
  setEnv({ FLIGHTY_TOKEN: TOKEN });
  clearCache();
  mockFetch([]);
});

test('owner allowlist fails closed', () => {
  assert.equal(ownerAllowed('Owner@Example.com', 'owner@example.com'), true);
  assert.equal(ownerAllowed('other@example.com', 'owner@example.com'), false);
  assert.equal(ownerAllowed('owner@example.com', ''), false);
  assert.equal(ownerAllowed('', 'owner@example.com'), false);
  assert.equal(ownerAllowed(undefined, undefined), false);
});

test('MCP bearer token is not an authentication path', () => {
  const index = readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf8');
  const wrangler = readFileSync(path.join(repoRoot, 'wrangler.jsonc'), 'utf8');
  assert.equal(index.includes('MCP_TOKEN'), false);
  assert.match(wrangler, /flight-mcp\.odell\.io/);
  assert.match(wrangler, /"custom_domain": true/);
  assert.match(wrangler, /"crons": \["0 \* \* \* \*"\]/);
  assert.match(wrangler, /"traces": \{ "enabled": true/);
  assert.match(wrangler, /flighty-mcp-sync/);
  assert.match(wrangler, /"binding": "DB"/);
  assert.match(wrangler, /"binding": "OAUTH_KV"/);
});

test('access id token is verified and a bad signature is rejected', async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  jwk.kid = 'test-key';
  async function sign(payload) {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' }));
    const body = b64url(JSON.stringify(payload));
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${header}.${body}`));
    return `${header}.${body}.${Buffer.from(signature).toString('base64url')}`;
  }
  const jwks = 'https://access.example/jwks';
  mockFetch([['GET', jwks, () => Response.json({ keys: [jwk] })]]);
  const claims = await verifyAccessIdToken(
    { ACCESS_JWKS_URL: jwks },
    await sign({ email: 'owner@example.com', sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 600 }),
  );
  assert.equal(ownerAllowed(claims.email, 'owner@example.com'), true);
  await assert.rejects(
    verifyAccessIdToken({ ACCESS_JWKS_URL: jwks }, await sign({ email: 'owner@example.com', sub: 'user-1', exp: 1 })),
    /expired/,
  );
});

test('sync stores one page before fetching the next and reads do not sync again', async () => {
  const { db, d1 } = createSqliteD1();
  setEnv({ FLIGHTY_TOKEN: TOKEN, DB: d1 });
  const pages = [
    syncBody([flightRecord(), flightRecord(OTHER)], { more: true, cursor: '?cursor=two' }),
    syncBody([flightRecord(OWNER, SECOND_FLIGHT, { isMine: false })], { more: true, cursor: '?cursor=three' }),
    syncBody(),
  ];
  let storedBeforeSecond = -1;
  const calls = mockFetch([['POST', SYNC, () => {
    if (calls.length === 2) storedBeforeSecond = db.prepare('SELECT COUNT(*) AS n FROM account_records').get().n;
    return protoResponse(pages[calls.length - 1] ?? pages.at(-1));
  }]]);
  const client = new FlightyClient(settings());
  const store = new AccountStore(d1);
  const first = await runSyncJob({ client, store, token: TOKEN, op: 'start', pages: 1, now: 1_700_000_000_000 });
  assert.equal(calls.length, 1);
  assert.equal(first.status, 'refreshing');
  assert.equal(first.more, true);
  assert.equal(db.prepare('SELECT generation FROM account_cache').get().generation, 0);
  const second = await runSyncJob({ client, store, token: TOKEN, op: 'continue', pages: 1, now: 1_700_000_000_000 });
  assert.equal(calls.length, 2);
  assert.ok(storedBeforeSecond > 0);
  assert.equal(second.more, true);
  const third = await runSyncJob({ client, store, token: TOKEN, op: 'continue', pages: 1, now: 1_700_000_000_000 });
  assert.equal(third.status, 'ready');
  assert.equal(third.more, false);
  assert.equal(third.counts.remoteUserFlight, 3);
  assert.equal(calls.length, 3);
  const service = new FlightyService(client);
  const listed = await service.listFlights(TOKEN);
  assert.equal(calls.length, 3);
  assert.equal(listed.total, 3);
  const friend = listed.flights.find((flight) => flight.owner_user_id === OTHER);
  assert.equal(friend.friend_id, OTHER);
  assert.equal(friend.relationship, 'friend');
  assert.equal((await service.listFlights(TOKEN, { mine_only: true })).total, 1);
  const lookedUp = await service.getFlight(TOKEN, FLIGHT);
  assert.equal(lookedUp.source, 'cache');
  assert.equal(lookedUp.flights.some((flight) => flight.friend_id === OTHER), true);
  assert.equal(calls.length, 3);
  assert.equal(listed.cache.source, 'd1');
  assert.equal(typeof listed.cache.cache_age_seconds, 'number');
  assert.ok(listed.cache.last_refreshed);
  const storedFlights = await store.payloads(OWNER, 1, 'remoteUserFlight');
  assert.equal(storedFlights.length, 3);
  const user = await store.payloads(OWNER, 1, 'remoteUser');
  assert.equal(user[0].token, '[REDACTED]');
});

test('manual refresh inside 60 seconds does not call Flighty', async () => {
  const { d1 } = createSqliteD1();
  setEnv({ FLIGHTY_TOKEN: TOKEN, DB: d1 });
  const calls = mockFetch([['POST', SYNC, () => protoResponse(syncBody())]]);
  const client = new FlightyClient(settings());
  const store = new AccountStore(d1);
  const now = 1_700_000_000_000;
  await runSyncJob({ client, store, token: TOKEN, op: 'start', pages: 5, now });
  const limited = await runSyncJob({ client, store, token: TOKEN, op: 'start', pages: 5, now: now + 1000 });
  assert.equal(limited.refresh_limited, true);
  assert.equal(calls.length, 1);
  const again = await runSyncJob({ client, store, token: TOKEN, op: 'start', force: true, pages: 5, now: now + 1000 });
  assert.equal(again.refresh_limited, false);
  assert.equal(calls.length, 2);
  const later = await runSyncJob({ client, store, token: TOKEN, op: 'start', pages: 5, now: now + 120_000 });
  assert.equal(later.refresh_limited, false);
  assert.equal(calls.length, 3);
});

test('a failed later page is not published and the next step resumes', async () => {
  const { db, d1 } = createSqliteD1();
  setEnv({ FLIGHTY_TOKEN: TOKEN, DB: d1 });
  let second = 0;
  const calls = mockFetch([
    ['POST', (call) => call.url.searchParams.get('cursor') === 'two', () => {
      second += 1;
      if (second === 1) throw new TypeError('reset');
      return protoResponse(syncBody([flightRecord(OWNER, SECOND_FLIGHT)]));
    }],
    ['POST', SYNC, () => protoResponse(syncBody(undefined, { more: true, cursor: '?cursor=two' }))],
  ]);
  const client = new FlightyClient(settings());
  const store = new AccountStore(d1);
  await assert.rejects(runSyncJob({ client, store, token: TOKEN, op: 'start', pages: 5 }), /network|Account sync failed/);
  assert.equal(db.prepare('SELECT generation, status FROM account_cache').get().generation, 0);
  assert.equal(db.prepare('SELECT status FROM account_cache').get().status, 'refreshing');
  const done = await runSyncJob({ client, store, token: TOKEN, op: 'continue', pages: 5 });
  assert.equal(done.status, 'ready');
  assert.equal(done.counts.remoteUserFlight, 2);
  assert.equal(calls.filter((call) => call.url.searchParams.get('cursor') === 'two').length, 2);
});

test('a broken cursor does not publish a partial generation', async () => {
  const { db, d1 } = createSqliteD1();
  setEnv({ FLIGHTY_TOKEN: TOKEN, DB: d1 });
  mockFetch([['POST', SYNC, () => protoResponse(syncBody(undefined, { more: true }))]]);
  const client = new FlightyClient(settings());
  const store = new AccountStore(d1);
  await assert.rejects(runSyncJob({ client, store, token: TOKEN, op: 'start', pages: 5 }), /cursor/);
  const row = db.prepare('SELECT status, generation FROM account_cache').get();
  assert.equal(row.generation, 0);
  assert.equal(row.status, 'error');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_records').get().n, 0);
  await assert.rejects(new FlightyService(client).listFlights(TOKEN), /cache is empty/);
});

test('queue consumer fetches one page and enqueues the next', async () => {
  const { d1 } = createSqliteD1();
  const sent = [];
  const env = {
    FLIGHTY_TOKEN: TOKEN,
    DB: d1,
    SYNC_QUEUE: { async send(body) { sent.push(body); } },
  };
  const calls = mockFetch([['POST', SYNC, () => protoResponse(syncBody(undefined, { more: true, cursor: '?cursor=two' }))]]);
  await handleSyncMessage(env, { op: 'start' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.length, 0);
  assert.deepEqual(sent, [{ op: 'continue' }]);
  const row = d1.prepare('SELECT status, generation FROM account_cache WHERE account_id = ?').bind(OWNER);
  const meta = await row.first();
  assert.equal(meta.status, 'refreshing');
  assert.equal(meta.generation, 0);
});

test('hourly schedule enqueues a default-account refresh', async () => {
  const sent = [];
  const env = {
    FLIGHTY_TOKEN: TOKEN,
    SYNC_QUEUE: { async send(body) { sent.push(body); } },
  };
  await handleScheduled(env);
  assert.deepEqual(sent, [{ op: 'start' }]);
});
