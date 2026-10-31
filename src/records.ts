/** Plain records extracted from one sync page. Payloads are redacted ProtoJSON, not protobuf messages. */

type Json = Record<string, any>;

export interface SyncRecord {
  kind: string;
  recordKey: string;
  userId: string;
  recordId: string;
  flightId: string;
  deleted: boolean;
  updated: string | null;
  payload: Json;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Json)[k])]));
  }
  return value;
}

export function syncRecordKey(item: Json): string {
  const userId = item.userId == null ? '' : String(item.userId);
  if (item.id != null && item.id !== '') return JSON.stringify([userId, String(item.id)]);
  if (item.flightId != null && item.flightId !== '') return JSON.stringify([userId, String(item.flightId)]);
  return JSON.stringify(sortKeys(item));
}

export function toSyncRecord(kind: string, item: Json): SyncRecord {
  const userId = item.userId == null ? '' : String(item.userId);
  const recordId = item.id == null ? '' : String(item.id);
  const nestedFlight = item.flight && typeof item.flight === 'object' ? String(item.flight.id ?? '') : '';
  const flightId = item.flightId == null || item.flightId === '' ? nestedFlight : String(item.flightId);
  const updated = typeof item.updated === 'string' ? item.updated : null;
  return {
    kind,
    recordKey: syncRecordKey(item),
    userId,
    recordId,
    flightId,
    deleted: Boolean(item.deleted),
    updated,
    payload: item,
  };
}

/** Keep the newer record when one page contains the same identity twice. */
export function preferRecord(previous: SyncRecord | undefined, next: SyncRecord, newer: (prevUpdated: string, nextUpdated: string) => boolean): SyncRecord {
  if (previous?.updated && next.updated && newer(previous.updated, next.updated)) return previous;
  return next;
}

export function extractSyncRecords(body: Json, newer: (prevUpdated: string, nextUpdated: string) => boolean): SyncRecord[] {
  const merged = new Map<string, SyncRecord>();
  for (const wrapper of body.data ?? []) {
    if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) continue;
    for (const [kind, item] of Object.entries(wrapper)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = toSyncRecord(kind, item as Json);
      const mapKey = `${kind}\0${record.recordKey}`;
      merged.set(mapKey, preferRecord(merged.get(mapKey), record, newer));
    }
  }
  return [...merged.values()];
}
