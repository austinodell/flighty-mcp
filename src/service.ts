/** Account views and common flight edits over the API client. */
import * as proto from './proto.js';
import { FlightyClient, Snapshot, timestamp, tokenSubject, utcNow, uuidText } from './client.js';
import { MIN_SYNC_INTERVAL } from './config.js';
import { FlightyError } from './errors.js';
import { runSyncJob, type SyncJob } from './refresh.js';
import { viewFromMeta, type AccountStore, type CacheMeta, type CacheView } from './store.js';

type Json = Record<string, any>;

function validZone(zone: string | null | undefined): string {
  if (!zone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/** ISO 8601 wall-clock time in the given IANA zone with its UTC offset, e.g. 2099-01-02T12:00:00-08:00. */
export function localTime(value: string | null | undefined, zone: string | null | undefined): string | null {
  if (!value) return null;
  const ms = timestamp(value);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: validZone(zone), hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMinutes = Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

export function flightSummary(record: Json, snapshot: Snapshot, manual = false): Json {
  const flight: Json = manual ? record : record.flight ?? {};
  const airports = new Map(snapshot.items('remoteAirport').map((item) => [item.id, item]));
  const airlines = new Map(snapshot.items('remoteAirline').map((item) => [item.id, item]));
  const departure: Json = flight.departure ?? {};
  const arrival: Json = flight.arrival ?? {};
  const origin: Json = airports.get(departure.airportId) ?? departure.airport ?? {};
  const destinationId = arrival.actualAirportId || arrival.scheduledAirportId;
  const destination: Json = airports.get(destinationId) ?? (arrival.actualAirport || arrival.scheduledAirport || {});
  const airline: Json = airlines.get(flight.airlineId) ?? flight.airline ?? {};
  const departSchedule: Json = departure.schedule ?? {};
  const arriveSchedule: Json = arrival.schedule ?? {};
  const number = flight.flightNumber ?? '';
  const scheduled = departSchedule.gateOriginal;
  return {
    id: record.id,
    manual,
    owner_user_id: record.userId ?? null,
    flight_number: (`${airline.iata || airline.icao || ''} ${number}`).trim(),
    airline: airline.name ?? null,
    airline_id: flight.airlineId ?? null,
    origin: { id: departure.airportId ?? null, iata: origin.iata ?? null, name: origin.name ?? null, timezone: origin.timezone ?? null },
    destination: {
      id: destinationId || null, iata: destination.iata ?? null, name: destination.name ?? null, timezone: destination.timezone ?? null,
    },
    departure_scheduled: scheduled ?? null,
    departure_local: localTime(scheduled, origin.timezone),
    departure_estimated: departSchedule.gateEstimated ?? null,
    departure_actual: departSchedule.gateActual ?? null,
    arrival_scheduled: arriveSchedule.gateOriginal ?? null,
    arrival_local: localTime(arriveSchedule.gateOriginal, destination.timezone),
    arrival_estimated: arriveSchedule.gateEstimated ?? null,
    arrival_actual: arriveSchedule.gateActual ?? null,
    departure_gate: departure.gate ?? null,
    arrival_gate: arrival.gate ?? null,
    departure_terminal: departure.terminal ?? null,
    arrival_terminal: arrival.terminal ?? null,
    canceled: flight.isCanceled ?? false,
    archived: record.archived ?? false,
    is_mine: record.isMine ?? false,
    distance_km: flight.distance ?? flight.distanceKm ?? null,
    equipment: flight.equipment ?? null,
    updated: record.updated ?? null,
  };
}

export function cacheInfo(snapshot: Snapshot): Json {
  const age = Math.max(0, Math.round((Date.now() - snapshot.storedAt) / 1000));
  return {
    fetched_at: snapshot.fetchedAt,
    last_refreshed: snapshot.fetchedAt,
    pages: snapshot.pages,
    minimum_refresh_interval_seconds: MIN_SYNC_INTERVAL,
    refresh_limited: snapshot.refreshLimited,
    schema_unknown_fields_present: snapshot.unknownFields,
    cache_age_seconds: age,
    status: 'ready',
    source: 'memory',
  };
}

function cacheFromView(view: CacheView): Json {
  return {
    fetched_at: view.last_refreshed,
    last_refreshed: view.last_refreshed,
    pages: view.pages,
    pages_done: view.pages_done,
    minimum_refresh_interval_seconds: MIN_SYNC_INTERVAL,
    refresh_limited: view.refresh_limited,
    schema_unknown_fields_present: view.schema_unknown_fields_present,
    cache_age_seconds: view.cache_age_seconds,
    status: view.status,
    source: 'd1',
    continuation: view.continuation,
    last_error: view.last_error,
  };
}

function catalogIds(record: Json, manual: boolean): { airports: string[]; airlines: string[] } {
  const flight: Json = manual ? record : record.flight ?? {};
  const departure: Json = flight.departure ?? {};
  const arrival: Json = flight.arrival ?? {};
  const airports = [departure.airportId, arrival.actualAirportId, arrival.scheduledAirportId].filter((id): id is string => typeof id === 'string' && id.length > 0);
  const airlines = [flight.airlineId].filter((id): id is string => typeof id === 'string' && id.length > 0);
  return { airports, airlines };
}

export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export interface ListFlightsOptions {
  when?: 'all' | 'upcoming' | 'past';
  mine_only?: boolean;
  archived?: boolean | null;
  origin?: string | null;
  destination?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  limit?: number;
  offset?: number;
  refresh?: boolean;
  details?: boolean;
}

export class FlightyService {
  constructor(public client: FlightyClient) {}

  private store(): AccountStore | null {
    return this.client.repository();
  }

  private async readyMeta(store: AccountStore, token: string): Promise<CacheMeta> {
    const accountId = tokenSubject(token);
    const meta = await store.read(accountId);
    if (!meta || meta.generation < 1) {
      throw new FlightyError(meta?.status === 'refreshing'
        ? 'Account cache refresh is in progress. Call refresh_cache again after it finishes.'
        : 'Account cache is empty. Call refresh_cache or wait for the hourly sync.');
    }
    return meta;
  }

  async refreshCache(token: string, opts: { refresh?: boolean; force?: boolean; complete?: boolean } = {}): Promise<Json> {
    const store = this.store();
    const settings = this.client.settings;
    if (!store) {
      const snapshot = await this.client.snapshot(token, { refresh: opts.refresh !== false, freshForWrite: Boolean(opts.force) });
      const cache = cacheInfo(snapshot);
      return {
        account_id: snapshot.accountId,
        status: 'ready',
        counts: Object.fromEntries(Object.entries(snapshot.records).map(([kind, items]) => [kind, items.length])),
        last_refreshed: snapshot.fetchedAt,
        cache_age_seconds: cache.cache_age_seconds,
        pages: snapshot.pages,
        pages_done: snapshot.pages,
        refresh_limited: snapshot.refreshLimited,
        schema_unknown_fields_present: snapshot.unknownFields,
        continuation: 'complete',
        cache,
        writes_enabled: settings.allowWrites,
        account_deletion_enabled: settings.allowAccountDeletion,
      };
    }
    const accountId = tokenSubject(token);
    if (opts.refresh === false) {
      await store.ensure(accountId);
      const meta = await store.read(accountId);
      const view = viewFromMeta(meta!);
      return {
        ...view,
        cache: cacheFromView(view),
        writes_enabled: settings.allowWrites,
        account_deletion_enabled: settings.allowAccountDeletion,
      };
    }
    const job: SyncJob = { op: 'start', force: opts.force };
    let view = await runSyncJob({
      client: this.client,
      store,
      token,
      op: job.op,
      force: job.force,
      pages: opts.complete ? settings.maxPages : settings.syncPagesPerRun,
    });
    if (view.more && !view.already_running && !view.refresh_limited) {
      const queued = opts.complete ? false : await this.client.enqueueSync({ op: 'continue' }, token);
      if (queued) view = { ...view, continuation: 'queued' };
      else {
        view = await runSyncJob({ client: this.client, store, token, op: 'continue', pages: settings.maxPages });
        if (opts.complete && view.more) {
          await store.fail(accountId, 'Flighty pagination exceeded max-pages; incomplete download was not cached.', true);
          throw new FlightyError('Flighty pagination exceeded max-pages; incomplete download was not cached.');
        }
      }
    }
    return {
      ...view,
      cache: cacheFromView(view),
      writes_enabled: settings.allowWrites,
      account_deletion_enabled: settings.allowAccountDeletion,
    };
  }

  async listFlights(token: string, opts: ListFlightsOptions = {}): Promise<Json> {
    const { when = 'all', mine_only = false, archived = null, origin, destination, start_date, end_date, limit = 50, offset = 0, refresh = false, details = false } = opts;
    if (!['all', 'upcoming', 'past'].includes(when) || !(limit >= 1 && limit <= 200) || offset < 0) {
      throw new FlightyError('Invalid list filter/pagination; limit must be 1..200 and offset nonnegative.');
    }
    for (const date of [start_date, end_date]) {
      if (date && !isDate(date)) throw new FlightyError('Dates must use YYYY-MM-DD.');
    }
    if (start_date && end_date && start_date > end_date) throw new FlightyError('start_date must not follow end_date.');
    const loaded = await this.flightSnapshot(token, refresh);
    const snapshot = loaded.snapshot;
    const normal: [Json, boolean][] = [
      ...snapshot.owned('remoteUserFlight').map((record): [Json, boolean] => [record, false]),
      ...snapshot.owned('remoteUserManualFlight').map((record): [Json, boolean] => [record, true]),
    ];
    const found: Json[] = [];
    const now = Date.now();
    for (const [record, manual] of normal) {
      const summary = flightSummary(record, snapshot, manual);
      const dep = summary.departure_scheduled;
      const depTime = dep ? timestamp(dep) : null;
      if (mine_only && !summary.is_mine) continue;
      if (archived !== null && archived !== undefined && summary.archived !== archived) continue;
      if (when === 'upcoming' && (depTime === null || depTime < now)) continue;
      if (when === 'past' && (depTime === null || depTime >= now)) continue;
      if (origin && !JSON.stringify(summary.origin).toLowerCase().includes(origin.toLowerCase())) continue;
      if (destination && !JSON.stringify(summary.destination).toLowerCase().includes(destination.toLowerCase())) continue;
      const localDate = (summary.departure_local ?? '').slice(0, 10);
      if (start_date && localDate < start_date) continue;
      if (end_date && (!localDate || localDate > end_date)) continue;
      if (details) summary.record = record;
      found.push(summary);
    }
    const sortKey = (item: Json) => [item.departure_scheduled ?? '9999', String(item.id)];
    found.sort((a, b) => {
      const [ad, ai] = sortKey(a);
      const [bd, bi] = sortKey(b);
      return ad < bd ? -1 : ad > bd ? 1 : ai < bi ? -1 : ai > bi ? 1 : 0;
    });
    const page = found.slice(offset, offset + limit);
    return {
      total: found.length,
      count: page.length,
      offset,
      limit,
      next_offset: offset + limit < found.length ? offset + limit : null,
      flights: page,
      cache: loaded.cache,
    };
  }

  private async flightSnapshot(token: string, refresh: boolean): Promise<{ snapshot: Snapshot; cache: Json }> {
    const store = this.store();
    if (!store) {
      const snapshot = await this.client.snapshot(token, { refresh });
      return { snapshot, cache: cacheInfo(snapshot) };
    }
    const refreshed = refresh ? await this.refreshCache(token, { refresh: true }) : null;
    const meta = await this.readyMeta(store, token);
    const flights = await store.payloads(meta.account_id, meta.generation, 'remoteUserFlight', { userId: meta.account_id });
    const manuals = await store.payloads(meta.account_id, meta.generation, 'remoteUserManualFlight', { userId: meta.account_id });
    const airportIds: string[] = [];
    const airlineIds: string[] = [];
    for (const record of flights) {
      const ids = catalogIds(record, false);
      airportIds.push(...ids.airports);
      airlineIds.push(...ids.airlines);
    }
    for (const record of manuals) {
      const ids = catalogIds(record, true);
      airportIds.push(...ids.airports);
      airlineIds.push(...ids.airlines);
    }
    const airports = await store.payloadsByIds(meta.account_id, meta.generation, 'remoteAirport', airportIds);
    const airlines = await store.payloadsByIds(meta.account_id, meta.generation, 'remoteAirline', airlineIds);
    const snapshot = new Snapshot(
      meta.account_id,
      { remoteUserFlight: flights, remoteUserManualFlight: manuals, remoteAirport: airports, remoteAirline: airlines },
      meta.pages,
      meta.fetched_at ?? utcNow(),
      meta.stored_at ?? Date.now(),
      meta.unknown_fields,
    );
    snapshot.refreshLimited = Boolean(refreshed?.refresh_limited);
    return { snapshot, cache: cacheFromView(viewFromMeta(meta, { refresh_limited: snapshot.refreshLimited })) };
  }

  async accountRecords(token: string, kind: string, opts: { limit?: number; offset?: number; refresh?: boolean } = {}): Promise<Json> {
    const { limit = 50, offset = 0, refresh = false } = opts;
    const definition = proto.SCHEMA.SyncResponseData;
    const kinds = definition.kind === 'message' ? definition.fields.map((f) => f.json_name) : [];
    if (!kinds.includes(kind) || !(limit >= 1 && limit <= 200) || offset < 0) {
      throw new FlightyError('Invalid record kind/limit/offset. Use get_schema(\'SyncResponseData\') for kinds.');
    }
    const store = this.store();
    if (store) {
      let refreshLimited = false;
      if (refresh) refreshLimited = Boolean((await this.refreshCache(token, { refresh: true })).refresh_limited);
      const meta = await this.readyMeta(store, token);
      const owned = ['remoteUserFlight', 'remoteUserManualFlight'].includes(kind);
      const page = await store.pagePayloads(meta.account_id, meta.generation, kind, offset, limit, owned ? meta.account_id : undefined);
      const view = viewFromMeta(meta, { refresh_limited: refreshLimited });
      return {
        kind,
        total: page.total,
        records: page.records,
        next_offset: offset + limit < page.total ? offset + limit : null,
        cache: cacheFromView(view),
      };
    }
    const snapshot = await this.client.snapshot(token, { refresh });
    const records = ['remoteUserFlight', 'remoteUserManualFlight'].includes(kind) ? snapshot.owned(kind) : snapshot.items(kind);
    return {
      kind,
      total: records.length,
      records: records.slice(offset, offset + limit),
      next_offset: offset + limit < records.length ? offset + limit : null,
      cache: cacheInfo(snapshot),
    };
  }

  async searchCatalog(token: string, kind: string, query: string, limit = 20): Promise<Json> {
    if (!['remoteAirport', 'remoteAirline', 'remoteAircraftType', 'remoteMetroArea'].includes(kind) || !(limit >= 1 && limit <= 100)) {
      throw new FlightyError('Unsupported catalog or limit.');
    }
    const store = this.store();
    if (store) {
      const meta = await this.readyMeta(store, token);
      const rows = await store.payloads(meta.account_id, meta.generation, kind);
      const needle = query.trim().toLowerCase();
      const keys = ['id', 'name', 'iata', 'icao', 'city', 'country', 'modelName'];
      const matches = rows.filter((item) => keys.map((key) => String(item[key] ?? '')).join(' ').toLowerCase().includes(needle));
      matches.sort((a, b) => {
        const ea = String(a.iata ?? '').toLowerCase() !== needle ? 1 : 0;
        const eb = String(b.iata ?? '').toLowerCase() !== needle ? 1 : 0;
        if (ea !== eb) return ea - eb;
        const na = String(a.name ?? '');
        const nb = String(b.name ?? '');
        return na < nb ? -1 : na > nb ? 1 : 0;
      });
      return { total: matches.length, results: matches.slice(0, limit), cache: cacheFromView(viewFromMeta(meta)) };
    }
    const snapshot = await this.client.snapshot(token);
    const needle = query.trim().toLowerCase();
    const keys = ['id', 'name', 'iata', 'icao', 'city', 'country', 'modelName'];
    const matches = snapshot.items(kind).filter((item) => keys.map((key) => String(item[key] ?? '')).join(' ').toLowerCase().includes(needle));
    matches.sort((a, b) => {
      const ea = String(a.iata ?? '').toLowerCase() !== needle ? 1 : 0;
      const eb = String(b.iata ?? '').toLowerCase() !== needle ? 1 : 0;
      if (ea !== eb) return ea - eb;
      const na = String(a.name ?? '');
      const nb = String(b.name ?? '');
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
    return { total: matches.length, results: matches.slice(0, limit), cache: cacheInfo(snapshot) };
  }

  async updateTicket(token: string, flightId: string, fields: Json): Promise<Json> {
    this.client.requireWrites();
    uuidText(flightId);
    const allowed = new Set(['pnr', 'seatNumber', 'seatPosition', 'cabinClass', 'flightReason']);
    const keys = Object.keys(fields ?? {});
    if (!keys.length || keys.some((k) => !allowed.has(k)) || Object.values(fields).some((v) => v === null || v === undefined)) {
      throw new FlightyError('Supply non-null ticket fields: pnr, seatNumber, seatPosition, cabinClass, flightReason.');
    }
    const store = this.store();
    let tickets: Json[];
    if (store) {
      await this.refreshCache(token, { force: true, complete: true });
      const meta = await this.readyMeta(store, token);
      const rows = await store.payloads(meta.account_id, meta.generation, 'remoteTicket', { flightId });
      tickets = rows.filter((item) => (item.userId ?? meta.account_id) === meta.account_id);
    } else {
      const snapshot = await this.client.snapshot(token, { refresh: true, freshForWrite: true });
      tickets = snapshot.items('remoteTicket').filter(
        (item) => item.flightId === flightId && (item.userId ?? snapshot.accountId) === snapshot.accountId,
      );
    }
    const payload: Json = Object.fromEntries(Object.entries(tickets[0] ?? {}).filter(([key]) => allowed.has(key)));
    Object.assign(payload, structuredClone(fields));
    payload.flightId = flightId;
    return await this.client.applyChanges(token, [{ ticketInfoAction: payload }]);
  }
}
