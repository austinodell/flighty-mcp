from __future__ import annotations

import pytest
import respx

from flighty_mcp import proto
from flighty_mcp.client import FlightyClient
from flighty_mcp.errors import FlightyError
from flighty_mcp.service import FlightyService, local_time

from .conftest import (
    FLIGHT,
    OTHER,
    OWNER,
    SECOND_FLIGHT,
    SYNC,
    TOKEN,
    flight_record,
    mock_sync,
    sync_body,
)


async def test_listing_excludes_other_owners_and_deleted_but_keeps_archived(
    client: FlightyClient,
) -> None:
    mock_sync(
        sync_body(
            [
                flight_record(OTHER),
                flight_record(archived=True),
                flight_record(flight_id=SECOND_FLIGHT, deleted="2000-01-01T00:00:00Z"),
            ]
        )
    )
    result = await FlightyService(client).list_flights(TOKEN)
    assert result["total"] == 1
    row = result["flights"][0]
    assert row["owner_user_id"] == OWNER
    assert row["archived"] is True
    assert row["flight_number"] == "ZZ 123"
    assert row["origin"]["iata"] == "AAA"
    assert row["destination"]["iata"] == "BBB"
    assert row["departure_local"] == "2099-01-02T12:00:00-08:00"


async def test_local_date_and_airport_filters(client: FlightyClient) -> None:
    mock_sync()
    service = FlightyService(client)
    assert (
        await service.list_flights(
            TOKEN,
            when="upcoming",
            mine_only=True,
            origin="aaa",
            destination="Example Destination",
            start_date="2099-01-02",
            end_date="2099-01-02",
        )
    )["total"] == 1
    assert (await service.list_flights(TOKEN, when="past"))["total"] == 0
    assert (await service.list_flights(TOKEN, archived=True))["total"] == 0
    assert (await service.list_flights(TOKEN, origin="no-match"))["total"] == 0
    assert (await service.list_flights(TOKEN, end_date="2000-01-01"))["total"] == 0


async def test_missing_is_mine_defaults_false(client: FlightyClient) -> None:
    mock_sync(sync_body([flight_record(isMine=False)]))
    assert (await FlightyService(client).list_flights(TOKEN, mine_only=True))["total"] == 0


async def test_local_pagination_and_full_details(client: FlightyClient) -> None:
    mock_sync(sync_body([flight_record(), flight_record(flight_id=SECOND_FLIGHT)]))
    service = FlightyService(client)
    first = await service.list_flights(TOKEN, limit=1, details=True)
    second = await service.list_flights(TOKEN, limit=1, offset=1)
    assert first["total"] == 2 and first["next_offset"] == 1
    assert "record" in first["flights"][0]
    assert second["next_offset"] is None
    assert first["flights"][0]["id"] != second["flights"][0]["id"]
    assert len(respx.calls) == 1


@pytest.mark.parametrize(
    "kwargs",
    [
        {"limit": 0},
        {"limit": 201},
        {"offset": -1},
        {"when": "bogus"},
        {"start_date": "yesterday"},
        {"start_date": "2099-01-02", "end_date": "2099-01-01"},
    ],
)
async def test_invalid_filters_never_make_request(client: FlightyClient, kwargs: dict) -> None:
    with pytest.raises(FlightyError):
        await FlightyService(client).list_flights(TOKEN, **kwargs)
    assert not respx.calls


async def test_catalog_search_resolves_codes_and_empty_query(client: FlightyClient) -> None:
    mock_sync()
    service = FlightyService(client)
    assert (await service.search_catalog(TOKEN, "remoteAirport", "aAa"))["results"][0][
        "iata"
    ] == "AAA"
    assert (await service.search_catalog(TOKEN, "remoteAirline", "Example Air"))["total"] == 1
    assert (await service.search_catalog(TOKEN, "remoteAirport", ""))["total"] == 2


async def test_account_records_redacted_and_bounded(client: FlightyClient) -> None:
    mock_sync()
    service = FlightyService(client)
    result = await service.account_records(TOKEN, "remoteUser")
    assert result["records"][0]["token"] == "[REDACTED]"
    with pytest.raises(FlightyError):
        await service.account_records(TOKEN, "not-a-record")


async def test_update_ticket_preserves_editable_fields_not_server_metadata(
    writer: FlightyClient,
) -> None:
    body = proto.decode("SyncResponseProto", sync_body())
    body["data"].append(
        {
            "remoteTicket": {
                "flightId": FLIGHT,
                "userId": OWNER,
                "pnr": "FAKEPNR",
                "seatNumber": "1A",
                "seatPosition": "WINDOW",
                "cabinClass": "BUSINESS",
                "flightReason": "REASON_BUSINESS",
                "created": "2000-01-01T00:00:00Z",
                "updated": "2000-01-02T00:00:00Z",
            }
        }
    )
    responses = [proto.encode("SyncResponseProto", body), b""]
    route = respx.post(SYNC).mock(
        side_effect=[
            __import__("httpx").Response(
                200, content=data, headers={"Content-Type": "application/x-protobuf"}
            )
            for data in responses
        ]
    )
    await FlightyService(writer).update_ticket(TOKEN, FLIGHT, {"seatNumber": "2B"})
    assert route.call_count == 2
    assert route.calls[0].request.content == b""
    change = proto.decode("SyncRequestProto", route.calls[1].request.content)["changes"][0][
        "ticketInfoAction"
    ]
    assert change == {
        "flightId": FLIGHT,
        "pnr": "FAKEPNR",
        "seatNumber": "2B",
        "seatPosition": "WINDOW",
        "cabinClass": "BUSINESS",
        "flightReason": "REASON_BUSINESS",
    }


@pytest.mark.parametrize(
    "fields",
    [
        {},
        {"unknown": "bad"},
        {"seatNumber": None},
        {"created": "2000-01-01T00:00:00Z"},
        {"updated": "2000-01-02T00:00:00Z"},
    ],
)
async def test_invalid_ticket_patch_fails_before_read(writer: FlightyClient, fields: dict) -> None:
    with pytest.raises(FlightyError):
        await FlightyService(writer).update_ticket(TOKEN, FLIGHT, fields)
    assert not respx.calls


def test_unknown_timezone_falls_back_without_losing_timestamp() -> None:
    assert local_time("2000-01-01T00:00:00Z", "Not/AZone") == "2000-01-01T00:00:00+00:00"
    assert local_time(None, "UTC") is None
