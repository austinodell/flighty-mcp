"""Regenerate public API tables from the shipped endpoint/schema contract."""

from pathlib import Path

from flighty_mcp.endpoints import ENDPOINTS
from flighty_mcp.proto import SCHEMA


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    table = [
        "| Tool/operation | HTTP | Access | Request schema | Response schema |",
        "| --- | --- | --- | --- | --- |",
    ]
    for name, endpoint in ENDPOINTS.items():
        table.append(
            f"| `{name}` | `{endpoint.method} {endpoint.path}` | {'Read' if endpoint.read_only else 'Write'} | `{endpoint.request or ('JSON' if endpoint.json_body else 'none')}` | `{endpoint.response or ('binary image' if endpoint.binary_response else 'acknowledgment/JSON')}` |"
        )
    actions = ["| Action | Tag | Payload schema |", "| --- | --- | --- |"]
    for field in SCHEMA["SyncChangeRequestProto"]["fields"]:
        if field.get("oneof") == "change":
            actions.append(f"| `{field['json_name']}` | {field['number']} | `{field['type']}` |")
    for filename, text in [("endpoints.md", table), ("sync-actions.md", actions)]:
        (root / "docs" / filename).write_text("\n".join(text) + "\n")


if __name__ == "__main__":
    main()
