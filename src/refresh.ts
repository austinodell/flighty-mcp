/** One sync page per step. The published generation changes only after the last page. */
import { FlightyClient, timestamp, tokenSubject, utcNow } from './client.js';
import { FlightyError } from './errors.js';
import { preferRecord, type SyncRecord } from './records.js';
import { AccountStore, viewFromMeta, type CacheView } from './store.js';

const MIN_INTERVAL_MS = 60_000;

export interface SyncJob {
  op: 'start' | 'continue';
  force?: boolean;
}

function permanent(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /pagination|cursor|max-pages/.test(message);
}

function safeMessage(error: unknown): string {
  if (error instanceof FlightyError) return error.message;
  return 'Account sync failed.';
}

function previousIsNewer(previous: string, next: string): boolean {
  return timestamp(previous) > timestamp(next);
}

export async function runSyncJob(opts: {
  client: FlightyClient;
  store: AccountStore;
  token: string;
  op: 'start' | 'continue';
  force?: boolean;
  pages: number;
  now?: number;
}): Promise<CacheView> {
  const now = opts.now ?? Date.now();
  const accountId = tokenSubject(opts.token);
  await opts.store.ensure(accountId, now);
  let meta = await opts.store.read(accountId);
  if (!meta) throw new FlightyError('Account cache could not be created.');

  if (opts.op === 'start' && !opts.force && meta.status === 'ready' && !meta.dirty && meta.stored_at != null && now - meta.stored_at < MIN_INTERVAL_MS) {
    return viewFromMeta(meta, { refresh_limited: true, more: false, continuation: 'complete' }, now);
  }
  if (opts.op === 'continue' && meta.status !== 'refreshing') {
    return viewFromMeta(meta, { more: false, continuation: 'complete' }, now);
  }

  const lockId = await opts.store.acquire(accountId, now);
  if (!lockId) return viewFromMeta(meta, { already_running: true, more: true, continuation: 'in_progress' }, now);

  try {
    meta = await opts.store.read(accountId);
    if (!meta) throw new FlightyError('Account cache could not be created.');
    if (opts.op === 'start' && meta.status !== 'refreshing') {
      await opts.store.beginGeneration(accountId, now);
      meta = await opts.store.read(accountId);
    }
    if (!meta?.staging_generation) throw new FlightyError('Account cache refresh has no staging generation.');

    const seen = new Set(meta.seen_cursors);
    let cursor = meta.cursor;
    let unknown = meta.unknown_fields;
    let pagesDone = meta.pages_done;
    const budget = Math.max(1, opts.pages);

    for (let step = 0; step < budget; step++) {
      const page = await opts.client.fetchSyncPage(opts.token, cursor, seen);
      const existing = await opts.store.updatedFor(accountId, meta.staging_generation, page.records);
      const winners = new Map<string, SyncRecord>();
      for (const record of page.records) {
        const mapKey = `${record.kind}\0${record.recordKey}`;
        const chosen = preferRecord(winners.get(mapKey), record, previousIsNewer);
        const storedUpdated = existing.get(mapKey);
        if (storedUpdated && chosen.updated && previousIsNewer(storedUpdated, chosen.updated)) {
          winners.delete(mapKey);
          continue;
        }
        winners.set(mapKey, chosen);
      }
      const pageRecords = [...winners.values()];
      await opts.store.insertRecords(accountId, meta.staging_generation, pageRecords);
      unknown = unknown || page.unknownFields;
      pagesDone += 1;
      cursor = page.more ? page.nextCursor : null;
      await opts.store.checkpoint(accountId, { pagesDone, cursor, seen: [...seen], unknownFields: unknown, now });
      console.log(JSON.stringify({ message: 'sync_page_stored', account_id: accountId, page: pagesDone, records: pageRecords.length, more: page.more }));
      if (!page.more) {
        const published = await opts.store.publish(accountId, { pages: pagesDone, unknownFields: unknown, fetchedAt: utcNow(), now });
        return viewFromMeta(published, { more: false, continuation: 'complete' }, now);
      }
    }
    const mid = await opts.store.read(accountId);
    if (!mid) throw new FlightyError('Account cache disappeared during refresh.');
    return viewFromMeta(mid, { more: true, continuation: 'in_progress' }, now);
  } catch (error) {
    const message = safeMessage(error);
    console.error(JSON.stringify({ message: 'sync_failed', account_id: accountId, error: message }));
    await opts.store.fail(accountId, message, permanent(error), Date.now());
    throw error instanceof FlightyError ? error : new FlightyError(message);
  } finally {
    await opts.store.release(accountId, lockId);
  }
}
