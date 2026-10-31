/** Cloudflare Access OIDC login for the MCP OAuth authorization server. */
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';

import type { Env } from './env.js';
import { ownerAllowed } from './owner.js';
import {
  addApprovedClient,
  createOAuthState,
  fetchUpstreamAuthToken,
  generateCSRFProtection,
  getUpstreamAuthorizeUrl,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from './workers-oauth-utils.js';

type AccessEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

interface IdClaims {
  email?: string;
  name?: string;
  sub?: string;
  exp?: number;
}

export async function handleAccessRequest(request: Request, env: AccessEnv, _ctx: ExecutionContext): Promise<Response> {
  const { pathname, searchParams } = new URL(request.url);

  if (request.method === 'GET' && pathname === '/authorize') {
    const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    if (!oauthReqInfo.clientId) return new Response('Invalid request', { status: 400 });
    if (await isClientApproved(request, oauthReqInfo.clientId, env.COOKIE_ENCRYPTION_KEY ?? '')) {
      const { stateToken, codeChallenge } = await createOAuthState(oauthReqInfo, env.OAUTH_KV!, env.COOKIE_ENCRYPTION_KEY ?? '');
      return redirectToAccess(request, env, stateToken, codeChallenge);
    }
    const { token: csrfToken, setCookie } = generateCSRFProtection();
    return renderApprovalDialog(request, {
      client: await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId),
      csrfToken,
      server: {
        description: 'Flighty MCP reads the cached Flighty account for its owner.',
        logo: 'https://flighty.com/favicon.ico',
        name: 'Flighty MCP',
      },
      setCookie,
      state: { oauthReqInfo },
    });
  }

  if (request.method === 'POST' && pathname === '/authorize') {
    try {
      const formData = await request.formData();
      const csrfResult = validateCSRFToken(formData, request);
      const encodedState = formData.get('state');
      if (!encodedState || typeof encodedState !== 'string') return new Response('Missing state in form data', { status: 400 });
      let state: { oauthReqInfo?: AuthRequest };
      try {
        state = JSON.parse(atob(encodedState));
      } catch {
        return new Response('Invalid state data', { status: 400 });
      }
      if (!state.oauthReqInfo?.clientId) return new Response('Invalid request', { status: 400 });
      const approvedClientCookie = await addApprovedClient(request, state.oauthReqInfo.clientId, env.COOKIE_ENCRYPTION_KEY ?? '');
      const { stateToken, codeChallenge } = await createOAuthState(state.oauthReqInfo, env.OAUTH_KV!, env.COOKIE_ENCRYPTION_KEY ?? '');
      const redirectHeaders = new Headers();
      redirectHeaders.append('Set-Cookie', approvedClientCookie);
      redirectHeaders.append('Set-Cookie', csrfResult.clearCookie);
      return redirectToAccess(request, env, stateToken, codeChallenge, redirectHeaders);
    } catch (error) {
      console.error(JSON.stringify({ message: 'authorize_failed', error: error instanceof Error ? error.name : 'error' }));
      if (error instanceof OAuthError) return error.toResponse();
      return new Response('Internal server error', { status: 500 });
    }
  }

  if (request.method === 'GET' && pathname === '/callback') {
    let oauthReqInfo: AuthRequest;
    let codeVerifier: string;
    try {
      const result = await validateOAuthState(request, env.OAUTH_KV!, env.COOKIE_ENCRYPTION_KEY ?? '');
      oauthReqInfo = result.oauthReqInfo;
      codeVerifier = result.codeVerifier;
    } catch (error) {
      if (error instanceof OAuthError) return error.toResponse();
      return new Response('Internal server error', { status: 500 });
    }
    if (!oauthReqInfo.clientId) return new Response('Invalid OAuth request data', { status: 400 });

    const [accessToken, idToken, errResponse] = await fetchUpstreamAuthToken({
      client_id: env.ACCESS_CLIENT_ID ?? '',
      client_secret: env.ACCESS_CLIENT_SECRET ?? '',
      code: searchParams.get('code') ?? undefined,
      redirect_uri: new URL('/callback', request.url).href,
      upstream_url: env.ACCESS_TOKEN_URL ?? '',
      code_verifier: codeVerifier,
    });
    if (errResponse || !accessToken || !idToken) {
      console.error(JSON.stringify({ message: 'access_token_exchange_failed', status: errResponse?.status ?? 0 }));
      return new Response('Access login failed.', { status: 502 });
    }

    let claims: IdClaims;
    try {
      claims = await verifyAccessIdToken(env, idToken);
    } catch (error) {
      console.error(JSON.stringify({ message: 'access_id_token_rejected', error: error instanceof Error ? error.message : 'error' }));
      return new Response('Access login failed.', { status: 401 });
    }
    const email = typeof claims.email === 'string' ? claims.email : '';
    const sub = typeof claims.sub === 'string' ? claims.sub : '';
    if (!sub || !ownerAllowed(email, env.ACCESS_ALLOWED_EMAIL)) {
      console.error(JSON.stringify({ message: 'owner_check_failed' }));
      return new Response('This Flighty MCP server is limited to its owner.', { status: 403 });
    }

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      metadata: { label: typeof claims.name === 'string' && claims.name ? claims.name : email },
      props: { email, name: typeof claims.name === 'string' ? claims.name : email, sub },
      request: oauthReqInfo,
      scope: oauthReqInfo.scope,
      userId: encodeURIComponent(sub),
    });
    return Response.redirect(redirectTo, 302);
  }

  return new Response('Not Found', { status: 404 });
}

function redirectToAccess(request: Request, env: AccessEnv, stateToken: string, codeChallenge: string, extraHeaders = new Headers()): Response {
  const headers = new Headers(extraHeaders);
  headers.set('location', getUpstreamAuthorizeUrl({
    client_id: env.ACCESS_CLIENT_ID ?? '',
    code_challenge: codeChallenge,
    redirect_uri: new URL('/callback', request.url).href,
    scope: 'openid email profile',
    state: stateToken,
    upstream_url: env.ACCESS_AUTHORIZATION_URL ?? '',
  }));
  return new Response(null, { headers, status: 302 });
}

async function fetchAccessPublicKey(env: Env, kid: string): Promise<CryptoKey> {
  if (!env.ACCESS_JWKS_URL) throw new Error('access jwks url not provided');
  const response = await fetch(env.ACCESS_JWKS_URL);
  if (!response.ok) throw new Error('access jwks fetch failed');
  const keys = await response.json() as { keys?: (JsonWebKey & { kid?: string })[] };
  const jwk = keys.keys?.find((key) => key.kid === kid);
  if (!jwk) throw new Error('access signing key not found');
  return crypto.subtle.importKey('jwk', jwk, { hash: 'SHA-256', name: 'RSASSA-PKCS1-v1_5' }, false, ['verify']);
}

function parseJwt(token: string): { data: string; header: { kid?: string }; payload: IdClaims; signature: Uint8Array } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('token must have 3 parts');
  const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0]))) as { kid?: string };
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1]))) as IdClaims;
  return { data: `${parts[0]}.${parts[1]}`, header, payload, signature: base64UrlToBytes(parts[2]) };
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Verify an Access ID token signature and expiry. Email allowlisting happens after this returns. */
export async function verifyAccessIdToken(env: Env, token: string): Promise<IdClaims> {
  const jwt = parseJwt(token);
  if (!jwt.header.kid) throw new Error('missing key id');
  const key = await fetchAccessPublicKey(env, jwt.header.kid);
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    jwt.signature as BufferSource,
    new TextEncoder().encode(jwt.data),
  );
  if (!verified) throw new Error('failed to verify token');
  const now = Math.floor(Date.now() / 1000);
  if (typeof jwt.payload.exp !== 'number' || jwt.payload.exp < now) throw new Error('expired token');
  return jwt.payload;
}
