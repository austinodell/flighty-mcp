# flighty-mcp (Cloudflare Workers)

An unofficial MCP server for [Flighty](https://flighty.com), hosted as a remote MCP server on
Cloudflare Workers. Forked from [swiftyspiffy/flighty-mcp](https://github.com/swiftyspiffy/flighty-mcp).

Clients connect to `https://flight-mcp.odell.io/mcp` and sign in with Cloudflare Access.
The Worker does not accept a static `MCP_TOKEN` bearer. `FLIGHTY_TOKEN` is still the upstream
Flighty credential. A client may send `X-Flighty-Token` to use a different Flighty account
than the one in that secret.

Not affiliated with or endorsed by Flighty. **Adding and editing are enabled by
default. Account deletion is disabled.**

## Why the account cache exists

A full Flighty sync is several protobuf pages. Decoding every page with
`@bufbuild/protobuf` while retaining raw bytes, unknown fields, ProtoJSON copies, and a
cloned snapshot exceeds the Workers **128 MB** isolate memory limit (error 1102) even
when CPU time stays well under the 30 second Paid-plan limit.

Reads (`list_flights`, `get_account_records`, catalog search, `sync_account`) are served
from D1. A refresh decodes **one page at a time**, writes the trimmed records, drops the
protobuf message and raw bytes, and checkpoints the cursor. The default account's
remaining pages continue as Queue messages, one page per invocation. The published
generation flips only after the last page, so a crash cannot replace a good snapshot
with a partial one. Cron `0 * * * *` enqueues that refresh every hour.

Tracked flights and friends' flights are stored. `list_flights` with
`mine_only=false` returns them, with `owner_name`, `friend_id`, `shared`, and
`relationship`. `mine_only=true` stays limited to this account's My Flights.
`get_flight` serves a cached flight, including a friend's, before calling
Flighty. `get_account_records` for flight categories stays limited to this account.

## Deploying

GitHub Actions (`.github/workflows/deploy.yml`) type-checks, tests, applies D1
migrations, deploys, then deletes the unused `MCP_TOKEN` secret on every push to
`main`. These resources are already provisioned on account
`d07b110f410fe3016dae9409da71b2ba` and recorded in `wrangler.jsonc`:

| Binding | Name | ID |
| --- | --- | --- |
| `DB` | `flighty-mcp` | `42bfcf77-8ba9-4c1a-b06b-fe443cf62cd1` |
| `OAUTH_KV` | `flighty-mcp-oauth` | `014b53be447d41b293d9b4bf74af63bb` |
| `SYNC_QUEUE` | `flighty-mcp-sync` | `199a638623e4490fabd771415783aa95` (bound by queue name) |

`migrations/0001_account_cache.sql` is already applied remotely and recorded in
`d1_migrations`, so `wrangler d1 migrations apply flighty-mcp --remote` is a no-op
until a later migration is added. Friends' and tracked flights did not need a new
table.

The API token used by Wrangler and `CLOUDFLARE_API_TOKEN` needs permission to deploy
Workers, create a custom hostname on the `odell.io` zone, edit D1, KV, and Queues.
`odell.io` must be on the same Cloudflare account. `CLOUDFLARE_ACCOUNT_ID` is
`d07b110f410fe3016dae9409da71b2ba`.

### 1. D1

Already created. To recreate:

```bash
npx wrangler d1 create flighty-mcp
npx wrangler d1 migrations apply flighty-mcp --remote
```

### 2. OAuth KV

Workers OAuth Provider stores client registrations, grants, and token state in KV.
Namespace `flighty-mcp-oauth` already exists (`014b53be447d41b293d9b4bf74af63bb`).

### 3. Queue

`flighty-mcp-sync` already exists. The Worker produces and consumes it
(`max_concurrency` 1, one message at a time).

### 4. Custom domain

`wrangler.jsonc` contains:

```jsonc
{ "pattern": "flight-mcp.odell.io", "custom_domain": true }
```

Deploy creates the DNS record and certificate on the `odell.io` zone. The canonical
MCP URL is `https://flight-mcp.odell.io/mcp`.

### 5. Cloudflare Access for SaaS (OIDC)

This follows [Secure MCP servers with Access](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)
and the [remote-mcp-cf-access](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-cf-access)
example. The Worker is an OAuth 2.1 authorization server for MCP clients and an OAuth
client of Access.

1. Create a [Zero Trust organization](https://developers.cloudflare.com/cloudflare-one/setup/) if you do not have one.
2. Configure an identity provider (One-time PIN or your IdP) that the owner can use.
3. In the [Cloudflare dashboard](https://dash.cloudflare.com/), go to **Zero Trust → Access controls → Applications → Create new application**.
4. Choose **SaaS**, enter a name such as `Flighty MCP`, select the custom name that appears, and choose **OIDC**.
5. Add the application.
6. Under **Scopes**, include **openid**, **email**, and **profile**. The Worker requires the email claim.
7. Under **Redirect URLs**, add `https://flight-mcp.odell.io/callback`. For local `wrangler dev`, also add `http://localhost:8787/callback`.
8. Copy these values. They are Access for SaaS endpoints, not your upstream IdP's endpoints.

   | Worker secret | Access for SaaS field |
   | --- | --- |
   | `ACCESS_CLIENT_ID` | Client ID |
   | `ACCESS_CLIENT_SECRET` | Client secret |
   | `ACCESS_TOKEN_URL` | Token endpoint |
   | `ACCESS_AUTHORIZATION_URL` | Authorization endpoint |
   | `ACCESS_JWKS_URL` | Key endpoint |

   The endpoints look like `https://<team>.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client id>/{token,authorization,jwks}`.
9. Optional: enable refresh tokens so the owner is not sent through Access on every token refresh.
10. **Access policy (only the owner).** Applications deny by default. Add one Allow policy:
    - Action: **Allow**
    - Include: **Emails** → the owner's email address
    - Do not add an everyone / emails-ending-in rule
11. Select the identity provider the owner uses. Save.

Set the same email as the Worker secret `ACCESS_ALLOWED_EMAIL`. The Access policy is
what users hit at login. The Worker checks the ID token email again and refuses to
issue an MCP token, or to serve `/mcp`, for anyone else. If the secret is unset, every
login is refused.

### 6. Worker secrets

`FLIGHTY_TOKEN`, `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `ACCESS_TOKEN_URL`,
`ACCESS_AUTHORIZATION_URL`, `ACCESS_JWKS_URL`, `COOKIE_ENCRYPTION_KEY`, and
`ACCESS_ALLOWED_EMAIL` are already set on the Worker. To rotate one:

```bash
npx wrangler secret put FLIGHTY_TOKEN
npx wrangler secret put ACCESS_CLIENT_ID
npx wrangler secret put ACCESS_CLIENT_SECRET
npx wrangler secret put ACCESS_TOKEN_URL
npx wrangler secret put ACCESS_AUTHORIZATION_URL
npx wrangler secret put ACCESS_JWKS_URL
openssl rand -hex 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY
npx wrangler secret put ACCESS_ALLOWED_EMAIL
```

`COOKIE_ENCRYPTION_KEY` is the hex from `openssl rand -hex 32`. It encrypts the OAuth
consent and upstream-state cookies. Do not commit any of these values.

`MCP_TOKEN` is no longer read. The deploy workflow runs `wrangler secret delete MCP_TOKEN` after a successful deploy and ignores a secret that is already gone. To remove it yourself:

```bash
npx wrangler secret delete MCP_TOKEN
```

Optional secret: `FLIGHTY_BUILD_TOKEN`.

Non-secret vars stay in `wrangler.jsonc`:

- `FLIGHTY_ALLOW_WRITES=true`
- `FLIGHTY_ALLOW_ACCOUNT_DELETION=false`

### 7. Deploy

```bash
npx wrangler deploy
```

Or merge to `main` and let GitHub Actions apply migrations and deploy. The action
needs repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
`FLIGHTY_TOKEN` and the Access secrets stay Worker secrets. They are not GitHub
Actions secrets.

`GET /health` does not require a login.

## Connecting a client

| Setting | Value |
| --- | --- |
| Server URL | `https://flight-mcp.odell.io/mcp` |
| Auth | OAuth 2.1. The client discovers `/.well-known/oauth-authorization-server`, may dynamically register at `/register`, and sends the user through Access. |
| Optional header | `X-Flighty-Token: <Flighty token>` overrides `FLIGHTY_TOKEN` for that request |

Claude Code:

```bash
claude mcp add --transport http --scope user flighty https://flight-mcp.odell.io/mcp
```

The first connection opens a browser. Approve the MCP client, then sign in with
Access as the owner. There is no `Authorization: Bearer <MCP_TOKEN>` header.

Then ask **"Use Flighty to show my upcoming flights."** If the cache is empty, ask it
to call `refresh_cache` or wait for the hourly sync.

## Get your Flighty token

On your iPhone:

1. Open a flight and scroll down its details page to **Report Data Issue**.
2. **Press and hold that standalone button for about one second.** Use the button
   on the page, not the item inside the flight’s menu.
3. Choose **Apple Mail** if prompted. Find **CloudKit-Debug-Log.txt** in the draft.
4. Save the attachment to your computer. If you email it to yourself, replace the
   support recipient with your own address first.
5. Open the file in a text editor and find **`Current token:`**. Copy just the long
   value after the colon, without spaces or quotation marks.

[![Six-step illustrated guide to getting your Flighty token](docs/images/flighty-token-guide.png)](docs/images/flighty-token-guide.png)

**Keep this token and the attachment private. They give access to your account.**
The regular Settings → Help email usually includes only app logs. These steps
were verified with Flighty 4.11.1; the shortcut may change.

## Configuration

Non-secret settings are Worker vars (`vars` in `wrangler.jsonc` or the dashboard).

| Variable | Default | Purpose |
| --- | --- | --- |
| `FLIGHTY_TOKEN` (secret) | none | Flighty account credential. `X-Flighty-Token` overrides it |
| `ACCESS_CLIENT_ID` (secret) | none | Access for SaaS client id |
| `ACCESS_CLIENT_SECRET` (secret) | none | Access for SaaS client secret |
| `ACCESS_TOKEN_URL` (secret) | none | Access token endpoint |
| `ACCESS_AUTHORIZATION_URL` (secret) | none | Access authorization endpoint |
| `ACCESS_JWKS_URL` (secret) | none | Access key endpoint |
| `COOKIE_ENCRYPTION_KEY` (secret) | none | OAuth cookie encryption key (`openssl rand -hex 32`) |
| `ACCESS_ALLOWED_EMAIL` (secret) | none | Only this email may complete login or call `/mcp` |
| `FLIGHTY_ALLOW_WRITES` | `true` | Set to `false` for read-only access |
| `FLIGHTY_ALLOW_ACCOUNT_DELETION` | `false` | Separate account-deletion permission |
| `FLIGHTY_CACHE_TTL` | `120` | In-memory snapshot lifetime, used only when D1 is not bound |
| `FLIGHTY_SYNC_PAGES_PER_RUN` | `1` | Sync pages decoded in one Worker invocation before the queue continues |
| `FLIGHTY_TIMEOUT` | `60` | Upstream request timeout in seconds |
| `FLIGHTY_MAX_PAGES` | `100` | Maximum pages per account sync |
| `FLIGHTY_LOCALE` / `FLIGHTY_USER_AGENT` / `FLIGHTY_DEVICE_ID` | app defaults | Request header overrides |
| `FLIGHTY_BUILD_TOKEN` (secret) | none | Optional app build token header |

Observability logs and traces are enabled in `wrangler.jsonc` at a sampling rate of 1,
which fits a single-user Worker. Lower `observability.traces.head_sampling_rate` if
trace volume grows.

## API and tools

| Tools | What they do |
| --- | --- |
| `list_flights`, `sync_account`, `get_account_records`, `refresh_cache` | Read the cached account. Responses include `cache_age_seconds` and `last_refreshed`. `refresh_cache` and `refresh: true` start a sync |
| `search_flights`, `get_flight`, `poll_flight` | Search schedules and check flight details |
| `search_airports`, `search_airlines`, `search_aircraft_types`, `search_metro_areas` | Resolve names and codes from the cache |
| `get_schema`, `get_endpoint_catalog` | Explore supported routes and protobuf fields |
| `subscribe_flight`, `delete_flight`, `set_flight_archived`, `set_flight_mine` | Track, remove and organize flights |
| `update_ticket`, `set_flight_note`, `upsert_manual_flight` | Edit bookings, notes and manual flights |
| `apply_changes` | Advanced access to all 43 sync actions |
| `wait_for_sync` | Wait for an update notification |

Additional tools cover airport boards, radar, imports/exports, sharing and friends.
Browse the [full endpoint list](docs/endpoints.md), [sync actions](docs/sync-actions.md)
and [API contracts](docs/api.md).

Resources: `flighty://flights/{when}`, `flighty://account/{kind}` and
`flighty://schema/{name}`. Account resources return up to 200 records; tools support pagination.

## Upstream concerns

- **Unofficial API:** New Flighty versions may require verifying protobuf
  definitions, routes, headers and the token-export shortcut.
- **Writes are experimental:** Live validation is limited. Supervise changes and
  verify saved values. Account deletion has a separate switch.
- **Updates may replace fields:** Omitted fields can clear existing values in generic
  sync actions. `update_ticket` merges current data before changing supplied fields.
- **Ticket timestamps:** Flighty may reset `created` when a ticket is edited.
  `update_ticket` preserves other editable ticket values, not server-owned timestamps.
- **Request pacing:** Manual refreshes reuse a complete snapshot for 60 seconds.
  The hourly cron refreshes the default `FLIGHTY_TOKEN` account. Writes enqueue a
  refresh for that account. Server quotas are undocumented; writes are never retried
  automatically.
- **Credentials can change:** Account tokens may be rejected or revoked.
  An observed JWT without an expiry claim does not guarantee permanent access.

## Local development

```bash
npm install
npm run typecheck
npm test
```

Copy `.dev.vars.example` to `.dev.vars` and fill in secrets to hit Access and Flighty.
Tests use synthetic fixtures with a mocked `fetch` and never reach Flighty.
Protobuf messages are built at runtime from `src/data/schema.json` with
[`@bufbuild/protobuf`](https://github.com/bufbuild/protobuf-es).

```bash
npm run dev
```

`wrangler dev` uses a local D1 and KV. Apply the migration locally with
`npx wrangler d1 migrations apply flighty-mcp --local` if the dev session does not
create the tables itself. OAuth resource metadata uses the dev origin, so the Access
redirect URL must include `http://localhost:8787/callback`.

## License

[MIT](LICENSE) · Copyright (c) 2026 Cole Jelinek.

Inspired by [obeone/parcelapp-mcp](https://github.com/obeone/parcelapp-mcp).
