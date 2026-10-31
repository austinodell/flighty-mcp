/** D1 persistence for trimmed account snapshots. One published generation is visible to reads. */
import type { SyncRecord } from './records.js';
import { FlightyError } from './errors.js';

type Json = Record<string, any>;

const ROW_LIMIT = 1_500_000;
const WRITE_BATCH = 20;
const READ_PAGE = 100;
const DELETE_BATCH = 200;
const LOCK_MS = 3 * 60 * 1000;

export interface CacheMeta {
  account_id: string;
  status: 'empty' | 'refreshing' | 'ready' | 'error';
  generation: number;
  staging_generation: number | null;
  fetched_at: string | null;
  stored_at: number | null;
  pages: number;
  pages_done: number;
  unknown_fields: boolean;
  cursor: string | null;
  seen_cursors: string[];
  counts: Record<string, number>;
  last_error: string | null;
  dirty: boolean;
  updated_at: number;
}

export interface CacheView {
  account_id: string;
  status: CacheMeta['status'];
  counts: Record<string, number>;
  last_refreshed: string | null;
  cache_age_seconds: number | null;
  pages: number;
  pages_done: number;
  refresh_limited: boolean;
  already_running: boolean;
  schema_unknown_fields_present: boolean;
  continuation: 'complete' | 'queued' | 'in_progress';
  last_error: string | null;
  more: boolean;
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<{ meta?: { changes?: number } }>;
  all<T>(): Promise<{ results?: T[] }>;
  first<T>(): Promise<T | null>;
}

export interface AccountDatabase {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown>;
}

function num(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function parseSeen(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseCounts(value: unknown): Record<string, number> {
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([key, count]) => [key, num(count)]));
  } catch {
    return {};
  }
}

export function cacheAgeSeconds(storedAt: number | null, now = Date.now()): number | null {
  if (storedAt == null) return null;
  return Math.max(0, Math.round((now - storedAt) / 1000));
}

export function viewFromMeta(meta: CacheMeta, extra: Partial<CacheView> = {}, now = Date.now()): CacheView {
  return {
    account_id: meta.account_id,
    status: meta.generation > 0 && meta.status === 'refreshing' ? 'refreshing' : meta.status,
    counts: meta.counts,
    last_refreshed: meta.fetched_at,
    cache_age_seconds: cacheAgeSeconds(meta.stored_at, now),
    pages: meta.pages,
    pages_done: meta.pages_done,
    refresh_limited: false,
    already_running: false,
    schema_unknown_fields_present: meta.unknown_fields,
    continuation: meta.status === 'refreshing' ? 'in_progress' : 'complete',
    last_error: meta.last_error,
    more: meta.status === 'refreshing',
    ...extra,
  };
}

export class AccountStore {
  constructor(private db: AccountDatabase) {}

  async ensure(accountId: string, now = Date.now()): Promise<void> {
    await this.db.prepare(
      `INSERT INTO account_cache (account_id, status, updated_at) VALUES (?, 'empty', ?)
       ON CONFLICT(account_id) DO NOTHING`,
    ).bind(accountId, now).run();
  }

  async read(accountId: string): Promise<CacheMeta | null> {
    const row = await this.db.prepare(`SELECT * FROM account_cache WHERE account_id = ?`).bind(accountId).first<Record<string, unknown>>();
    if (!row) return null;
    const status = String(row.status ?? 'empty');
    return {
      account_id: accountId,
      status: status === 'refreshing' || status === 'ready' || status === 'error' ? status : 'empty',
      generation: num(row.generation),
      staging_generation: row.staging_generation == null ? null : num(row.staging_generation),
      fetched_at: typeof row.fetched_at === 'string' ? row.fetched_at : null,
      stored_at: row.stored_at == null ? null : num(row.stored_at),
      pages: num(row.pages),
      pages_done: num(row.pages_done),
      unknown_fields: num(row.unknown_fields) === 1,
      cursor: typeof row.cursor === 'string' ? row.cursor : null,
      seen_cursors: parseSeen(row.seen_cursors),
      counts: parseCounts(row.counts_json),
      last_error: typeof row.last_error === 'string' ? row.last_error : null,
      dirty: num(row.dirty) === 1,
      updated_at: num(row.updated_at),
    };
  }

  /** Atomically take the refresh lock. A lock older than LOCK_MS can be stolen after a crashed invocation. */
  async acquire(accountId: string, now = Date.now()): Promise<string | null> {
    const lockId = crypto.randomUUID();
    const result = await this.db.prepare(
      `UPDATE account_cache SET lock_id = ?, updated_at = ?
       WHERE account_id = ? AND (lock_id IS NULL OR updated_at < ?)`,
    ).bind(lockId, now, accountId, now - LOCK_MS).run();
    if (num(result.meta?.changes) < 1) return null;
    const row = await this.db.prepare(`SELECT lock_id FROM account_cache WHERE account_id = ?`).bind(accountId).first<{ lock_id?: string }>();
    return row?.lock_id === lockId ? lockId : null;
  }

  async release(accountId: string, lockId: string): Promise<void> {
    await this.db.prepare(`UPDATE account_cache SET lock_id = NULL WHERE account_id = ? AND lock_id = ?`).bind(accountId, lockId).run();
  }

  async markDirty(accountId: string, now = Date.now()): Promise<void> {
    await this.ensure(accountId, now);
    await this.db.prepare(`UPDATE account_cache SET dirty = 1, updated_at = ? WHERE account_id = ?`).bind(now, accountId).run();
  }

  async beginGeneration(accountId: string, now = Date.now()): Promise<number> {
    const meta = await this.read(accountId);
    const staging = (meta?.generation ?? 0) + 1;
    await this.deleteGeneration(accountId, staging);
    await this.db.prepare(
      `UPDATE account_cache
       SET status = 'refreshing', staging_generation = ?, pages_done = 0, cursor = NULL,
           seen_cursors = '[]', unknown_fields = 0, last_error = NULL, dirty = 0, updated_at = ?
       WHERE account_id = ?`,
    ).bind(staging, now, accountId).run();
    return staging;
  }

  async updatedFor(accountId: string, generation: number, records: SyncRecord[]): Promise<Map<string, string | null>> {
    const found = new Map<string, string | null>();
    const byKind = new Map<string, SyncRecord[]>();
    for (const record of records) {
      const list = byKind.get(record.kind) ?? [];
      list.push(record);
      byKind.set(record.kind, list);
    }
    for (const [kind, group] of byKind) {
      for (let i = 0; i < group.length; i += 80) {
        const slice = group.slice(i, i + 80);
        const marks = slice.map(() => '?').join(',');
        const rows = await this.db.prepare(
          `SELECT record_key, updated FROM account_records
           WHERE account_id = ? AND generation = ? AND kind = ? AND record_key IN (${marks})`,
        ).bind(accountId, generation, kind, ...slice.map((record) => record.recordKey)).all<{ record_key: string; updated: string | null }>();
        for (const row of rows.results ?? []) found.set(`${kind}\0${row.record_key}`, row.updated ?? null);
      }
    }
    return found;
  }

  async insertRecords(accountId: string, generation: number, records: SyncRecord[]): Promise<void> {
    for (const record of records) {
      const payload = JSON.stringify(record.payload);
      if (payload.length > ROW_LIMIT) {
        throw new FlightyError('A sync record exceeds the D1 row limit; the page was not published.');
      }
    }
    for (let i = 0; i < records.length; i += WRITE_BATCH) {
      const slice = records.slice(i, i + WRITE_BATCH);
      const statements = slice.map((record) => this.db.prepare(
        `INSERT INTO account_records (
           account_id, generation, kind, record_key, user_id, record_id, flight_id, deleted, updated, payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, generation, kind, record_key) DO UPDATE SET
           user_id = excluded.user_id,
           record_id = excluded.record_id,
           flight_id = excluded.flight_id,
           deleted = excluded.deleted,
           updated = excluded.updated,
           payload = excluded.payload`,
      ).bind(
        accountId,
        generation,
        record.kind,
        record.recordKey,
        record.userId,
        record.recordId,
        record.flightId,
        record.deleted ? 1 : 0,
        record.updated,
        JSON.stringify(record.payload),
      ));
      await this.db.batch(statements);
    }
  }

  async checkpoint(accountId: string, fields: {
    pagesDone: number;
    cursor: string | null;
    seen: string[];
    unknownFields: boolean;
    now: number;
  }): Promise<void> {
    await this.db.prepare(
      `UPDATE account_cache
       SET pages_done = ?, cursor = ?, seen_cursors = ?, unknown_fields = ?, updated_at = ?, last_error = NULL
       WHERE account_id = ?`,
    ).bind(
      fields.pagesDone,
      fields.cursor,
      JSON.stringify(fields.seen),
      fields.unknownFields ? 1 : 0,
      fields.now,
      accountId,
    ).run();
  }

  async countsFor(accountId: string, generation: number): Promise<Record<string, number>> {
    const rows = await this.db.prepare(
      `SELECT kind, COUNT(*) AS n FROM account_records WHERE account_id = ? AND generation = ? GROUP BY kind`,
    ).bind(accountId, generation).all<{ kind: string; n: number }>();
    return Object.fromEntries((rows.results ?? []).map((row) => [row.kind, num(row.n)]));
  }

  async publish(accountId: string, fields: { pages: number; unknownFields: boolean; fetchedAt: string; now: number }): Promise<CacheMeta> {
    const current = await this.read(accountId);
    const staging = current?.staging_generation;
    if (staging == null) throw new FlightyError('Account cache refresh has no staging generation.');
    const counts = await this.countsFor(accountId, staging);
    await this.db.prepare(
      `UPDATE account_cache
       SET status = 'ready', generation = ?, staging_generation = NULL, fetched_at = ?, stored_at = ?,
           pages = ?, pages_done = ?, unknown_fields = ?, cursor = NULL, seen_cursors = '[]',
           counts_json = ?, last_error = NULL, dirty = 0, updated_at = ?
       WHERE account_id = ?`,
    ).bind(
      staging,
      fields.fetchedAt,
      fields.now,
      fields.pages,
      fields.pages,
      fields.unknownFields ? 1 : 0,
      JSON.stringify(counts),
      fields.now,
      accountId,
    ).run();
    await this.deleteOtherGenerations(accountId, staging);
    const published = await this.read(accountId);
    if (!published) throw new FlightyError('Account cache disappeared during publish.');
    return published;
  }

  async fail(accountId: string, message: string, permanent: boolean, now = Date.now()): Promise<void> {
    const meta = await this.read(accountId);
    if (permanent) {
      if (meta?.staging_generation != null) await this.deleteGeneration(accountId, meta.staging_generation);
      const status = meta && meta.generation > 0 ? 'ready' : 'error';
      await this.db.prepare(
        `UPDATE account_cache
         SET status = ?, staging_generation = NULL, pages_done = 0, cursor = NULL, seen_cursors = '[]',
             last_error = ?, updated_at = ?
         WHERE account_id = ?`,
      ).bind(status, message, now, accountId).run();
      return;
    }
    await this.db.prepare(`UPDATE account_cache SET last_error = ?, updated_at = ? WHERE account_id = ?`).bind(message, now, accountId).run();
  }

  async payloads(accountId: string, generation: number, kind: string, opts: { userId?: string; flightId?: string } = {}): Promise<Json[]> {
    const out: Json[] = [];
    let offset = 0;
    for (;;) {
      const where = ['account_id = ?', 'generation = ?', 'kind = ?', 'deleted = 0'];
      const binds: unknown[] = [accountId, generation, kind];
      if (opts.userId != null) {
        where.push('user_id = ?');
        binds.push(opts.userId);
      }
      if (opts.flightId != null) {
        where.push('flight_id = ?');
        binds.push(opts.flightId);
      }
      const rows = await this.db.prepare(
        `SELECT payload FROM account_records WHERE ${where.join(' AND ')} ORDER BY record_key LIMIT ? OFFSET ?`,
      ).bind(...binds, READ_PAGE, offset).all<{ payload: string }>();
      const batch = rows.results ?? [];
      for (const row of batch) out.push(JSON.parse(row.payload));
      if (batch.length < READ_PAGE) return out;
      offset += READ_PAGE;
    }
  }

  async pagePayloads(accountId: string, generation: number, kind: string, offset: number, limit: number, userId?: string): Promise<{ total: number; records: Json[] }> {
    const where = ['account_id = ?', 'generation = ?', 'kind = ?', 'deleted = 0'];
    const binds: unknown[] = [accountId, generation, kind];
    if (userId != null) {
      where.push('user_id = ?');
      binds.push(userId);
    }
    const filter = where.join(' AND ');
    const count = await this.db.prepare(`SELECT COUNT(*) AS n FROM account_records WHERE ${filter}`).bind(...binds).first<{ n: number }>();
    const rows = await this.db.prepare(
      `SELECT payload FROM account_records WHERE ${filter} ORDER BY record_key LIMIT ? OFFSET ?`,
    ).bind(...binds, limit, offset).all<{ payload: string }>();
    return { total: num(count?.n), records: (rows.results ?? []).map((row) => JSON.parse(row.payload)) };
  }

  async payloadsByIds(accountId: string, generation: number, kind: string, ids: string[]): Promise<Json[]> {
    const out: Json[] = [];
    const unique = [...new Set(ids.filter(Boolean))];
    for (let i = 0; i < unique.length; i += 80) {
      const slice = unique.slice(i, i + 80);
      const marks = slice.map(() => '?').join(',');
      const rows = await this.db.prepare(
        `SELECT payload FROM account_records
         WHERE account_id = ? AND generation = ? AND kind = ? AND deleted = 0 AND record_id IN (${marks})`,
      ).bind(accountId, generation, kind, ...slice).all<{ payload: string }>();
      for (const row of rows.results ?? []) out.push(JSON.parse(row.payload));
    }
    return out;
  }

  private async deleteGeneration(accountId: string, generation: number): Promise<void> {
    for (;;) {
      const result = await this.db.prepare(
        `DELETE FROM account_records WHERE rowid IN (
           SELECT rowid FROM account_records WHERE account_id = ? AND generation = ? LIMIT ?
         )`,
      ).bind(accountId, generation, DELETE_BATCH).run();
      if (num(result.meta?.changes) < 1) return;
    }
  }

  private async deleteOtherGenerations(accountId: string, keep: number): Promise<void> {
    for (;;) {
      const result = await this.db.prepare(
        `DELETE FROM account_records WHERE rowid IN (
           SELECT rowid FROM account_records WHERE account_id = ? AND generation != ? LIMIT ?
         )`,
      ).bind(accountId, keep, DELETE_BATCH).run();
      if (num(result.meta?.changes) < 1) return;
    }
  }
}
