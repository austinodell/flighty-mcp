"""Synthetic fixtures only. Unmocked upstream HTTP and websocket calls fail."""

from __future__ import annotations

import base64
import json
import os
from typing import Any

import pytest
import respx

from flighty_mcp.client import FlightyClient
from flighty_mcp.config import Settings
from flighty_mcp.proto import encode

OWNER = "00000000-0000-4000-8000-000000000001"
OTHER = "00000000-0000-4000-8000-000000000002"
FLIGHT = "10000000-0000-4000-8000-000000000001"
SECOND_FLIGHT = "10000000-0000-4000-8000-000000000002"
AIRPORT_A = "20000000-0000-4000-8000-000000000001"
AIRPORT_B = "20000000-0000-4000-8000-000000000002"
AIRLINE = "30000000-0000-4000-8000-000000000001"
SYNC = "https://api.flightyapp.com/v1/sync/full"


def fake_token(subject: str = OWNER, salt: str = "test-only") -> str:
    def part(value: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return (
        part({"alg": "HS512", "typ": "JWT"})
        + "."
        + part({"sub": subject, "iss": "flighty-api", "iat": 0})
        + "."
        + salt
    )


TOKEN = fake_token()
OTHER_TOKEN = fake_token(OTHER)


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch: pytest.MonkeyPatch) -> Any:
    for name in list(os.environ):
        if name.startswith("FLIGHTY_"):
            monkeypatch.delenv(name)
    monkeypatch.setenv("FLIGHTY_TOKEN", TOKEN)

    def deny_socket(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("Live websocket access is forbidden in the test suite")

    monkeypatch.setattr("websockets.asyncio.client.connect", deny_socket)
    with respx.mock as router:
        yield router


@pytest.fixture
def client() -> FlightyClient:
    return FlightyClient(Settings(build_token="synthetic-build-credential", allow_writes=False))


@pytest.fixture
def writer() -> FlightyClient:
    return FlightyClient(Settings(build_token="synthetic-build-credential", allow_writes=True))


def flight_record(owner: str = OWNER, flight_id: str = FLIGHT, **overrides: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "id": flight_id,
        "userId": owner,
        "isMine": True,
        "flight": {
            "id": flight_id,
            "flightNumber": "123",
            "airlineId": AIRLINE,
            "departure": {
                "airportId": AIRPORT_A,
                "gate": "A1",
                "schedule": {"gateOriginal": "2099-01-02T20:00:00Z"},
            },
            "arrival": {
                "scheduledAirportId": AIRPORT_B,
                "schedule": {"gateOriginal": "2099-01-03T01:00:00Z"},
            },
        },
        "created": "2000-01-01T00:00:00Z",
        "updated": "2000-01-02T00:00:00Z",
    }
    record.update(overrides)
    return record


def sync_body(
    records: list[dict[str, Any]] | None = None, *, more: bool = False, cursor: str | None = None
) -> bytes:
    data: list[dict[str, Any]] = [
        {
            "remoteUser": {
                "id": OWNER,
                "token": "synthetic-secret-never-return-this",
                "type": "ANONYMOUS",
            }
        },
        {
            "remoteAirport": {
                "id": AIRPORT_A,
                "name": "Example Origin",
                "iata": "AAA",
                "timezone": "America/Los_Angeles",
            }
        },
        {
            "remoteAirport": {
                "id": AIRPORT_B,
                "name": "Example Destination",
                "iata": "BBB",
                "timezone": "Europe/London",
            }
        },
        {"remoteAirline": {"id": AIRLINE, "name": "Example Air", "iata": "ZZ"}},
    ]
    data.extend(
        {"remoteUserFlight": record}
        for record in (records if records is not None else [flight_record()])
    )
    pagination: dict[str, Any] = {"moreData": more}
    if cursor:
        pagination["nextUrl"] = cursor
    return encode("SyncResponseProto", {"data": data, "pagination": pagination})


def mock_sync(body: bytes | None = None) -> respx.Route:
    return respx.post(SYNC).respond(
        200, content=body or sync_body(), headers={"Content-Type": "application/x-protobuf"}
    )
