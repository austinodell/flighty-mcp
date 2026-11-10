export interface SyncQueueMessage {
  op: 'start' | 'continue';
  force?: boolean;
}

export interface Env {
  FLIGHTY_TOKEN?: string;
  FLIGHTY_BUILD_TOKEN?: string;
  FLIGHTY_DEVICE_ID?: string;
  FLIGHTY_LOCALE?: string;
  FLIGHTY_USER_AGENT?: string;
  FLIGHTY_ALLOW_WRITES?: string;
  FLIGHTY_ALLOW_ACCOUNT_DELETION?: string;
  FLIGHTY_TIMEOUT?: string;
  FLIGHTY_CACHE_TTL?: string;
  FLIGHTY_MAX_PAGES?: string;
  FLIGHTY_SYNC_PAGES_PER_RUN?: string;
  DB?: D1Database;
  SYNC_QUEUE?: Queue<SyncQueueMessage>;
  /** Access team domain, e.g. aodell.cloudflareaccess.com (wrangler var). */
  ACCESS_TEAM_DOMAIN?: string;
  /** Audience (AUD) tag of the self-hosted Access application (Worker secret). */
  ACCESS_AUD?: string;
  [k: string]: unknown;
}
let _env: Env | null = null;
export function setEnv(e: Env) { _env = e; }
export function getEnv(): Env { if (!_env) throw new Error('env not set'); return _env; }
