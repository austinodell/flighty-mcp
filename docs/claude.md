# Using Flighty MCP with Claude

Have Docker running and your Flighty token ready. See the
[quickstart](../README.md) to get them. No repository download is needed.

## Claude Desktop

1. Open the desktop app's **Settings → Developer → Edit Config**.
2. Add the configuration below to `claude_desktop_config.json`. If you already
   have servers, add only the `flighty` entry inside the existing `mcpServers` object.
3. Replace the token placeholder, save, then fully quit and reopen Claude Desktop.

```json
{
  "mcpServers": {
    "flighty": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "FLIGHTY_TOKEN",
        "ghcr.io/swiftyspiffy/flighty-mcp:latest",
        "--transport", "stdio"
      ],
      "env": {"FLIGHTY_TOKEN": "PASTE_YOUR_FLIGHTY_TOKEN_HERE"}
    }
  }
}
```

If you need to open the file yourself:

| System | Configuration file |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Start a conversation and ask **“Use Flighty to show my upcoming flights.”**
The chat's **+ → Connectors** menu lets you inspect connected tools.
See the [official local-server walkthrough](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
and [Claude's local MCP help](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

If you installed without Docker, change `command` to `flighty-mcp` and remove
`args`. Keep `env`. Use the executable's full path if Claude cannot find it.

## Claude Code

Run this in your terminal after replacing the token placeholder:

```text
claude mcp add --scope user --env FLIGHTY_TOKEN=PASTE_YOUR_FLIGHTY_TOKEN_HERE --transport stdio flighty -- docker run --rm -i -e FLIGHTY_TOKEN ghcr.io/swiftyspiffy/flighty-mcp:latest --transport stdio
```

`--scope user` saves the connection in your personal configuration, outside your
project. Your token is stored there and may remain in terminal history; keep both private.
Restart Claude Code, run `/mcp` to check the connection, then ask about your flights.
See [Claude Code's MCP guide](https://code.claude.com/docs/en/mcp).

## Claude on the web and mobile

Web and mobile need an HTTPS server reachable by Claude; `127.0.0.1` and the local
Docker configuration above do not work as remote connectors.

If you already have a hosted Flighty MCP server:

1. Open **Customize → Connectors → + Add → Add custom connector**.
2. Enter **Flighty** and your server's HTTPS `/mcp` URL.
3. For the standard image, choose **No sign in** and add a **Request header**
   named `X-Flighty-Token`, with your Flighty token as its value.
4. Finish adding the connector and enable it in the conversation's **+ → Connectors** menu.

These steps describe a personal connector. Team/workspace setup may need an
administrator. See [Claude's remote connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

## Adding and editing flights

Adding and editing are enabled by default. For read-only access in the Desktop
configuration, add `"FLIGHTY_ALLOW_WRITES": "false"` alongside
`FLIGHTY_TOKEN` in `env`. Also add `"-e", "FLIGHTY_ALLOW_WRITES"` immediately before
the image name in `args`. Restart Claude Desktop. Account deletion remains off.

For read-only access in Claude Code, add `--env FLIGHTY_ALLOW_WRITES=false` before `--transport stdio`
and add `-e FLIGHTY_ALLOW_WRITES` before the image name when registering the server.
If `flighty` is already registered, update its personal configuration instead of
adding a duplicate. See [configuration](../README.md) for other options.

## If it does not connect

- Confirm Docker is running. Download the image ahead of time with
  `docker pull ghcr.io/swiftyspiffy/flighty-mcp:latest`, then restart Claude.
- In Desktop, check **Settings → Developer** for connection errors.
- If Claude cannot find Docker, use Docker's full executable path in `command`.
- For an authentication error, copy the full token again, without its label or spaces.
