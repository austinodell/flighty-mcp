# Advanced usage

See the [README](../README.md) for requirements, token setup and installation.

## Token files

After a local installation, you can import the diagnostic attachment without
copying the token by hand:

```bash
flighty-token extract /path/to/CloudKit-Debug-Log.txt --output /absolute/path/to/token
```

Set `FLIGHTY_TOKEN_FILE` to that file's absolute path instead of `FLIGHTY_TOKEN`.
The importer stores the credential locally without printing it. MCP configuration
paths must be absolute; `~` and shell variables may not expand.

## Configuration

Additional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `FLIGHTY_DEVICE_ID` | omitted | Existing registered device ID; no automatic registration |
| `FLIGHTY_LOCALE` | `en_US` | Request locale |
| `FLIGHTY_USER_AGENT` | Flighty app version header | Request client identifier |

CLI flags `--transport`, `--host`, `--port` and `--path` override transport settings.
The API host is fixed to Flighty's HTTPS origin. Redirects are not followed and
tools cannot supply arbitrary destination URLs.

## HTTP credentials

Supply `X-Flighty-Token` or `Authorization: Bearer` on each tool/resource request.
`X-Flighty-Token` takes precedence. HTTP never falls back to an environment account
token. Cache entries use a SHA-256 credential fingerprint so callers remain isolated.

Use `X-Flighty-Token` if a proxy uses `Authorization` for its own authentication.
This server is a credential relay, not an OAuth authorization server. Clients that
require OAuth discovery need a separate authentication gateway. Keep remote
instances behind HTTPS and an access boundary you control.

## Writes

Writes are enabled by default. To use read-only mode:

```bash
export FLIGHTY_ALLOW_WRITES=false
```

Mutation tools check this flag before sending requests. Destructive operations
also require explicit tool confirmation. Account deletion additionally requires
`FLIGHTY_ALLOW_ACCOUNT_DELETION=true` and the exact account ID as confirmation.
Leave that switch off for ordinary use.

`update_ticket` fetches current ticket data and preserves the other editable
booking, seat, cabin and flight-reason values. Flighty controls ticket timestamps
and may reset `created` during edits; no supported ticket-edit field preserves it.
Generic `apply_changes` and manual-flight edits send complete actions: omitted optional
fields can clear existing values. An interrupted write may have succeeded;
inspect current state before retrying. Writes are never retried automatically.

Sync mutation replies return a compact acknowledgment: `submitted_changes`,
`data.returned_record_counts`, `data.more_data`, `readback_required` and HTTP
metadata. Returned-record counts describe the server's response page, not the
number of applied edits. Full sync records and pagination cursors are omitted
to keep MCP replies small. Read the affected notes/tickets/flights back with
the read tools to verify the saved values before attempting another write.

## Request pacing

Read-only account refreshes within 60 seconds reuse the last complete snapshot,
including explicit refresh requests. Results report `cache.refresh_limited`.
Pagination pages are downloaded together. Successful writes and sync notifications
invalidate the snapshot; ticket edits fetch fresh state before merging changes.
Search quota responses and HTTP 429 are reported without automatic retries.
There is no invented requests-per-minute allowance or background polling loop.

## Data and resources

Resources return up to 200 records. Use tool pagination for longer listings.
Tokens, push tokens, invitation secrets, receipts and avatar-upload bytes are
redacted from decoded results. Known avatar downloads return base64 and MIME type.
Account state and tokens are kept in memory, not persisted by the server.

The [API guide](api.md) describes payloads and limitations. See [testing](testing.md)
for offline checks, live-validation coverage and the optional read-only live
check. Authorize and supervise any live write test.
