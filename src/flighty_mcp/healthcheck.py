"""MCP initialize handshake only; never contacts Flighty's API."""

import json
import os
from urllib.request import Request, urlopen


def main() -> None:
    port = int(os.environ.get("FLIGHTY_PORT", "8000"))
    path = os.environ.get("FLIGHTY_PATH", "/mcp")
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "healthcheck", "version": "1"},
        },
    }
    request = Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    with urlopen(request, timeout=4) as response:
        result = json.loads(response.read(65536))
    if "result" not in result or "serverInfo" not in result["result"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
