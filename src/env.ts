export interface Env {
  MCP_TOKEN: string;
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
  [k: string]: unknown;
}
let _env: Env | null = null;
export function setEnv(e: Env) { _env = e; }
export function getEnv(): Env { if (!_env) throw new Error('env not set'); return _env; }
