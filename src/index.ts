import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

import { validateToken } from './client.js';
import { VERSION, secretEnv } from './config.js';
import { setEnv, type Env } from './env.js';
import { FlightyError } from './errors.js';
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

function timingSafeEqual(a: string, b: string) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, X-Flighty-Token' };
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    setEnv(env);
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (url.pathname === '/health') return Response.json({ status: 'ok', service: 'flighty-mcp', version: `${VERSION}-workers` });
    if (url.pathname !== '/mcp') return new Response('Not found', { status: 404 });
    const auth = request.headers.get('authorization') || '';
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!env.MCP_TOKEN || !timingSafeEqual(tok, env.MCP_TOKEN)) return Response.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
    if (request.method !== 'POST') return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }, { status: 405, headers: cors });
    const server = createServer(tokenResolver(request));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(request);
    const h = new Headers(res.headers); for (const [k, v] of Object.entries(cors)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  },
};
