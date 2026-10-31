/** Flighty API transport, read-only sync, bounded per-credential cache and edits. */
import * as proto from './proto.js';
import { API_BASE, MIN_SYNC_INTERVAL, loadSettings, type Settings } from './config.js';
import { ENDPOINTS, pathKeys } from './endpoints.js';
import { FlightyError, WritesDisabled } from './errors.js';

type Json = Record<string, any>;

export function validateToken(token: string): string {
  token = token.trim();
  if (!token || token.length > 8192 || [...token].some((c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126)) {
    throw new FlightyError('A single Flighty bearer credential is required.');
  }
  return token;
}

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Canonical lowercase hyphenated UUID, like Python's str(UUID(value)). */
export function uuidText(value: unknown): string {
  if (typeof value !== 'string') throw new FlightyError('Expected a UUID identifier.');
  const trimmed = value.trim().replace(/^urn:uuid:/i, '').replace(/^\{(.*)\}$/, '$1');
  if (!UUID_RE.test(trimmed)) throw new FlightyError('Expected a UUID identifier.');
  const hex = trimmed.replaceAll('-', '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function base64UrlDecode(part: string): string {
  const b64 = part.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (part.length % 4)) % 4);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

/** Read an identity hint, never a signature verification or authorization check. */
export function tokenSubject(token: string): string {
  try {
    const payload = JSON.parse(base64UrlDecode(token.split('.')[1]));
    return uuidText(payload.sub);
  } catch {
    throw new FlightyError('Cannot determine account ID from credential. Expected Flighty\'s JWT token.');
  }
}

export function utcNow(): string {
  return new Date().toISOString();
}

/** Parse an RFC3339 timestamp with a timezone, returning epoch milliseconds. */
export function timestamp(value: unknown): number {
  if (typeof value === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i.exec(value.trim());
    if (m) {
      // Date.parse only reliably accepts millisecond precision; ProtoJSON may carry nanoseconds.
      const fraction = m[2] ? m[2].slice(0, 4).padEnd(4, '0') : '';
      const result = Date.parse(m[1].replace(' ', 'T') + fraction + m[3].toUpperCase());
      if (!Number.isNaN(result)) return result;
    }
  }
  throw new FlightyError('Expected an RFC3339 timestamp with a timezone.');
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64Encode(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
}

export class Snapshot {
  refreshLimited = false;
  constructor(
    public accountId: string,
    public records: Record<string, Json[]>,
    public pages: number,
    public fetchedAt: string,
    public storedAt: number = Date.now(),
    public unknownFields = false,
  ) {}

  items(kind: string, includeDeleted = false): Json[] {
    return (this.records[kind] ?? []).filter((item) => includeDeleted || !item.deleted);
  }

  owned(kind: string, includeDeleted = false): Json[] {
    return this.items(kind, includeDeleted).filter((item) => item.userId === this.accountId);
  }

  clone(): Snapshot {
    const copy = new Snapshot(this.accountId, structuredClone(this.records), this.pages, this.fetchedAt, this.storedAt, this.unknownFields);
    copy.refreshLimited = this.refreshLimited;
    return copy;
  }
}

// Module scope survives across requests within one Worker isolate. Only token
// fingerprints, never raw credentials, are used as keys.
const CACHE = new Map<string, Snapshot>();
const IN_FLIGHT = new Map<string, Promise<Snapshot>>();

export interface RequestOptions {
  path?: Record<string, string>;
  params?: Record<string, string> | [string, string][];
  payload?: unknown;
  headers?: Record<string, string>;
}

/** A per-request API client. No global bearer credential is retained. */
export class FlightyClient {
  settings: Settings;

  constructor(settings?: Settings) {
    this.settings = settings ?? loadSettings();
  }

  async invalidate(token: string): Promise<void> {
    CACHE.delete(await sha256(token));
  }

  requireWrites(): void {
    if (!this.settings.allowWrites) {
      throw new WritesDisabled('Writes are disabled. Set FLIGHTY_ALLOW_WRITES=true to enable mutations.');
    }
  }

  private headers(token: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + validateToken(token),
      Accept: 'application/x-protobuf',
      'Content-Type': 'application/x-protobuf',
      'User-Agent': this.settings.userAgent,
      'X-Flighty-Locale': this.settings.locale,
    };
    if (this.settings.buildToken) headers['X-Flighty-Build-Token'] = this.settings.buildToken;
    if (this.settings.deviceId) headers.Device = this.settings.deviceId;
    return headers;
  }

  async request(operation: string, token: string, opts: RequestOptions = {}): Promise<Json> {
    const endpoint = ENDPOINTS[operation];
    if (!endpoint) throw new FlightyError('Unknown Flighty operation.');
    const { payload, params, headers } = opts;
    if (!endpoint.read_only) this.requireWrites();
    if (operation === 'delete_account' && !this.settings.allowAccountDeletion) {
      throw new WritesDisabled('Account deletion is disabled separately from ordinary writes.');
    }
    if (endpoint.read_only && endpoint.request === null && payload != null) {
      throw new FlightyError('This download operation must not contain a request body.');
    }
    const parts = opts.path ?? {};
    const expected = new Set(pathKeys(endpoint.path));
    const supplied = Object.keys(parts);
    if (supplied.length !== expected.size || supplied.some((k) => !expected.has(k))) {
      throw new FlightyError('Incorrect path parameters for operation.');
    }
    for (const [key, value] of Object.entries(parts)) {
      if (typeof value !== 'string') throw new FlightyError('Incorrect path parameters for operation.');
      if (['flight_id', 'airport_id', 'user_id'].includes(key)) uuidText(value);
      else if (['share_id', 'invite_id'].includes(key) && !/^[A-Za-z0-9._~-]{1,512}$/.test(value)) {
        throw new FlightyError('Invalid sharing/invitation identifier.');
      } else if (key === 'direction' && value !== 'DEPARTURE' && value !== 'ARRIVAL') {
        throw new FlightyError('Direction must be DEPARTURE or ARRIVAL.');
      } else if (key === 'code' && (!value || value.length > 200 || /[\r\n\0/\\?#]/.test(value))) {
        throw new FlightyError('Invalid promotion code.');
      }
    }
    const route = endpoint.path.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(parts[key]));
    if (headers && Object.keys(headers).some((h) => h !== 'If-None-Match' && h !== 'X-Sync-Priority')) {
      throw new FlightyError('Unsupported request header override.');
    }
    const requestHeaders = { ...this.headers(token), ...headers };
    if (operation === 'poll_flight') requestHeaders['X-Sync-Priority'] ??= '0';
    let body: Uint8Array | string | undefined;
    if (endpoint.request) {
      if (payload == null) throw new FlightyError(`${operation} requires a payload matching ${endpoint.request}.`);
      body = proto.encode(endpoint.request, payload);
    } else if (endpoint.json_body) {
      if (payload == null) throw new FlightyError('This operation requires a JSON body.');
      body = JSON.stringify(payload);
      requestHeaders['Content-Type'] = 'application/json';
      requestHeaders.Accept = 'application/json';
    } else if (payload != null) {
      throw new FlightyError('Unexpected body for operation.');
    }
    const url = new URL(API_BASE + route);
    if (params) url.search = new URLSearchParams(params).toString();

    let status: number;
    let data: Uint8Array;
    let contentType: string;
    let etag: string | null;
    try {
      const response = await fetch(url, {
        method: endpoint.method,
        headers: requestHeaders,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.settings.timeout * 1000),
      });
      status = response.status;
      if (status === 304) {
        await response.body?.cancel();
        return { not_modified: true, status };
      }
      if (status < 200 || status >= 300) {
        await response.body?.cancel();
        const retry = response.headers.get('retry-after') ?? '';
        const suffix = /^\d+$/.test(retry) ? ` Retry after ${retry} seconds.` : '';
        if (status === 429) throw new FlightyError('Flighty API rate limit reached.' + suffix);
        if (status === 401 || status === 403) {
          throw new FlightyError(`Flighty API rejected authentication/access (${status}). Check account and app build tokens.`);
        }
        throw new FlightyError(`Flighty API returned HTTP ${status} for ${operation}; request was not retried.`);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > this.settings.maxResponseBytes) {
            await reader.cancel();
            throw new FlightyError('Flighty response exceeded the configured size limit.');
          }
          chunks.push(value);
        }
      }
      data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
      etag = response.headers.get('etag');
    } catch (error) {
      if (error instanceof FlightyError) throw error;
      throw new FlightyError('Flighty API network/TLS request failed; it was not retried.');
    }
    if (!endpoint.read_only) await this.invalidate(token);
    const meta: Json = { status, operation, schema_version: '4.11.1', rate_limits: 'undocumented' };
    if (etag) meta.etag = etag;
    if (endpoint.binary_response) {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(contentType)) {
        throw new FlightyError('Avatar endpoint returned an unexpected content type.');
      }
      return { mime_type: contentType, base64: base64Encode(data), meta };
    }
    if (!data.length) return { data: {}, meta };
    if (endpoint.json_body) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data));
      } catch {
        throw new FlightyError('Flighty returned invalid JSON.');
      }
      return { data: proto.redact(parsed), meta };
    }
    if (endpoint.response) {
      if (!['application/x-protobuf', 'application/protobuf', 'application/octet-stream'].includes(contentType)) {
        throw new FlightyError('Flighty returned an unexpected response content type.');
      }
      const message = proto.parse(endpoint.response, data);
      meta.unknown_fields_present = proto.unknownFieldsPresent(message);
      const decoded = proto.asDict(message);
      if (operation === 'search_flights' && 'error' in decoded) {
        throw new FlightyError('Flighty API search rate limit reached.');
      }
      return { data: proto.redact(decoded), meta };
    }
    // The app ignores bodies on several acknowledgment endpoints; do likewise.
    return { data: {}, meta };
  }

  async snapshot(token: string, opts: { refresh?: boolean; freshForWrite?: boolean } = {}): Promise<Snapshot> {
    const { refresh = false, freshForWrite = false } = opts;
    if (freshForWrite) this.requireWrites();
    token = validateToken(token);
    const fingerprint = await sha256(token);

    const cachedResult = (): Snapshot | null => {
      const cached = CACHE.get(fingerprint);
      if (!cached || freshForWrite) return null;
      const age = Math.max(0, (Date.now() - cached.storedAt) / 1000);
      const limited = age <= MIN_SYNC_INTERVAL;
      if (limited || (!refresh && age < this.settings.cacheTtl)) {
        CACHE.delete(fingerprint);
        CACHE.set(fingerprint, cached);
        const result = cached.clone();
        result.refreshLimited = refresh && limited;
        return result;
      }
      return null;
    };

    const hit = cachedResult();
    if (hit) return hit;
    const pending = IN_FLIGHT.get(fingerprint);
    if (pending) {
      await pending.catch(() => undefined);
      const after = cachedResult();
      if (after) return after;
    }
    const download = this.download(token);
    IN_FLIGHT.set(fingerprint, download);
    try {
      const snapshot = await download;
      CACHE.delete(fingerprint);
      CACHE.set(fingerprint, snapshot);
      while (CACHE.size > this.settings.maxCacheAccounts) {
        CACHE.delete(CACHE.keys().next().value!);
      }
      return snapshot.clone();
    } finally {
      if (IN_FLIGHT.get(fingerprint) === download) IN_FLIGHT.delete(fingerprint);
    }
  }

  private async download(token: string): Promise<Snapshot> {
    const accountId = tokenSubject(token);
    const records: Record<string, Map<string, Json>> = {};
    let cursor: string | null = null;
    const seen = new Set<string>();
    let unknown = false;
    for (let page = 1; page <= this.settings.maxPages; page++) {
      let query: [string, string][] | undefined;
      if (cursor) {
        if (seen.has(cursor) || cursor.length > 16384) {
          throw new FlightyError('Flighty pagination loop or oversized cursor; incomplete download was not cached.');
        }
        seen.add(cursor);
        // Match the app: copy query items; never request a server-supplied host/path.
        const queryString: string = cursor.includes('?') ? cursor.slice(cursor.indexOf('?') + 1).split('#')[0] : '';
        query = [...new URLSearchParams(queryString)];
        if (!query.length) {
          throw new FlightyError('Flighty pagination cursor has no query; incomplete download was not cached.');
        }
      }
      const result = await this.request('sync_account', token, { params: query });
      unknown ||= Boolean(result.meta.unknown_fields_present);
      const payload: Json = result.data;
      for (const wrapper of payload.data ?? []) {
        for (const [kind, item] of Object.entries<any>(wrapper)) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          // ID alone is insufficient: friend records can share the same flight ID.
          let key: string;
          if (item.id) key = JSON.stringify([String(item.userId ?? ''), String(item.id)]);
          else if (item.flightId) key = JSON.stringify([String(item.userId ?? ''), String(item.flightId)]);
          else key = JSON.stringify(sortKeys(item));
          const bucket = (records[kind] ??= new Map());
          const previous = bucket.get(key);
          if (previous?.updated && item.updated && timestamp(previous.updated) > timestamp(item.updated)) continue;
          bucket.set(key, item);
        }
      }
      const pagination: Json = payload.pagination ?? {};
      if (!pagination.moreData) {
        return new Snapshot(
          accountId,
          Object.fromEntries(Object.entries(records).map(([kind, items]) => [kind, [...items.values()]])),
          page,
          utcNow(),
          Date.now(),
          unknown,
        );
      }
      cursor = pagination.nextUrl;
      if (typeof cursor !== 'string' || !cursor) {
        throw new FlightyError('Flighty omitted its next-page cursor; incomplete download was not cached.');
      }
    }
    throw new FlightyError('Flighty pagination exceeded max-pages; incomplete download was not cached.');
  }

  async applyChanges(token: string, changes: Json[], opts: { confirmDestructive?: boolean } = {}): Promise<Json> {
    this.requireWrites();
    if (!Array.isArray(changes) || !changes.length || changes.length > 100) {
      throw new FlightyError('Supply between 1 and 100 sync changes.');
    }
    const owner = tokenSubject(token);
    const definition = proto.SCHEMA.SyncChangeRequestProto;
    const allowed = new Set(definition.kind === 'message' ? definition.fields.filter((f) => f.oneof === 'change').map((f) => f.json_name) : []);
    const prepared: Json[] = structuredClone(changes);
    for (const change of prepared) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) {
        throw new FlightyError('Every sync change needs exactly one supported action; use get_schema.');
      }
      const actions = Object.keys(change).filter((key) => key !== 'timestamp');
      if (actions.length !== 1 || !allowed.has(actions[0])) {
        throw new FlightyError('Every sync change needs exactly one supported action; use get_schema.');
      }
      const action = actions[0];
      const body = change[action];
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new FlightyError('Each action payload must be a JSON object.');
      }
      if (body.ownerUserId && body.ownerUserId !== owner) {
        throw new FlightyError('Changing a different owner\'s data is not supported.');
      }
      for (const key of ['flightId', 'ownerUserId', 'otherUserId', 'airportId', 'connectionId']) {
        if (body[key]) uuidText(body[key]);
      }
      const lowered = action.toLowerCase();
      const destructive = ['delete', 'remove', 'revoke', 'bulk'].some((word) => lowered.includes(word));
      if (destructive && !opts.confirmDestructive) {
        throw new FlightyError('Destructive sync actions require confirm_destructive=true.');
      }
      change.timestamp ??= utcNow();
      timestamp(change.timestamp);
    }
    // Validate the entire batch before one request. Never retry non-idempotent writes.
    proto.encode('SyncRequestProto', { changes: prepared });
    const result = await this.request('apply_changes', token, { payload: { changes: prepared } });
    // A write can return an entire account sync page. Forwarding it can exceed
    // MCP transport limits after the write succeeds, leaving its outcome unclear.
    // Counts describe returned records, not which changes were applied. Callers
    // must read the target back to verify; never retry the write automatically.
    const counts: Record<string, number> = {};
    for (const record of result.data?.data ?? []) {
      for (const kind of Object.keys(record)) counts[kind] = (counts[kind] ?? 0) + 1;
    }
    return {
      submitted_changes: prepared.length,
      data: { returned_record_counts: counts, more_data: result.data?.pagination?.moreData ?? false },
      readback_required: true,
      meta: result.meta,
    };
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Json)[k])]));
  }
  return value;
}

/** Test hook: drop all cached snapshots in this isolate. */
export function clearCache(): void {
  CACHE.clear();
  IN_FLIGHT.clear();
}
