/** Closed endpoint catalog. Callers cannot supply arbitrary URLs or HTTP methods. */

export interface Endpoint {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  read_only: boolean;
  request: string | null;
  response: string | null;
  json_body: boolean;
  binary_response: boolean;
  destructive: boolean;
  notes: string;
}

function ep(method: Endpoint['method'], path: string, readOnly: boolean, extra: Partial<Endpoint> = {}): Endpoint {
  return {
    method, path, read_only: readOnly, request: null, response: null, json_body: false, binary_response: false,
    destructive: false, notes: 'Mutation behavior has not been live-tested.', ...extra,
  };
}

export const ENDPOINTS: Record<string, Endpoint> = {
  search_flights: ep('POST', '/v1/search', true, { request: 'SearchRequestProto', response: 'SearchResponseProto' }),
  get_flight: ep('GET', '/v1/flight/{flight_id}', true, { response: 'GetSharingLinkResponseProto' }),
  subscribe_flight: ep('POST', '/v1/flight/{flight_id}/subscribe', false, { response: 'SubscribeFlightResponseProto' }),
  subscribe_random_flight: ep('POST', '/v1/flight/random/subscribe', false, { response: 'SubscribeFlightResponseProto' }),
  sync_account: ep('POST', '/v1/sync/full', true, {
    response: 'SyncResponseProto',
    notes: 'Body is absent. Copies only query items from server nextUrl. Read-only download path.',
  }),
  apply_changes: ep('POST', '/v1/sync/full', false, { request: 'SyncRequestProto', response: 'SyncResponseProto', destructive: true }),
  poll_flight: ep('POST', '/v1/sync/content/flight/{flight_id}', true, { response: 'SyncResponseProto' }),
  subscribe_shared_flights: ep('POST', '/v1/flight/sharing/{share_id}/subscribe', false, { response: 'SharingSubscribeFlightResponseProto' }),
  register_anonymous_user: ep('POST', '/v1/user', false, { request: 'CreateUserRequestProto', response: 'RemoteUser' }),
  delete_account: ep('DELETE', '/v1/user', false, { destructive: true }),
  register_device: ep('POST', '/v1/device', false, { request: 'CreateDeviceRequestProto', response: 'RemoteDeviceProto' }),
  link_account: ep('POST', '/v1/user/link', false, {
    request: 'UserLinkRequestProto',
    destructive: true,
    notes: 'Approving account authenticates; body token is the incoming approval token. Initiator token issuance/merge semantics remain unverified.',
  }),
  get_avatar: ep('GET', '/v1/user/{user_id}/avatar', true, { binary_response: true }),
  upload_receipt: ep('POST', '/v1/receipt', false, { request: 'ReceiptRequestProto' }),
  submit_attribution: ep('POST', '/v1/user/attribute', false, { json_body: true }),
  mark_year_in_review_viewed: ep('POST', '/v1/user/settings/viewedYearInReview', false, { json_body: true }),
  request_export: ep('POST', '/v1/user/export', false, { request: 'TriggerExportRequestProto' }),
  request_bulk_import: ep('POST', '/v1/user/triggerBulkImport', false, { request: 'TriggerBulkImportRequestProto' }),
  redeem_promo_code: ep('POST', '/v1/user/promocode/{code}/redeem', false, { response: 'RedeemPromoCodeResponseProto' }),
  import_calendar: ep('POST', '/v1/sync/calendar', false, { request: 'CalendarImportRequestProto', destructive: true }),
  lookup_aircraft: ep('POST', '/v1/autocomplete/aircraftTypeFromTail', true, {
    request: 'AutocompleteAircraftTypeRequestProto', response: 'AutocompleteAircraftTypeResponseProto',
  }),
  get_static_assets: ep('GET', '/v1/static_assets', true, { response: 'GetStaticAssetsResponse' }),
  get_radar_layers: ep('GET', '/v1/radar/layers', true, { response: 'GetRadarLayersResponseProto' }),
  get_airport_status: ep('GET', '/v1/airport-status/{airport_id}', true, { response: 'RemoteAirportCardResponseProto' }),
  get_airport_mini_status: ep('GET', '/v1/airport-status/{airport_id}/mini', true, { response: 'RemoteMiniAirportStatus' }),
  get_airports_home: ep('POST', '/v1/airport-status', true, { request: 'AirportsHomeRequestProto', response: 'RemoteAirportsHomeResponseProto' }),
  get_airports_map: ep('POST', '/v1/airport-status/map', true, { request: 'AirportsHomeMapRequestProto', response: 'RemoteAirportsHomeMapResponseProto' }),
  get_airport_board: ep('GET', '/v1/airport-board/{airport_id}/{direction}', true, { response: 'RemoteAirportBoardResponseProto' }),
  create_share_link: ep('POST', '/v1/share', false, { json_body: true }),
  create_friend_invite: ep('POST', '/v1/connected-friends/invite-links', false, {
    request: 'ConnectedFriendsInviteLinkAcceptRequestProto', response: 'ConnectedFriendsInviteLinkResponseProto',
  }),
  get_friend_invite: ep('GET', '/v1/connected-friends/invite-links/{invite_id}', true, { response: 'ConnectedFriendsInviteLinkLookupResponseProto' }),
  accept_friend_invite: ep('POST', '/v1/connected-friends/invite-links/{invite_id}/accept', false, {
    request: 'ConnectedFriendsInviteLinkAcceptRequestProto', response: 'ConnectedFriendsInviteLinkAcceptResponseProto',
  }),
  start_live_activity: ep('POST', '/v1/flight/{flight_id}/liveActivity', false, { request: 'StartLiveActivityRequest' }),
};

export function pathKeys(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

export function catalog() {
  return {
    app_contract: '4.11.1 (4818)',
    operations: ENDPOINTS,
    browser_only: {
      tripit: {
        method: 'GET',
        path: '/v1/external/tripit',
        query: { token: 'account bearer', onComplete: 'flighty://tripIt' },
        notes: 'Use the app to launch this browser authorization flow. Never put bearer-bearing URLs into chat/logs.',
      },
    },
    websocket: {
      url: 'wss://websockets.flightyapp.com/ws',
      client_message: 'FlightyWebsocketsClientMessage',
      server_message: 'FlightyWebsocketsServerMessage',
    },
  };
}
