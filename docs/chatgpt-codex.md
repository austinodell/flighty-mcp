# Using Flighty MCP with ChatGPT and Codex

Have Docker running and your Flighty token ready. See the
[quickstart](../README.md) to get them. No repository download is needed.

## On your computer: Codex and ChatGPT desktop

Local Codex clients and the ChatGPT desktop app share MCP configuration for the
same Codex host. Add this to your personal `~/.codex/config.toml` file, creating
it if needed. On Windows, the default folder is `%USERPROFILE%\.codex`.
Keep existing settings and replace only the token placeholder:

```toml
[mcp_servers.flighty]
command = "docker"
args = [
  "run", "--rm", "-i",
  "-e", "FLIGHTY_TOKEN",
  "ghcr.io/swiftyspiffy/flighty-mcp:latest",
  "--transport", "stdio"
]
startup_timeout_sec = 60
tool_timeout_sec = 120

[mcp_servers.flighty.env]
FLIGHTY_TOKEN = "PASTE_YOUR_FLIGHTY_TOKEN_HERE"
```

Restart your client, then ask: **“Use Flighty to show my upcoming flights.”**
In Codex CLI, `/mcp` shows active servers; `codex mcp list` lists saved connections.
Keep this personal configuration private and out of project repositories.

If you installed without Docker, use `command = "flighty-mcp"` and remove `args`.
Keep the token settings. Use the executable's full path if it cannot be found.

Setup reference: [OpenAI's MCP guide](https://learn.chatgpt.com/docs/extend/mcp).

## ChatGPT on the web: hosted connection

You need a secured hosted Flighty MCP connection supplied by the server owner.
A local Docker command or `127.0.0.1` URL cannot be used directly from the web.

Once that connection and its authentication are ready:

1. Open **Plugins** in ChatGPT, choose **+**, then **Add custom MCP server**.
2. Name it **Flighty** and enter the supplied server URL, or select its Secure MCP Tunnel.
3. Use the authentication settings supplied by the server owner.
4. Create the plugin and install it. In a conversation, select it with **@**
   and ask **“Show my upcoming flights.”**

See [OpenAI's connection instructions](https://developers.openai.com/api/docs/guides/custom-mcp-server).
Workspace settings may restrict access.

**Hosting note:** The standard Flighty MCP image expects a Flighty token on each
HTTP request. ChatGPT's web connection does not directly accept a custom API-key
header, and this project does not include an OAuth sign-in service. A server
owner must configure authentication that forwards the correct Flighty credential.
A tunnel alone does not supply that credential. Do not expose an unauthenticated
owner-token proxy to the public internet. Local setup above avoids this hosting step.
See [OpenAI's authentication guide](https://developers.openai.com/plugins/build/auth).

## Adding and editing flights

Adding and editing are enabled by default. For read-only access in the local Docker setup,
add `"-e", "FLIGHTY_ALLOW_WRITES"` before the image name in `args`, then add:

```toml
# Add inside the existing [mcp_servers.flighty.env] table:
FLIGHTY_ALLOW_WRITES = "false"
```

Restart your client. Account deletion remains off. On a hosted connection, the
server owner controls whether writes are enabled.

## If it does not connect

- Confirm Docker is running. Download the image ahead of time with
  `docker pull ghcr.io/swiftyspiffy/flighty-mcp:latest`, then restart your client.
- For an authentication error, copy the complete `Current token:` value again,
  without copying the label or adding spaces.
- If tools are missing from an existing ChatGPT plugin, use **Refresh tools**
  in its management settings after the server owner updates it.
