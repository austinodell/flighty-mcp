"""Errors whose messages are safe to show to MCP clients."""

from mcp.server.mcpserver.exceptions import ToolError


class FlightyError(ToolError):
    """An upstream, configuration, validation, or policy error."""


class WritesDisabled(FlightyError):
    """A mutation was refused before making an upstream request."""
