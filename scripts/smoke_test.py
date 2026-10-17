"""Explicit live READ-ONLY validation. Never imported by the test suite.

Run: uv run python scripts/smoke_test.py
Uses FLIGHTY_TOKEN[_FILE] and optional FLIGHTY_BUILD_TOKEN[_FILE].
--credentials-stdin accepts a one-line object with token/build_token for local
automation without storing credentials or placing them in process arguments.
Only counts/operation status are printed; personal flight details are not.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from flighty_mcp.client import FlightyClient
from flighty_mcp.config import Settings, secret_env
from flighty_mcp.errors import FlightyError
from flighty_mcp.server import create_server
from flighty_mcp.service import FlightyService


async def run(token: str, build_token: str) -> None:
    # Hard-coded false: the live script cannot enable writes via environment.
    client = FlightyClient(
        Settings(build_token=build_token, allow_writes=False, allow_account_deletion=False)
    )
    tools = await create_server(client).list_tools()
    print(json.dumps({"tools_discovered": len(tools)}), flush=True)
    result = await FlightyService(client).list_flights(token, when="upcoming", limit=3)
    print(
        json.dumps(
            {
                "operation": "list_flights",
                "success": True,
                "upcoming_count": result["total"],
                "pages": result["cache"]["pages"],
            }
        ),
        flush=True,
    )
    if result["flights"]:
        flight = result["flights"][0]
        details = await client.request("get_flight", token, path={"flight_id": flight["id"]})
        print(
            json.dumps(
                {
                    "operation": "get_flight",
                    "success": True,
                    "response_keys": sorted(details["data"]),
                    "meta": details["meta"],
                }
            ),
            flush=True,
        )
        airport_id = flight["origin"].get("id")
        if airport_id:
            status = await client.request(
                "get_airport_mini_status", token, path={"airport_id": airport_id}
            )
            print(
                json.dumps(
                    {
                        "operation": "get_airport_mini_status",
                        "success": True,
                        "response_keys": sorted(status["data"]),
                        "meta": status["meta"],
                    }
                ),
                flush=True,
            )
    print(json.dumps({"complete": True, "mutating_requests_sent": 0}), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials-stdin", action="store_true")
    args = parser.parse_args()
    try:
        if args.credentials_stdin:
            credentials = json.loads(sys.stdin.readline())
            token, build_token = credentials["token"], credentials.get("build_token", "")
        else:
            token, build_token = secret_env("FLIGHTY_TOKEN"), secret_env("FLIGHTY_BUILD_TOKEN")
        asyncio.run(run(token, build_token))
    except FlightyError as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
