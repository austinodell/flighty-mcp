"""Local credential import. Nothing is uploaded and secrets are never printed by default."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from .client import token_subject, validate_token
from .errors import FlightyError


def decode_jwt(token: str) -> dict[str, Any]:
    """Decode header and payload; this does not verify the HMAC signature."""
    try:
        parts = token.split(".")
        if len(parts) != 3:
            raise ValueError
        decoded = [
            json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
            for part in parts[:2]
        ]
        if not all(isinstance(item, dict) for item in decoded):
            raise ValueError
        return {"header": decoded[0], "payload": decoded[1], "signature_verified": False}
    except (ValueError, UnicodeError):
        raise FlightyError("Credential is not a decodable JWT.") from None


def extract_cloudkit_token(text: str) -> str:
    matches = re.findall(r"^Current token:[ \t]*([^\r\n]+)", text, flags=re.MULTILINE)
    if len(matches) != 1:
        raise FlightyError("Expected exactly one Current token entry in CloudKit-Debug-Log.txt.")
    token = validate_token(matches[0])
    decoded = decode_jwt(token)
    if decoded["payload"].get("iss") != "flighty-api":
        raise FlightyError("The token's issuer is not flighty-api.")
    token_subject(token)
    return token


def write_secret(destination: Path, secret: str, *, force: bool = False) -> None:
    """Create an owner-only credential file without following symlinks."""
    destination = destination.expanduser()
    destination.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW
    flags |= os.O_TRUNC if force else os.O_EXCL
    try:
        descriptor = os.open(destination, flags, 0o600)
        with os.fdopen(descriptor, "w") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(secret + "\n")
    except OSError:
        raise FlightyError(
            "Cannot create credential file. Choose a new file, or --force to replace an existing regular file."
        ) from None


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Import Flighty credentials locally, without printing secrets."
    )
    sub = parser.add_subparsers(dest="command", required=True)
    action = sub.add_parser("extract", help="Read CloudKit-Debug-Log.txt")
    action.add_argument("source", type=Path)
    output = action.add_mutually_exclusive_group(required=True)
    output.add_argument("--output", type=Path)
    output.add_argument(
        "--stdout",
        action="store_true",
        help="Explicitly print the credential (for a local pipe)",
    )
    action.add_argument("--force", action="store_true")
    inspect = sub.add_parser("inspect", help="Show JWT claims, without showing the credential")
    inspect.add_argument("source", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "inspect":
            print(json.dumps(decode_jwt(validate_token(args.source.read_text())), indent=2))
            return
        if args.source.stat().st_size > 1024 * 1024:
            raise FlightyError("Diagnostic file is too large.")
        secret = extract_cloudkit_token(args.source.read_text(encoding="utf-8-sig"))
        if args.stdout:
            print(secret)
        else:
            write_secret(args.output, secret, force=args.force)
            print("Credential saved with owner-only permissions.", file=sys.stderr)
    except (FlightyError, OSError, UnicodeError) as error:
        message = (
            str(error)
            if isinstance(error, FlightyError)
            else "Cannot read the supplied local file."
        )
        parser.exit(1, message + "\n")
