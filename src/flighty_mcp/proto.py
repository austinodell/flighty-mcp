"""Protobuf contracts, implemented with the official protobuf runtime.

The JSON inventory contains names/tags/types only, not app code or credentials.
Dynamic descriptors avoid maintaining thousands of generated Python lines and
delegate packed fields, signed values, floats, maps, oneofs and timestamps to
protobuf itself. Unknown response fields are preserved in memory by the runtime.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from importlib.resources import files
from typing import Any

from google.protobuf import (
    any_pb2,
    descriptor_pb2,
    descriptor_pool,
    empty_pb2,
    json_format,
    message_factory,
    struct_pb2,
    timestamp_pb2,
)
from google.protobuf.message import DecodeError, Message

from .errors import FlightyError

SCHEMA: dict[str, Any] = json.loads(files("flighty_mcp").joinpath("data/schema.json").read_text())
F = descriptor_pb2.FieldDescriptorProto
SCALARS = {
    "string": F.TYPE_STRING,
    "bytes": F.TYPE_BYTES,
    "bool": F.TYPE_BOOL,
    "double": F.TYPE_DOUBLE,
    "float": F.TYPE_FLOAT,
    "int32": F.TYPE_INT32,
    "int64": F.TYPE_INT64,
    "uint32": F.TYPE_UINT32,
    "uint64": F.TYPE_UINT64,
}


def _identifier(name: str) -> str:
    return name.replace(".", "__")


def _field_type(field: Any, typename: str) -> None:
    if typename in SCALARS:
        field.type = SCALARS[typename]
    elif typename.startswith("google.protobuf."):
        field.type = F.TYPE_MESSAGE
        field.type_name = "." + typename
    else:
        definition = SCHEMA[typename]
        field.type = F.TYPE_ENUM if definition["kind"] == "enum" else F.TYPE_MESSAGE
        field.type_name = ".flighty." + _identifier(typename)
        if definition["kind"] == "enum":
            field.type_name += ".Value"


@lru_cache(maxsize=1)
def pool() -> Any:
    """Build a private descriptor pool, independent of other MCP plugins."""
    result = descriptor_pool.DescriptorPool()
    for dependency in (timestamp_pb2, struct_pb2, any_pb2, empty_pb2):
        result.AddSerializedFile(dependency.DESCRIPTOR.serialized_pb)
    source = descriptor_pb2.FileDescriptorProto(
        name="flighty.proto", package="flighty", syntax="proto3"
    )
    source.dependency.extend(
        [
            "google/protobuf/timestamp.proto",
            "google/protobuf/struct.proto",
            "google/protobuf/any.proto",
            "google/protobuf/empty.proto",
        ]
    )
    for name, definition in SCHEMA.items():
        message = source.message_type.add(name=_identifier(name))
        if definition["kind"] == "enum":
            enum = message.enum_type.add(name="Value")
            enum.options.allow_alias = len(set(definition["values"].values())) != len(
                definition["values"]
            )
            for symbol, number in sorted(definition["values"].items(), key=lambda item: item[1]):
                enum.value.add(name=symbol, number=number)
            continue
        groups = list(dict.fromkeys(f["oneof"] for f in definition["fields"] if f.get("oneof")))
        for group in groups:
            message.oneof_decl.add(name=group)
        for entry in definition["fields"]:
            field = message.field.add(
                name=entry["name"], json_name=entry["json_name"], number=entry["number"]
            )
            field.label = F.LABEL_REPEATED if entry["repeated"] else F.LABEL_OPTIONAL
            if entry["type"] == "map":
                field.label = F.LABEL_REPEATED
                map_name = "Map_" + entry["name"]
                mapping = message.nested_type.add(name=map_name)
                mapping.options.map_entry = True
                key = mapping.field.add(name="key", number=1, label=F.LABEL_OPTIONAL)
                _field_type(key, "string")
                value = mapping.field.add(name="value", number=2, label=F.LABEL_OPTIONAL)
                _field_type(value, entry["value_type"])
                field.type = F.TYPE_MESSAGE
                field.type_name = ".flighty." + message.name + "." + map_name
            else:
                _field_type(field, entry["type"])
            if entry.get("oneof"):
                field.oneof_index = groups.index(entry["oneof"])
            elif entry["optional"] and not entry["repeated"] and field.type != F.TYPE_MESSAGE:
                # Explicitly-present false, zero and empty string must survive encoding.
                field.oneof_index = len(message.oneof_decl)
                message.oneof_decl.add(name="_optional_" + field.name)
                field.proto3_optional = True
    result.Add(source)
    return result


def message_class(name: str) -> Any:
    if name not in SCHEMA or SCHEMA[name]["kind"] != "message":
        raise FlightyError("Unknown supported protobuf message. Use get_schema to list names.")
    return message_factory.GetMessageClass(
        pool().FindMessageTypeByName("flighty." + _identifier(name))
    )


def encode(name: str, payload: dict[str, Any]) -> bytes:
    """Strict ProtoJSON input: reject unknown fields and invalid oneof combinations."""
    if not isinstance(payload, dict):
        raise FlightyError("Protobuf payload must be a JSON object.")
    message = message_class(name)()
    try:
        json_format.ParseDict(
            payload,
            message,
            descriptor_pool=pool(),
            ignore_unknown_fields=False,
            max_recursion_depth=64,
        )
        return message.SerializeToString(deterministic=True)
    except (json_format.ParseError, ValueError, TypeError, OverflowError):
        # ParseError may contain actual credential/receipt bytes supplied by a caller.
        raise FlightyError(
            f"Payload does not match {name}. Use get_schema for fields, types and oneofs."
        ) from None


def parse(name: str, data: bytes) -> Message:
    message = message_class(name)()
    try:
        message.ParseFromString(data)
    except (DecodeError, ValueError):
        raise FlightyError(f"Response does not match supported {name} protobuf.") from None
    return message


def as_dict(message: Message) -> dict[str, Any]:
    """Return canonical ProtoJSON, including RFC3339 timestamps and enum names."""
    return json_format.MessageToDict(message, descriptor_pool=pool())


def decode(name: str, data: bytes) -> dict[str, Any]:
    return as_dict(parse(name, data))


def unknown_fields_present(message: Message) -> bool:
    known = type(message)()
    known.CopyFrom(message)
    known.DiscardUnknownFields()
    return known.SerializeToString(deterministic=True) != message.SerializeToString(
        deterministic=True
    )


def describe(name: str) -> dict[str, Any]:
    """Expose the exact supported request/response field contract to an MCP client."""
    if name not in SCHEMA:
        matches = [n for n in SCHEMA if name.casefold() in n.casefold()]
        return {"matches": matches, "count": len(matches)}
    return {"name": name, **SCHEMA[name]}


SECRET_FIELDS = re.compile(
    r"(?:token|secret|receipt|password|authorization|imageData)", re.IGNORECASE
)


def redact(value: Any) -> Any:
    """Never return account/device tokens, invitation secrets, or receipt data."""
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if SECRET_FIELDS.search(key) else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value
