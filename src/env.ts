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
  MCP_RESOURCE?: string;
  DB?: D1Database;
  OAUTH_KV?: KVNamespace;
  SYNC_QUEUE?: Queue<SyncQueueMessage>;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  ACCESS_TOKEN_URL?: string;
  ACCESS_AUTHORIZATION_URL?: string;
  ACCESS_JWKS_URL?: string;
  COOKIE_ENCRYPTION_KEY?: string;
  ACCESS_ALLOWED_EMAIL?: string;
  [k: string]: unknown;
}
let _env: Env | null = null;
export function setEnv(e: Env) { _env = e; }
export function getEnv(): Env { if (!_env) throw new Error('env not set'); return _env; }
