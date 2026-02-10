# Configuration

mcp-hitl-wrapper is configured with a single JSON file. All string values support `${ENV_VAR}` substitution — values are resolved from environment variables at load time.

Validate your config before starting:

```bash
mcp-hitl validate config.json
```

## Full example

```json
{
  "server": {
    "name": "mcp-hitl-wrapper",
    "version": "1.0.0"
  },

  "destinations": {
    "default": {
      "driver": "telegram",
      "botToken": "${TG_BOT_TOKEN}",
      "chatId": "${TG_CHAT_ID}"
    }
  },

  "mcps": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-slack"],
      "env": { "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}" },
      "tools": "*"
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
      "tools": { "block": ["delete_repository", "delete_branch"] }
    }
  },

  "hitl": {
    "defaultDestination": "default",
    "defaultTimeout": "3m",
    "tools": {
      "slack": {
        "chat_postMessage": { "timeout": "5m" },
        "chat_delete": { "timeout": "1m" }
      },
      "github": {
        "create_issue": {}
      }
    }
  },

  "audit": {
    "enabled": true,
    "dbPath": "./data/audit.db",
    "retentionDays": 90
  },

  "logging": {
    "level": "info",
    "format": "json"
  }
}
```

## Sections

### `server`

Optional. Server identity reported to MCP clients.

| Field | Default | Description |
|-------|---------|-------------|
| `name` | `"mcp-hitl-wrapper"` | Server name |
| `version` | `"1.0.0"` | Server version |

### `destinations`

Named destinations for HITL approval requests. Currently supports Telegram.

```json
{
  "destinations": {
    "ops-team": {
      "driver": "telegram",
      "botToken": "${TG_BOT_TOKEN}",
      "chatId": "${TG_OPS_CHAT_ID}"
    },
    "security": {
      "driver": "telegram",
      "botToken": "${TG_BOT_TOKEN}",
      "chatId": "${TG_SECURITY_CHAT_ID}"
    }
  }
}
```

You can define multiple destinations and route different tools to different chats/teams.

**Telegram destination fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `driver` | yes | Must be `"telegram"` |
| `botToken` | yes | Telegram bot token from [@BotFather](https://t.me/BotFather) |
| `chatId` | yes | Telegram chat ID (user or group) |

### `mcps`

Upstream MCP servers to proxy. Keys become namespace prefixes (e.g. `slack` → `slack__chat_postMessage`).

MCP names must not contain `__` (double underscore) — it's used as the tool name separator.

#### stdio transport

Default transport. Spawns a local process:

```json
{
  "slack": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-slack"],
    "env": { "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}" },
    "tools": "*"
  }
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `command` | yes | — | Command to execute |
| `args` | no | `[]` | Command arguments |
| `env` | no | `{}` | Environment variables for the process |
| `tools` | no | `"*"` | Access control (see below) |

#### SSE transport

Remote MCP server via Server-Sent Events:

```json
{
  "jira-cloud": {
    "transport": "sse",
    "url": "https://mcp.atlassian.com/jira",
    "headers": { "Authorization": "Bearer ${JIRA_TOKEN}" },
    "tools": { "allow": ["search", "get_issue"] }
  }
}
```

#### Streamable HTTP transport

Remote MCP server via Streamable HTTP:

```json
{
  "remote": {
    "transport": "streamable-http",
    "url": "https://mcp.example.com/api",
    "headers": { "Authorization": "Bearer ${TOKEN}" }
  }
}
```

**Remote transport fields (SSE and Streamable HTTP):**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `transport` | yes | — | `"sse"` or `"streamable-http"` |
| `url` | yes | — | Server URL |
| `headers` | no | `{}` | HTTP headers |
| `tools` | no | `"*"` | Access control (see below) |

### Tools access control

Controls which tools from each upstream MCP are exposed to agents.

| Mode | Config | Behavior |
|------|--------|----------|
| Allow all | `"tools": "*"` | All tools proxied (default) |
| Whitelist | `"tools": { "allow": ["a", "b"] }` | Only listed tools, new tools auto-blocked |
| Blocklist | `"tools": { "block": ["x", "y"] }` | All except listed tools |

Whitelist mode is recommended for production — new tools added upstream won't be exposed without explicit approval.

Use `mcp-hitl diff` to see the current status of all tools across all MCPs.

### `hitl`

Configures which tools require human approval.

```json
{
  "hitl": {
    "defaultDestination": "default",
    "defaultTimeout": "3m",
    "tools": {
      "slack": {
        "chat_postMessage": {},
        "chat_delete": { "timeout": "1m", "destination": "security" }
      }
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `defaultDestination` | `"default"` | Destination name from `destinations` |
| `defaultTimeout` | `"3m"` | Auto-reject timeout |
| `tools` | `{}` | Map of `{mcp: {tool: options}}` |

**Per-tool options:**

| Field | Description |
|-------|-------------|
| `timeout` | Override default timeout (e.g. `"5m"`, `"30s"`, `"1h"`) |
| `destination` | Override default destination |

Duration format: number + unit — `ms`, `s`, `m`, `h`.

Tools not listed under `hitl.tools` are passthrough — they execute immediately without approval.

### Discovery

For remote MCPs, poll for new tools:

```json
{
  "jira-cloud": {
    "transport": "sse",
    "url": "...",
    "tools": { "allow": ["search"] },
    "discovery": {
      "enabled": true,
      "pollInterval": "3h",
      "notifications": { "newTools": "telegram" }
    }
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Enable polling |
| `pollInterval` | `"3h"` | How often to check |
| `notifications.newTools` | `"log"` | `"log"`, `"telegram"`, `"both"`, or `"none"` |

In whitelist mode, newly discovered tools are automatically blocked until explicitly added to the allow list.

### `audit`

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Enable audit logging |
| `dbPath` | `"./data/audit.db"` | SQLite database path |
| `retentionDays` | `90` | Auto-delete entries older than this |

Audit log records every tool call with: timestamp, agent name, MCP, tool, parameters, decision (approved/rejected/timeout/passthrough/blocked), who decided, and latency.

Query with `mcp-hitl audit list` or export with `mcp-hitl audit export`. See [CLI Reference](cli.md).

### `logging`

| Field | Default | Description |
|-------|---------|-------------|
| `level` | `"info"` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `format` | `"json"` | `"json"` or `"pretty"` |

## Environment variable substitution

Any string value in the config can use `${VAR_NAME}` syntax. Variables are resolved from the process environment at config load time. Missing variables cause a validation error.

This keeps secrets out of config files — pass tokens via environment:

```bash
TG_BOT_TOKEN=xxx TG_CHAT_ID=123 mcp-hitl serve --config config.json
```

Or use `.env` files with Docker Compose.
