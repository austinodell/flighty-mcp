import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { verifyAccessRequest } from './access-auth.js';
import { validateToken } from './client.js';
import { secretEnv } from './config.js';
import { appVersion } from './version.js';
import { setEnv, type Env, type SyncQueueMessage } from './env.js';
import { FlightyError } from './errors.js';
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    setEnv(env);
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ status: 'ok', service: 'flighty-mcp', version: appVersion(env) });
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    // Cloudflare Access authenticates the caller before the Worker runs. Re-check its signed JWT here.
    const access = await verifyAccessRequest(request, env);
    if (!access.ok) {
      return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: access.reason }, id: null }, { status: access.status, headers: cors });
    }
    return handleMcp(request);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(env));
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
