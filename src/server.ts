/** MCP tools and resources. A fresh server is built per request with that request's Flighty credential resolver. */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import * as proto from './proto.js';
import { FlightyClient, tokenSubject, uuidText } from './client.js';
import { VERSION, WEBSOCKET_URL } from './config.js';
import { ENDPOINTS, catalog, pathKeys } from './endpoints.js';
import { FlightyError } from './errors.js';
import { FlightyService, isDate } from './service.js';

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const LOCAL: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const INSTRUCTIONS =
  'Unofficial Flighty integration. Read tools use the app\'s bodyless sync download path. ' +
  'Use list_flights, search_airports and search_airlines to discover real IDs. ' +
  'Use get_schema before constructing advanced protobuf payloads; JSON is encoded to binary protobuf. ' +
  'Writes are enabled by default and require explicit user intent. Account deletion is disabled by default. ' +
  'Core flight edits have been live-tested; additional account and integration operations have only mock coverage. ' +
  'Do not delete, import, link accounts, register devices or submit bulk changes without a specific request. ' +
  'Never ask for bearer tokens in tool arguments; credentials arrive through Worker secrets or request headers. ' +
  'Omitted optional mutation fields may clear existing values; use update_ticket to preserve known fields. ' +
  'Rate limits are undocumented. Read tools serve the D1 account cache; call refresh_cache to sync. ' +
  'The hourly job and refresh_cache fetch one sync page per invocation. Avoid polling.';

const jsonObject = () => z.record(z.string(), z.any());
const stringMap = () => z.record(z.string(), z.string());

// McpServer.tool infers a Zod generic that exhausts tsc. Handlers validate with schema.parse.
function toolArgs(schema: { shape: unknown }) {
  return schema.shape as any;
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function createServer(resolveToken: () => string): McpServer {
  const api = new FlightyClient();
  const service = new FlightyService(api);
  const server = new McpServer({ name: 'flighty', version: VERSION }, { instructions: INSTRUCTIONS });

  const tool = <S extends z.ZodObject<any>>(
    name: string,
    description: string,
    schema: S,
    annotations: ToolAnnotations,
    handler: (input: z.infer<S>) => Promise<unknown> | unknown,
  ) => {
    server.tool(name, description, toolArgs(schema), annotations, async (args: unknown) => text(await handler(schema.parse(args ?? {}))));
  };

  tool(
    'get_schema',
    'Inspect supported protobuf fields, numbers, types, enum values and oneof groups. Empty/partial name lists matching definitions. Full names, for example SyncChangeRequestProto.TicketInfoAction, show the complete field contract. Advanced tool payloads use ProtoJSON: RFC3339 timestamps, enum names, base64 bytes, and exactly one populated member per oneof group. This tool performs no network requests.',
    z.object({ name: z.string().default('') }),
    LOCAL,
    (input) => proto.describe(input.name),
  );

  tool(
    'get_endpoint_catalog',
    'List every supported HTTP operation, request/response schema and read/write classification. Includes the app-only TripIt browser flow and websocket protocol metadata.',
    z.object({}),
    LOCAL,
    () => catalog(),
  );

  tool(
    'list_flights',
    'List flights from the cached snapshot. mine_only=true returns only this account\'s My Flights. mine_only=false (default) also returns flights this account tracks and friends\' flights. Each row has owner_user_id, owner_name, friend_id, shared, and relationship (mine, tracked, or friend). Excludes server deletion markers. Date filters are YYYY-MM-DD in the departure airport\'s local timezone. Airport filters accept IATA, name or ID text. Sorted by departure time, earliest first. The cache object includes cache_age_seconds and last_refreshed. refresh=true starts a sync; within 60 seconds it reuses the last complete snapshot. limit 1..200. details=true also includes the full decoded user-flight record. If the cache is empty, call refresh_cache.',
    z.object({
      when: z.enum(['all', 'upcoming', 'past']).default('all'),
      mine_only: z.boolean().default(false),
      archived: z.boolean().nullable().optional(),
      origin: z.string().nullable().optional(),
      destination: z.string().nullable().optional(),
      start_date: z.string().nullable().optional(),
      end_date: z.string().nullable().optional(),
      limit: z.number().int().default(50),
      offset: z.number().int().default(0),
      refresh: z.boolean().default(false),
      details: z.boolean().default(false),
    }),
    READ,
    (input) => service.listFlights(resolveToken(), input),
  );

  tool(
    'sync_account',
    'Refresh or report the cached account snapshot without submitting changes. Uses POST /v1/sync/full with NO body, one page per Worker invocation, continued by the sync queue. Not the apply_changes tool. Returns record counts, cache_age_seconds and last_refreshed. Repeated manual refreshes within 60 seconds reuse the last complete snapshot. get_account_records reads categories from the cache.',
    z.object({ refresh: z.boolean().default(true) }),
    READ,
    (input) => service.refreshCache(resolveToken(), { refresh: input.refresh }),
  );

  tool(
    'refresh_cache',
    'Sync the Flighty account into the cache and return status, record counts, cache_age_seconds and last_refreshed. Read tools serve this cache instead of downloading the account on every call. A manual refresh within 60 seconds reports refresh_limited and does not call Flighty again. The default account continues page-by-page through the sync queue so a full sync is not held in Worker memory. The hourly cron starts the same refresh.',
    z.object({}),
    READ,
    () => service.refreshCache(resolveToken(), { refresh: true }),
  );

  tool(
    'get_account_records',
    'Read a sync category: tickets, notes, subscriptions, profile, friends, favorites, settings, etc. Discover category names with get_schema(\'SyncResponseData\'). Excludes deletion markers; flight categories are restricted to this account. Token/secret/receipt fields are redacted. limit 1..200. No outgoing account changes are sent.',
    z.object({
      kind: z.string(),
      limit: z.number().int().default(50),
      offset: z.number().int().default(0),
      refresh: z.boolean().default(false),
    }),
    READ,
    (input) => service.accountRecords(resolveToken(), input.kind, input),
  );

  const catalogTools: [string, string, string][] = [
    ['search_airports', 'remoteAirport', 'Search airports by IATA/ICAO code, name, city or country. Returns IDs needed by route searches, airport status and manual-flight edits. Uses cached reference data from a read-only sync. limit 1..100.'],
    ['search_airlines', 'remoteAirline', 'Search airlines by IATA/ICAO code or name. Returns the airlineId required for flight-number searches. Uses cached read-only account reference data. limit 1..100.'],
    ['search_aircraft_types', 'remoteAircraftType', 'Search aircraft type reference data by IATA/ICAO code or model name. Returns equipment IDs for manual flights. limit 1..100.'],
    ['search_metro_areas', 'remoteMetroArea', 'Search metro-area reference data for multi-airport route searches. limit 1..100.'],
  ];
  for (const [name, kind, description] of catalogTools) {
    tool(name, description, z.object({ query: z.string(), limit: z.number().int().default(20) }), READ, (input) =>
      service.searchCatalog(resolveToken(), kind, input.query, input.limit));
  }

  tool(
    'search_flights',
    'Search available flights by airline+number OR by origin+destination on YYYY-MM-DD. Search alone does not add/subscribe to a flight. Discover IDs using the airport/airline/metro lookup tools first. Pass a numeric flight_number without airline prefix. Route search endpoints can be airport or metro IDs.',
    z.object({
      departure_date: z.string(),
      airline_id: z.string().nullable().optional(),
      flight_number: z.string().nullable().optional(),
      origin_id: z.string().nullable().optional(),
      destination_id: z.string().nullable().optional(),
      origin_kind: z.enum(['airport', 'metro']).default('airport'),
      destination_kind: z.enum(['airport', 'metro']).default('airport'),
      via: z.string().default(''),
    }),
    READ,
    async (input) => {
      if (!isDate(input.departure_date)) throw new FlightyError('departure_date must use YYYY-MM-DD.');
      const body: Record<string, unknown> = { departureDate: input.departure_date, via: input.via };
      if (input.airline_id && input.flight_number && !input.origin_id && !input.destination_id) {
        body.flightNumberSearch = { airlineId: uuidText(input.airline_id), flightNumber: input.flight_number };
      } else if (input.origin_id && input.destination_id && !input.airline_id && !input.flight_number) {
        body.routeSearchProto = {
          origin: { [input.origin_kind]: { id: uuidText(input.origin_id) } },
          destination: { [input.destination_kind]: { id: uuidText(input.destination_id) } },
        };
      } else {
        throw new FlightyError('Provide airline_id+flight_number OR origin_id+destination_id, not both.');
      }
      return api.request('search_flights', resolveToken(), { payload: body });
    },
  );

  tool(
    'get_flight',
    'Fetch a flight by UUID. Flights in the account cache, including tracked and friends\' flights, are returned from the cache with owner_name, friend_id, shared, and relationship. A flight that is not in the cache uses the app\'s GET /v1/flight/{id} sharing/details response and does not add the flight. Account tokens are redacted.',
    z.object({ flight_id: z.string() }),
    READ,
    (input) => service.getFlight(resolveToken(), input.flight_id),
  );

  tool(
    'poll_flight',
    'Poll changing flight content, optionally using If-None-Match. Does not subscribe/add a flight. Uses the app\'s bodyless content-sync POST and X-Sync-Priority 0 or 10. A 304 result has not_modified=true. Prefer cached list_flights for routine reads.',
    z.object({
      flight_id: z.string(),
      etag: z.string().nullable().optional(),
      priority: z.union([z.literal(0), z.literal(10)]).default(0),
    }),
    READ,
    (input) => {
      const headers: Record<string, string> = { 'X-Sync-Priority': String(input.priority) };
      if (input.etag) {
        if (/[\r\n\0]/.test(input.etag) || input.etag.length > 1024) throw new FlightyError('Invalid ETag.');
        headers['If-None-Match'] = input.etag;
      }
      return api.request('poll_flight', resolveToken(), { path: { flight_id: input.flight_id }, headers });
    },
  );

  tool(
    'subscribe_flight',
    'Add/track a known flight UUID, normally discovered by search_flights. Mutating, requires writes enabled. is_passenger=true marks it as your flight; false tracks someone else\'s flight. Sends the app\'s is_passenger query string.',
    z.object({ flight_id: z.string(), is_passenger: z.boolean().default(true) }),
    WRITE,
    (input) => api.request('subscribe_flight', resolveToken(), {
      path: { flight_id: input.flight_id },
      params: { is_passenger: String(input.is_passenger) },
    }),
  );

  tool(
    'subscribe_random_flight',
    'Add a random flight to the account. This changes tracked flights; writes must be enabled.',
    z.object({ is_passenger: z.boolean().default(false) }),
    WRITE,
    (input) => api.request('subscribe_random_flight', resolveToken(), { params: { is_passenger: String(input.is_passenger) } }),
  );

  tool(
    'apply_changes',
    'Advanced sync editor supporting all 43 supported actions, with strict protobuf validation. Each object has exactly one action, plus an optional RFC3339 timestamp (generated if omitted). Inspect get_schema(\'SyncChangeRequestProto\') and the action\'s schema first. Requires writes enabled. Delete/remove/revoke/bulk actions additionally require confirm_destructive=true. No automatic retries or implicit empty changes. Omitted fields may clear values; provide a complete action when semantics are unclear.',
    z.object({ changes: z.array(jsonObject()), confirm_destructive: z.boolean().default(false) }),
    DESTRUCTIVE,
    (input) => api.applyChanges(resolveToken(), input.changes, { confirmDestructive: input.confirm_destructive }),
  );

  tool(
    'delete_flight',
    'Remove a flight from this account. Requires writes enabled and confirmation equal to flight_id. This is not archive. manual=true selects deleteManualFlightAction. Uses the authenticated account as implicit owner, omitting ownerUserId for own flights.',
    z.object({ flight_id: z.string(), confirmation: z.string(), manual: z.boolean().default(false) }),
    DESTRUCTIVE,
    (input) => {
      if (input.confirmation !== input.flight_id) throw new FlightyError('confirmation must exactly equal flight_id.');
      const token = resolveToken();
      const action = input.manual ? 'deleteManualFlightAction' : 'flightDeleteAction';
      return api.applyChanges(token, [{ [action]: { flightId: uuidText(input.flight_id) } }], { confirmDestructive: true });
    },
  );

  tool(
    'set_flight_archived',
    'Archive/unarchive a tracked flight, preserving it in account history. Requires writes enabled.',
    z.object({ flight_id: z.string(), archived: z.boolean() }),
    WRITE,
    (input) => {
      const token = resolveToken();
      const action = input.archived ? 'flightArchiveAction' : 'flightUnarchiveAction';
      return api.applyChanges(token, [{ [action]: { flightId: uuidText(input.flight_id), ownerUserId: tokenSubject(token) } }]);
    },
  );

  tool(
    'set_flight_mine',
    'Mark/unmark a tracked flight as My Flight. Requires writes enabled.',
    z.object({ flight_id: z.string(), is_mine: z.boolean() }),
    WRITE,
    (input) => {
      const action = input.is_mine ? 'flightSetMineAction' : 'flightUnsetMineAction';
      return api.applyChanges(resolveToken(), [{ [action]: { flightId: uuidText(input.flight_id) } }]);
    },
  );

  tool(
    'update_ticket',
    'Update booking reference/seat/cabin/reason while preserving known existing ticket fields. fields accepts pnr, seatNumber, seatPosition, cabinClass, flightReason. Inspect RemoteTicket enums with get_schema. Reads fresh ticket data before merging the provided fields; does not claim server patch semantics. Requires writes enabled.',
    z.object({ flight_id: z.string(), fields: jsonObject() }),
    WRITE,
    (input) => service.updateTicket(resolveToken(), input.flight_id, input.fields),
  );

  tool(
    'set_flight_note',
    'Set a flight note; an empty note explicitly clears it. Requires writes enabled.',
    z.object({ flight_id: z.string(), note: z.string() }),
    WRITE,
    (input) => api.applyChanges(resolveToken(), [{ userFlightNoteUploadChangeAction: { flightId: uuidText(input.flight_id), note: input.note } }]),
  );

  tool(
    'upsert_manual_flight',
    'Create/edit a manual flight using a complete ManualFlightChangeAction payload. Requires writes enabled. Required local identifiers: flightId, departureAirportId, arrivalScheduledAirportId, arrivalActualAirportId. Inspect get_schema for all time/equipment/airline fields. gateOriginal/Actual and runwayOriginal/Actual are timestamps, not gate/runway names. Omitted fields may clear existing values.',
    z.object({ flight: jsonObject() }),
    WRITE,
    (input) => {
      for (const name of ['flightId', 'departureAirportId', 'arrivalScheduledAirportId', 'arrivalActualAirportId']) {
        if (!(name in input.flight)) throw new FlightyError('Supply all four required manual-flight identifiers; see tool description.');
        uuidText(input.flight[name]);
      }
      return api.applyChanges(resolveToken(), [{ manualFlightChangeAction: input.flight }]);
    },
  );

  tool(
    'delete_account',
    'Permanently delete this Flighty account. This is separate from removing a flight. Requires both FLIGHTY_ALLOW_WRITES=true and FLIGHTY_ALLOW_ACCOUNT_DELETION=true, plus confirmation_user_id exactly matching the authenticated token\'s subject. Never use for cleanup or testing. Live behavior has deliberately not been tested.',
    z.object({ confirmation_user_id: z.string() }),
    DESTRUCTIVE,
    (input) => {
      const token = resolveToken();
      if (input.confirmation_user_id !== tokenSubject(token)) throw new FlightyError('Account deletion confirmation does not match this account.');
      return api.request('delete_account', token);
    },
  );

  const implemented = new Set(['search_flights', 'get_flight', 'poll_flight', 'subscribe_flight', 'subscribe_random_flight', 'sync_account', 'apply_changes', 'delete_account']);
  for (const operation of Object.keys(ENDPOINTS).filter((op) => !implemented.has(op)).sort()) {
    registerEndpointTool(operation);
  }

  function registerEndpointTool(operation: string) {
    const endpoint = ENDPOINTS[operation];
    const keys = pathKeys(endpoint.path).join(', ');
    const description =
      `${operation}: ${endpoint.method} ${endpoint.path}. ` +
      (endpoint.read_only ? 'Read-only lookup. ' : 'Mutating; requires FLIGHTY_ALLOW_WRITES=true. Not live-validated. ') +
      (endpoint.request ? `payload must match get_schema('${endpoint.request}'). ` : '') +
      (endpoint.json_body ? 'payload is the JSON object documented in docs/api.md. ' : '') +
      (keys ? `path keys: ${keys}. ` : 'No path parameters. ') +
      endpoint.notes;
    tool(
      operation,
      description,
      z.object({
        payload: jsonObject().nullable().optional(),
        path: stringMap().nullable().optional(),
        query: stringMap().nullable().optional(),
        confirm_destructive: z.boolean().default(false),
      }),
      endpoint.read_only ? READ : endpoint.destructive ? DESTRUCTIVE : WRITE,
      (input) => {
        const payload = input.payload ?? undefined;
        const query = input.query ?? undefined;
        if (endpoint.destructive && !input.confirm_destructive) {
          throw new FlightyError('This operation requires confirm_destructive=true in addition to writes enabled.');
        }
        const hasQuery = query && Object.keys(query).length > 0;
        if (hasQuery && operation !== 'import_calendar' && operation !== 'subscribe_shared_flights') {
          throw new FlightyError('This tool does not accept query parameters.');
        }
        if (hasQuery) {
          const allowed = operation === 'import_calendar' ? ['source'] : ['source', 'is_passenger'];
          if (Object.keys(query).some((k) => !allowed.includes(k))) throw new FlightyError('Unsupported query parameter for operation.');
          if (operation === 'import_calendar' && query.source !== undefined
            && !['initialSync', 'periodicSync', 'calendarChanges', 'silentPush'].includes(query.source)) {
            throw new FlightyError('Unsupported calendar source variant.');
          }
        }
        if (operation === 'submit_attribution') {
          const keys = Object.keys(payload ?? {}).sort().join(',');
          if (!payload || keys !== 'service,token' || payload.service !== 'ASA' || typeof payload.token !== 'string') {
            throw new FlightyError('Attribution payload requires string token and service=\'ASA\'.');
          }
        }
        if (operation === 'mark_year_in_review_viewed') {
          const keys = Object.keys(payload ?? {}).join(',');
          if (!payload || keys !== 'year' || typeof payload.year !== 'string' || !/^\d+$/.test(payload.year)) {
            throw new FlightyError('Year-in-review payload requires year as a digit string.');
          }
        }
        if (operation === 'create_share_link') {
          const items = payload?.items;
          if (!Array.isArray(items) || !items.length || items.length > 100 || Object.keys(payload ?? {}).join(',') !== 'items') {
            throw new FlightyError('Share payload requires 1..100 items containing Flighty sharing URLs.');
          }
          for (const item of items) {
            let ok = false;
            if (typeof item === 'string' && !/[?#]/.test(item)) {
              try {
                const url = new URL(item);
                ok = url.protocol === 'https:' && url.host === 'live.flighty.app';
              } catch { /* rejected below */ }
            }
            if (!ok) throw new FlightyError('Only HTTPS live.flighty.app sharing URLs without query/fragment are accepted.');
          }
        }
        return api.request(operation, resolveToken(), { payload, path: input.path ?? undefined, params: query });
      },
    );
  }

  tool(
    'wait_for_sync',
    'Wait once for a websocket requestSync notification; does not change account data. Registers the bearer with Flighty\'s websocket session, waits 1..30 seconds, and invalidates the local account cache if an update arrives. Does not return the bearer or subscribe/add any flight. Avoid loops; rate limits are unknown.',
    z.object({ timeout_seconds: z.number().int().default(20) }),
    READ,
    async (input) => {
      if (!(input.timeout_seconds >= 1 && input.timeout_seconds <= 30)) throw new FlightyError('timeout_seconds must be 1..30.');
      const token = resolveToken();
      return await waitForSync(token, input.timeout_seconds, () => api.invalidate(token));
    },
  );

  server.resource(
    'Flights',
    new ResourceTemplate('flighty://flights/{when}', { list: undefined }),
    { description: 'Cached account flights: all, upcoming, or past. First 200 records; use list_flights for pagination.', mimeType: 'application/json' },
    async (uri, vars) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(await service.listFlights(resolveToken(), { when: String(vars.when) as 'all', limit: 200 })),
      }],
    }),
  );

  server.resource(
    'Account records',
    new ResourceTemplate('flighty://account/{kind}', { list: undefined }),
    { description: 'First 200 records of a supported sync category, with credentials redacted.', mimeType: 'application/json' },
    async (uri, vars) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await service.accountRecords(resolveToken(), String(vars.kind), { limit: 200 })) }],
    }),
  );

  server.resource(
    'Protobuf schema',
    new ResourceTemplate('flighty://schema/{name}', { list: undefined }),
    { description: 'Local supported message/enum field contract.', mimeType: 'application/json' },
    async (uri, vars) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(proto.describe(decodeURIComponent(String(vars.name)))) }],
    }),
  );

  return server;
}

async function waitForSync(token: string, timeoutSeconds: number, invalidate: () => Promise<void>): Promise<Record<string, boolean>> {
  let socket: WebSocket;
  try {
    const response = await fetch(WEBSOCKET_URL, { headers: { Upgrade: 'websocket' }, signal: AbortSignal.timeout(10_000) });
    if (!response.webSocket) throw new Error('upgrade refused');
    socket = response.webSocket;
    socket.accept();
    socket.send(proto.encode('FlightyWebsocketsClientMessage', { registerSession: { tokens: [token] } }));
  } catch {
    throw new FlightyError('Flighty websocket request failed.');
  }
  return await new Promise((resolve, reject) => {
    const finish = (result: Record<string, boolean> | Error) => {
      clearTimeout(timer);
      try { socket.close(1000); } catch { /* already closed */ }
      if (result instanceof Error) reject(result); else resolve(result);
    };
    const timer = setTimeout(() => finish({ sync_requested: false, timed_out: true }), timeoutSeconds * 1000);
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') return;
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      if (bytes.length > 1024 * 1024) return finish(new FlightyError('Flighty websocket request failed.'));
      let message: Record<string, unknown>;
      try {
        message = proto.decode('FlightyWebsocketsServerMessage', bytes);
      } catch (error) {
        return finish(error as Error);
      }
      if ('requestSync' in message) invalidate().then(() => finish({ sync_requested: true }), finish);
    });
    socket.addEventListener('close', () => finish({ sync_requested: false }));
    socket.addEventListener('error', () => finish(new FlightyError('Flighty websocket request failed.')));
  });
}
