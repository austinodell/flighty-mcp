import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import OAuthProvider, { type OAuthHelpers } from '@cloudflare/workers-oauth-provider';

import { handleAccessRequest } from './access-handler.js';
import { validateToken } from './client.js';
import { MCP_RESOURCE_ORIGIN, VERSION, secretEnv } from './config.js';
import { setEnv, type Env, type SyncQueueMessage } from './env.js';
import { FlightyError } from './errors.js';
import { ownerAllowed } from './owner.js';
import { handleScheduled, handleSyncMessage } from './schedule.js';
import { createServer } from './server.js';

/** An X-Flighty-Token header wins over the FLIGHTY_TOKEN Worker secret, so one deployment can serve several accounts. */
function tokenResolver(request: Request): () => string {
  return () => {
    const header = request.headers.get('x-flighty-token')?.trim();
    if (header) return validateToken(header);
    const secret = secretEnv('FLIGHTY_TOKEN');
    if (!secret) throw new FlightyError('No Flighty credential. Set the FLIGHTY_TOKEN Worker secret or send an X-Flighty-Token header.');
    return validateToken(secret);
  };
}

const cors: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, X-Flighty-Token',
};

async function handleMcp(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }, { status: 405, headers: cors });
  }
  const server = createServer(tokenResolver(request));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  const res = await transport.handleRequest(request);
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(cors)) headers.set(key, value);
  return new Response(res.body, { status: res.status, headers });
}

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    setEnv(env);
    const email = (ctx.props as { email?: string } | undefined)?.email;
    if (!ownerAllowed(email, env.ACCESS_ALLOWED_EMAIL)) {
      console.error(JSON.stringify({ message: 'owner_check_failed' }));
      return Response.json({ error: 'Forbidden' }, { status: 403, headers: cors });
    }
    return handleMcp(request);
  },
};

const defaultHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    setEnv(env);
    return handleAccessRequest(request, env as Env & { OAUTH_PROVIDER: OAuthHelpers }, ctx);
  },
};

const providers = new Map<string, OAuthProvider<Env>>();

/** Tokens are bound to the origin the client called, so local dev and the custom domain each get a resource URL. */
export function providerFor(origin: string): OAuthProvider<Env> {
  const existing = providers.get(origin);
  if (existing) return existing;
  const provider = new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    scopesSupported: ['openid', 'email', 'profile'],
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'Flighty' },
  });
  providers.set(origin, provider);
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    setEnv(env);
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (url.pathname === '/health') return Response.json({ status: 'ok', service: 'flighty-mcp', version: `${VERSION}-workers` });
    return providerFor(url.origin).fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(env, (bound) => providerFor(MCP_RESOURCE_ORIGIN).purgeExpiredData(bound)));
  },
  async queue(batch: MessageBatch<SyncQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handleSyncMessage(env, message.body);
        message.ack();
      } catch (error) {
        console.error(JSON.stringify({ message: 'sync_message_failed', error: error instanceof Error ? error.message : 'error' }));
        message.retry();
      }
    }
  },
};
