/** Configuration without embedded app or account credentials. Values come from Worker vars and secrets. */
import { getEnv } from './env.js';
import { FlightyError } from './errors.js';

export const API_BASE = 'https://api.flightyapp.com';
// Workers open outbound websockets through fetch() with an https:// URL.
export const WEBSOCKET_URL = 'https://websockets.flightyapp.com/ws';
export const MIN_SYNC_INTERVAL = 60;
export const USER_AGENT = 'Flighty 4.11.1 (4818) com.flightyapp.flighty';
export const VERSION = '0.3.0';
export const MCP_RESOURCE_ORIGIN = 'https://flight-mcp.odell.io';

export interface Settings {
  buildToken: string;
  deviceId: string;
  locale: string;
  userAgent: string;
  allowWrites: boolean;
  allowAccountDeletion: boolean;
  timeout: number;
  cacheTtl: number;
  maxPages: number;
  maxResponseBytes: number;
  maxCacheAccounts: number;
  syncPagesPerRun: number;
}

function readEnv(name: string): string {
  const value = getEnv()[name];
  return typeof value === 'string' ? value.trim() : '';
}

/** Read a single-line secret from a Worker secret. */
export function secretEnv(name: string): string {
  const value = readEnv(name);
  if (/[\r\n\0]/.test(value)) throw new FlightyError(`${name} must contain one credential, without line breaks.`);
  return value;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = (readEnv(name) || String(fallback)).toLowerCase();
  if (!['true', 'false', '1', '0'].includes(value)) throw new FlightyError(`${name} must be true or false.`);
  return value === 'true' || value === '1';
}

function envNumber(name: string, fallback: number, integer = false): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) throw new FlightyError('Invalid numeric FLIGHTY configuration.');
  return value;
}

export function loadSettings(): Settings {
  const settings: Settings = {
    buildToken: secretEnv('FLIGHTY_BUILD_TOKEN'),
    deviceId: readEnv('FLIGHTY_DEVICE_ID'),
    locale: readEnv('FLIGHTY_LOCALE') || 'en_US',
    userAgent: readEnv('FLIGHTY_USER_AGENT') || USER_AGENT,
    allowWrites: envBool('FLIGHTY_ALLOW_WRITES', true),
    allowAccountDeletion: envBool('FLIGHTY_ALLOW_ACCOUNT_DELETION', false),
    timeout: envNumber('FLIGHTY_TIMEOUT', 60),
    cacheTtl: envNumber('FLIGHTY_CACHE_TTL', 120),
    maxPages: envNumber('FLIGHTY_MAX_PAGES', 100, true),
    maxResponseBytes: 32 * 1024 * 1024,
    maxCacheAccounts: 8,
    syncPagesPerRun: envNumber('FLIGHTY_SYNC_PAGES_PER_RUN', 1, true),
  };
  if (settings.timeout <= 0 || settings.cacheTtl < 0 || settings.maxPages < 1 || settings.maxPages > 1000 || settings.syncPagesPerRun < 1) {
    throw new FlightyError('Timeout/max-pages must be positive and cache TTL nonnegative.');
  }
  for (const value of [settings.deviceId, settings.locale, settings.userAgent]) {
    if (/[\r\n\0]/.test(value)) throw new FlightyError('Invalid Flighty request header configuration.');
  }
  return settings;
}
