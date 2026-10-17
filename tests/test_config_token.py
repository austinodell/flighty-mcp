from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from flighty_mcp.client import token_subject, validate_token
from flighty_mcp.config import Settings, secret_env
from flighty_mcp.errors import FlightyError
from flighty_mcp.token import (
    decode_jwt,
    extract_cloudkit_token,
    main,
    write_secret,
)

from .conftest import OWNER, TOKEN


def test_writes_enabled_and_account_deletion_disabled_by_default() -> None:
    settings = Settings.from_env()
    assert settings.allow_writes
    assert not settings.allow_account_deletion
    assert settings.build_token == ""
    assert Settings().allow_writes
    assert not Settings().allow_account_deletion


@pytest.mark.parametrize("value", ["false", "0"])
def test_writes_can_be_disabled(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("FLIGHTY_ALLOW_WRITES", value)
    settings = Settings.from_env()
    assert not settings.allow_writes
    assert not settings.allow_account_deletion


def test_secrets_are_not_in_settings_repr() -> None:
    assert "synthetic-private-build" not in repr(Settings(build_token="synthetic-private-build"))


def test_file_secret_and_conflicting_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    file = tmp_path / "credential"
    file.write_text("synthetic-secret\n")
    monkeypatch.setenv("FLIGHTY_BUILD_TOKEN_FILE", str(file))
    assert secret_env("FLIGHTY_BUILD_TOKEN") == "synthetic-secret"
    monkeypatch.setenv("FLIGHTY_BUILD_TOKEN", "another")
    with pytest.raises(FlightyError, match="only"):
        secret_env("FLIGHTY_BUILD_TOKEN")


@pytest.mark.parametrize(
    "name,value",
    [
        ("FLIGHTY_ALLOW_WRITES", "maybe"),
        ("FLIGHTY_MAX_PAGES", "0"),
        ("FLIGHTY_CACHE_TTL", "-1"),
        ("FLIGHTY_TIMEOUT", "not-a-number"),
        ("FLIGHTY_LOCALE", "bad\r\nvalue"),
    ],
)
def test_invalid_configuration_rejected(
    monkeypatch: pytest.MonkeyPatch, name: str, value: str
) -> None:
    monkeypatch.setenv(name, value)
    with pytest.raises(FlightyError):
        Settings.from_env()


def test_diagnostic_import_accepts_only_one_current_token() -> None:
    assert extract_cloudkit_token("Current token: " + TOKEN + "\n") == TOKEN
    for text in (
        "FlightyLog without cloudkit diagnostics",
        "Current token: bad\n",
        "Current token: " + TOKEN + "\nCurrent token: " + TOKEN,
    ):
        with pytest.raises(FlightyError):
            extract_cloudkit_token(text)


def test_jwt_inspect_does_not_claim_signature_verification() -> None:
    result = decode_jwt(TOKEN)
    assert result["signature_verified"] is False
    assert result["payload"]["sub"] == OWNER
    assert token_subject(TOKEN) == OWNER


@pytest.mark.parametrize("value", ["", "bad\r\nheader", "a b", "a" * 9000])
def test_invalid_header_credential_is_not_echoed(value: str) -> None:
    with pytest.raises(FlightyError):
        validate_token(value)


def test_credential_file_permissions_overwrite_and_symlink(tmp_path: Path) -> None:
    file = tmp_path / "secrets" / "token"
    write_secret(file, "synthetic")
    assert stat.S_IMODE(file.stat().st_mode) == 0o600
    assert stat.S_IMODE(file.parent.stat().st_mode) == 0o700
    with pytest.raises(FlightyError):
        write_secret(file, "replacement")
    write_secret(file, "replacement", force=True)
    link = tmp_path / "link"
    link.symlink_to(file)
    with pytest.raises(FlightyError):
        write_secret(link, "must-not-follow", force=True)
    assert file.read_text() == "replacement\n"


def test_cli_import_does_not_print_credential(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    diagnostic = tmp_path / "diagnostic.txt"
    diagnostic.write_text("Current token: " + TOKEN + "\n")
    output = tmp_path / "saved-token"
    main(["extract", str(diagnostic), "--output", str(output)])
    captured = capsys.readouterr()
    assert TOKEN not in captured.out + captured.err
    assert output.read_text().strip() == TOKEN
    main(["inspect", str(output)])
    assert json.loads(capsys.readouterr().out)["signature_verified"] is False
