# ✈️ flighty-mcp (Cloudflare Workers)

An unofficial MCP server for [Flighty](https://flighty.com), ported to TypeScript and
hosted as a remote MCP server on Cloudflare Workers. Forked from
[swiftyspiffy/flighty-mcp](https://github.com/swiftyspiffy/flighty-mcp) (Python).
Clients call `POST /mcp` with `Authorization: Bearer <MCP_TOKEN>`.

Let your AI assistant read your flights, search schedules and airports, and manage
your tracked flights. Flighty does not need to be open; the Worker talks directly to
Flighty's API with your account token.

Not affiliated with or endorsed by Flighty. **Adding and editing are enabled by
default. Account deletion is disabled.**

## Deploying on Cloudflare

### Workers Builds

Connect this repo in Cloudflare Workers Builds with:

- Root directory: `/`
- Build command: `npm install`
- Deploy command: `npx wrangler deploy`

No KV or other bindings are needed. The account snapshot cache lives in memory per
Worker isolate. Do not commit secrets.

Set the Worker secrets in the dashboard, or locally with:

```bash
npx wrangler secret put MCP_TOKEN        # bearer token your MCP clients send
npx wrangler secret put FLIGHTY_TOKEN    # your Flighty account token (see below)
```

`MCP_TOKEN` gates access to the Worker. `FLIGHTY_TOKEN` is the Flighty credential the
Worker uses upstream. A client may instead send its own Flighty token in an
`X-Flighty-Token` header, which overrides the secret. That lets one deployment serve
several accounts.

### GitHub Actions

`.github/workflows/deploy.yml` type-checks, tests and deploys on every push to `main`
and when run manually (`workflow_dispatch`). Add these repository secrets
(Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN`: API token with permission to deploy Workers
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID

`MCP_TOKEN` and `FLIGHTY_TOKEN` stay Worker secrets. They are not GitHub Actions secrets.

## Connecting a client

| Setting | Value |
| --- | --- |
| Server URL | `https://flighty-mcp.<your-subdomain>.workers.dev/mcp` |
| Header | `Authorization: Bearer <MCP_TOKEN>` |
| Optional header | `X-Flighty-Token: <Flighty token>` |

Claude Code:

```bash
claude mcp add --transport http --scope user flighty https://flighty-mcp.<your-subdomain>.workers.dev/mcp --header "Authorization: Bearer <MCP_TOKEN>"
```

Then ask **"Use Flighty to show my upcoming flights."**

## 🔑 Get your Flighty token

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

## ⚙️ Configuration

Non-secret settings are Worker vars (`vars` in `wrangler.jsonc` or the dashboard).

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_TOKEN` (secret) | none | Bearer token required on `/mcp` |
| `FLIGHTY_TOKEN` (secret) | none | Flighty account credential; `X-Flighty-Token` overrides it |
| `FLIGHTY_BUILD_TOKEN` (secret) | none | Optional app build token header |
| `FLIGHTY_ALLOW_WRITES` | `true` | Set to `false` for read-only access |
| `FLIGHTY_ALLOW_ACCOUNT_DELETION` | `false` | Separate account-deletion permission |
| `FLIGHTY_CACHE_TTL` | `120` | Account cache lifetime in seconds |
| `FLIGHTY_TIMEOUT` | `60` | Upstream request timeout in seconds |
| `FLIGHTY_MAX_PAGES` | `100` | Maximum pages per account sync |
| `FLIGHTY_LOCALE` / `FLIGHTY_USER_AGENT` / `FLIGHTY_DEVICE_ID` | app defaults | Request header overrides |

`GET /health` returns service status without authentication.

## 📡 API and tools

| Tools | What they do |
| --- | --- |
| `list_flights`, `sync_account`, `get_account_records` | Read flights, tickets, notes and account settings |
| `search_flights`, `get_flight`, `poll_flight` | Search schedules and check flight details |
| `search_airports`, `search_airlines`, `search_aircraft_types`, `search_metro_areas` | Resolve names and codes |
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

## ⚠️ Upstream concerns

- **Unofficial API:** New Flighty versions may require verifying protobuf
  definitions, routes, headers and the token-export shortcut.
- **Writes are experimental:** Live validation is limited. Supervise changes and
  verify saved values. Account deletion has a separate switch.
- **Updates may replace fields:** Omitted fields can clear existing values in generic
  sync actions. `update_ticket` merges current data before changing supplied fields.
- **Ticket timestamps:** Flighty may reset `created` when a ticket is edited.
  `update_ticket` preserves other editable ticket values, not server-owned timestamps.
- **Request pacing:** Repeated account refreshes reuse a complete snapshot for
  60 seconds. Server quotas are undocumented; writes are never retried automatically.
- **Credentials can change:** Account tokens may be rejected or revoked.
  An observed JWT without an expiry claim does not guarantee permanent access.

## 🛠️ Local development

```bash
npm install
npm run typecheck
npm test
echo "MCP_TOKEN=local-test" > .dev.vars   # add FLIGHTY_TOKEN=... to hit the real API
npm run dev
```

Tests use synthetic fixtures with a mocked `fetch` and never reach Flighty.
Protobuf messages are built at runtime from `src/data/schema.json` with
[`@bufbuild/protobuf`](https://github.com/bufbuild/protobuf-es).

## 📝 License

[MIT](LICENSE) · Copyright (c) 2026 Cole Jelinek.

Inspired by [obeone/parcelapp-mcp](https://github.com/obeone/parcelapp-mcp).
