# API guide

Supported endpoints, request formats and operational limitations.

- [Every ordinary HTTP endpoint and its tool](endpoints.md)
- [All 43 sync actions and their field tags](sync-actions.md)
- [`schema.json`](../src/flighty_mcp/data/schema.json): full 281-definition inventory.

## Transport

Origin: `https://api.flightyapp.com`. HTTPS verification is enabled. No arbitrary
API-base override or redirect following. Per-request headers:

```text
Authorization: Bearer <account credential>
Accept: application/x-protobuf
Content-Type: application/x-protobuf
Accept-Encoding: gzip
User-Agent: Flighty 4.11.1 (4818) com.flightyapp.flighty
X-Flighty-Locale: en_US
Device: <existing registered device ID, when configured>
```

JSON-specific operations switch Content-Type/Accept to `application/json`.
No device identity is generated automatically. HTTP errors report status/operation, not response bodies, credentials or sync cursors.
No automatic retries are performed. Server quotas are undocumented. Search quota responses and HTTP 429 are surfaced
without retries.

The account token is a bearer JWT issued by `flighty-api`. The JWT subject is
used only to select account-owned records *after* an authenticated API read.
Local claim decoding is not signature verification and is not an authorization
boundary. Cache separation uses the entire credential's fingerprint.

## Read-only account sync

`sync_account` / cached listing tools send `POST /v1/sync/full` **without a
body**, matching the app's no-outgoing-changes branch. They do not send an empty
replacement account or a list of desired flights. No `changes` field is sent.

`SyncResponseProto` contains `data[]` and `pagination { nextUrl, moreData }`.
Only query parameters from `nextUrl` are copied onto the fixed sync path, as
the app does. All pages must complete before caching. Read refreshes within 60 seconds reuse
the last complete snapshot. Cycles, missing cursors,
page limits, response limits or schema failures abort without caching partial data.

The stream includes reference catalogs, other accessible users, updates and
pre-existing deletion markers. Flight identity is **(userId, flightId)**, not
flightId alone. Listing tools select this account's records, prefer newer updates
and exclude deletion markers by default. Receiving a deletion marker never
causes this client to send a deletion. `get_account_records` exposes all supported
categories, redacting credentials. Its flight categories also restrict ownership.

## Payloads and discovery

Call `get_schema` to inspect a complete definition. Pass ProtoJSON objects to
tools; the client serializes binary protobuf. The upstream protobuf endpoints
are **not** assumed to accept JSON.

- Dates for flight search: `YYYY-MM-DD`.
- Timestamps: RFC3339 with timezone, e.g. `2099-01-02T20:00:00Z`.
- Enums: supported names, e.g. `BUSINESS`; numeric values are also ProtoJSON.
- Binary fields: base64 strings.
- Oneof: set exactly one member, never both alternatives.
- `null` follows protobuf JSON parsing, not a documented server patch contract.
- Unknown request fields are rejected. Do not guess a missing field spelling.

Generic endpoint tools accept `payload`, `path` and (only where documented)
`query`. Account linking and calendar import also require
`confirm_destructive=true`, since they can merge identities or delete imported
flights. For example, synthetic values:

```json
{
  "tool": "get_airport_status",
  "arguments": {
    "path": {"airport_id": "20000000-0000-4000-8000-000000000001"}
  }
}
```

```json
{
  "tool": "request_export",
  "arguments": {"payload": {"email": "test@example.invalid"}}
}
```

An export request sends email; it is classified as mutating and is not part of
live read tests. `import_calendar` accepts the `source` query variant observed in
the app: `initialSync`, `periodicSync`, `calendarChanges` or `silentPush`.
Use `get_schema('CalendarImportRequestProto')` for the body.

JSON endpoint bodies:

| Tool | Body |
| --- | --- |
| `submit_attribution` | `{ "token": "<ASA attribution token>", "service": "ASA" }` |
| `mark_year_in_review_viewed` | `{ "year": "2099" }`; year is a string |
| `create_share_link` | `{ "items": ["https://live.flighty.app/<share-id>"] }` |

`subscribe_flight` sends a bodyless POST with `is_passenger=true/false`.
`subscribe_shared_flights` can include `source=SHARED_WITH_YOU` and the
`is_passenger` query where applicable. It is mutating even though it has no body.

## Sync edits

Every change has a timestamp and one action:

```json
{
  "changes": [
    {
      "timestamp": "2099-01-01T00:00:00Z",
      "userFlightNoteUploadChangeAction": {
        "flightId": "10000000-0000-4000-8000-000000000001",
        "note": "Synthetic example"
      }
    }
  ]
}
```

`apply_changes` accepts the **array** above, generates omitted timestamps, validates
the entire batch, and only then submits one protobuf request. Maximum 100 actions.
The delete/remove/revoke/bulk actions require `confirm_destructive=true`.
An explicit `ownerUserId` must match the current account. The tool never performs
automatic retries. A failed or interrupted response does not prove no mutation
occurred: inspect current state before retrying a write.

`delete_flight` requires the exact flight UUID as confirmation; `manual=true`
selects the manual-flight action. For own-account deletes, `ownerUserId` is
omitted and the bearer-authenticated account supplies the implicit owner. A
successful acknowledgment still requires readback to verify removal.
`delete_account` is a distinct DELETE route
protected by a separate environment switch and an exact account-ID confirmation.

`update_ticket` reads current ticket data before merging supplied fields. It
preserves the other editable values: `pnr`, `seatNumber`, `seatPosition`,
`cabinClass` and `flightReason`. It cannot preserve server-owned timestamps:
`created`, `updated` and `deleted` exist in `RemoteTicket`, but not in the ticket
edit request. Live testing observed `created` reset during an ordinary seat edit.
Do not attempt to restore it with unknown fields or an older action timestamp.
Concurrent phone edits and undocumented backend behavior can still affect values.
Generic/manual actions should be treated as complete replacements unless
supervised testing establishes otherwise.
Manual gate/runway Original/Actual fields are timestamps; `departureGate` and
`arrivalGate` are the text gate identifiers.

## Account linking and TripIt

`POST /v1/user/link` uses the approving phone/account's bearer in Authorization
and the incoming approval token in protobuf field 1. The app routes
`flighty://login/approve?data=<approval-token>` into this operation. The initiating
token's issuance, alias/merge semantics and revocation behavior are unverified.
Do not use this route as a credential-export or token-rotation mechanism.

`GET /v1/external/tripit?token=<account-token>&onComplete=flighty://tripIt` is a
browser authorization flow. Use the app to start it. This server documents it
without generating a credential-bearing URL in an MCP result or following its
redirects. Ordinary HTTPS API tools cannot forward your bearer to another host.

## Websocket

`wss://websockets.flightyapp.com/ws` uses binary protobuf:

```text
FlightyWebsocketsClientMessage { registerSession { tokens: [<bearer>] } }
FlightyWebsocketsServerMessage { requestSync {} }
```

`wait_for_sync` waits once (maximum 30 seconds) and invalidates the local cache on
requestSync. It does not write account data or subscribe to flights. Its protocol
is mocked in the automated suite; it has not been used to validate mutations.

## Confidence and limitations

- The runtime preserves unknown response fields in memory but does not expose them
  as decoded JSON. `unknown_fields_present` / cache metadata reports that condition.
  Unknown/new fields require an updated schema; a successful parse is not proof
  every field is supported.
- ProtoJSON may omit scalar defaults, such as false booleans. Summaries apply
  defaults where appropriate. 64-bit integers follow ProtoJSON string conventions.
- Endpoints not validated against the live service may behave differently.
  The server may reject well-formed but semantically invalid requests.
- `register_anonymous_user` is a developer route, not login to an existing account.
  Returned authentication fields are redacted and do not replace the server's
  current credential. Use the app's own CloudKit export for an existing account.
- Telemetry is not submitted automatically, and devices are not registered automatically.
- Core flight-management mutations have passed supervised live tests. Social
  features, account deletion and additional account/integration operations have
  not been live-tested; see [validation status](testing.md#live-validation-status).

Implementation references: [protobuf ProtoJSON](https://protobuf.dev/programming-guides/json/),
[protobuf wire encoding](https://protobuf.dev/programming-guides/encoding/), and
the [official Python MCP SDK](https://github.com/modelcontextprotocol/python-sdk).
