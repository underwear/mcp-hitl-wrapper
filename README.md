# mcp-hitl-wrapper

Universal MCP proxy with Human-in-the-Loop (HITL) approval flow via Telegram.

A facade that proxies any number of upstream MCP servers, adding a control layer: certain tools require human approval in Telegram before execution.

## Features

- **Universal proxy** — connect any MCP server (stdio or SSE) via config
- **Human-in-the-Loop** — dangerous operations require Telegram approval before execution
- **Tools access control** — whitelist, blocklist, or allow-all per upstream MCP
- **Tool namespacing** — automatic `{mcp}__{tool}` prefixing prevents name collisions
- **Audit log** — full SQLite audit trail of all operations
- **Discovery** — automatic detection of new tools from upstream MCPs
- **CLI tools** — serve, validate, discover, diff, audit commands
- **Docker ready** — multi-stage build, compose file included

## Architecture

```
┌─────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│   Agent     │────>│  mcp-hitl-wrapper   │────>│  MCP: Slack     │
│ (Claude,    │     │                     │────>│  MCP: GitHub    │
│  Cursor)    │<────│  - Tool proxying    │────>│  MCP: Jira      │
└─────────────┘     │  - HITL via TG      │────>│  MCP: ...       │
                    │  - Audit log        │     └─────────────────┘
                    └──────────┬──────────┘
                               │
                               v
                    ┌─────────────────────┐
                    │   Telegram Bot      │
                    │   (HITL approval)   │
                    └─────────────────────┘
```

**Flow:**

1. Agent calls tool (e.g. `slack__chat_postMessage`)
2. Wrapper parses prefix, routes to upstream MCP
3. Checks access control (allow/block)
4. If HITL required — sends approval request to Telegram, waits for approve/reject
5. On approve or passthrough — calls upstream, returns result
6. On reject/timeout/blocked — returns error to agent
7. Everything is logged to audit DB

## Quick Start

### Docker (recommended)

```bash
# Clone the repo
git clone https://github.com/underwear/mcp-hitl-wrapper.git
cd mcp-hitl-wrapper

# Configure
cp config/config.example.json config/config.json
cp .env.example .env
# Edit .env with your tokens

# Run
docker compose up -d
```

### From source

```bash
npm install
npm run build

# Validate your config
npx mcp-hitl validate config/config.json

# Start the server
npx mcp-hitl serve --config config/config.json
```

### Claude Desktop / Cursor integration

Add to your MCP config (`claude_desktop_config.json` or Cursor settings):

```json
{
  "mcpServers": {
    "hitl-wrapper": {
      "command": "npx",
      "args": ["mcp-hitl", "serve", "--config", "/path/to/config.json"],
      "env": {
        "TG_BOT_TOKEN": "your-telegram-bot-token",
        "TG_CHAT_ID": "your-telegram-chat-id",
        "SLACK_BOT_TOKEN": "xoxb-...",
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

## Configuration

### Config file

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
      "env": {
        "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}"
      },
      "tools": "*"
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      },
      "tools": {
        "block": ["delete_repository", "delete_branch"]
      }
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

### Environment variables

Config supports `${VAR_NAME}` syntax — values are substituted from environment at load time.

### Transports

**stdio** (default) — local MCP server spawned as a child process:

```json
{
  "slack": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-slack"],
    "env": { "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}" }
  }
}
```

**sse** — remote MCP server via Server-Sent Events:

```json
{
  "jira-cloud": {
    "transport": "sse",
    "url": "https://mcp.atlassian.com/jira",
    "headers": { "Authorization": "Bearer ${JIRA_TOKEN}" }
  }
}
```

**streamable-http** — remote MCP server via Streamable HTTP:

```json
{
  "remote": {
    "transport": "streamable-http",
    "url": "https://mcp.example.com/api",
    "headers": { "Authorization": "Bearer ${TOKEN}" }
  }
}
```

### Tools access control

| Mode | Config | Behavior |
|------|--------|----------|
| Allow all | `"tools": "*"` | All tools proxied (default) |
| Whitelist | `"tools": { "allow": ["a", "b"] }` | Only listed tools allowed, new tools auto-blocked |
| Blocklist | `"tools": { "block": ["x", "y"] }` | All tools except listed ones |

### HITL configuration

Tools listed under `hitl.tools.{mcp}` require human approval. Each tool can specify:

- `timeout` — override default timeout (e.g. `"5m"`, `"30s"`)
- `destination` — override default destination (e.g. `"security"`)

### Discovery

For SSE/remote MCPs, enable discovery to detect new tools:

```json
{
  "jira-cloud": {
    "transport": "sse",
    "url": "...",
    "tools": { "allow": ["search"] },
    "discovery": {
      "enabled": true,
      "pollInterval": "3h"
    }
  }
}
```

In whitelist mode, new tools are automatically blocked. Discovery logs changes for admin awareness.

## Tool namespacing

Tools are exposed to agents with `{mcp}__{tool}` prefixes:

```
Upstream "slack":  chat_postMessage, channels_list
Upstream "github": create_issue, list_repos

Exposed to agent:
  slack__chat_postMessage
  slack__channels_list
  github__create_issue
  github__list_repos
```

## HITL approval flow

When a HITL-configured tool is called, a Telegram message is sent:

```
🔔 HITL Approval Request

Agent: claude-code
MCP: slack
Tool: chat_postMessage

Parameters:
  {"channel": "#general", "text": "Hello team!"}

⏱ Auto-reject in 3:00

[✅ Approve] [❌ Reject]
```

After decision, the message is updated:

```
✅ Approved by @igor at 21:25:03
...
```

Timeout behavior: auto-reject after configured duration (default 3 minutes).

## CLI Reference

```bash
# Start the MCP server
mcp-hitl serve [--config config.json]

# Validate config file
mcp-hitl validate <config.json>

# Discover all tools from upstream MCPs
mcp-hitl discover [--config config.json]

# Show tool status diff (allowed/blocked/hitl)
mcp-hitl diff [--config config.json]

# Query audit log
mcp-hitl audit list [--last N] [--tool <name>] [--mcp <name>] [--since <duration>]

# Export audit log
mcp-hitl audit export [--format csv|json] [--output file]
```

## Audit Log

SQLite database tracking all tool calls:

| Column | Type | Description |
|--------|------|-------------|
| timestamp | TEXT | ISO 8601 |
| agent | TEXT | Agent name |
| mcp | TEXT | Upstream MCP name |
| tool | TEXT | Tool name (without prefix) |
| params | TEXT | JSON parameters |
| decision | TEXT | approved / rejected / timeout / passthrough / blocked |
| decided_by | TEXT | Telegram username or "system" |
| latency_ms | INTEGER | Request-to-response time |

Retention is configurable (default 90 days), with automatic cleanup.

## Docker

### Build

```bash
docker build -t mcp-hitl-wrapper .
```

### docker-compose

```yaml
services:
  mcp-hitl:
    build: .
    environment:
      - TG_BOT_TOKEN=${TG_BOT_TOKEN}
      - TG_CHAT_ID=${TG_CHAT_ID}
      - SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}
      - GITHUB_TOKEN=${GITHUB_TOKEN}
    volumes:
      - ./config.json:/app/config/config.json:ro
      - hitl-data:/app/data
    restart: unless-stopped

volumes:
  hitl-data:
```

## Development

```bash
# Install dependencies
npm install

# Run in dev mode
npm run dev -- serve --config config/config.example.json

# Run tests
npm test

# Lint
npm run lint

# Type check
npm run typecheck

# Build
npm run build
```

## Project Structure

```
src/
├── cli.ts                # CLI entry point (commander)
├── server.ts             # MCP server (wrapper)
├── config/
│   ├── schema.ts         # Zod config schema
│   └── loader.ts         # Config loading + env substitution
├── mcp/
│   ├── upstream.ts       # Upstream MCP manager
│   ├── transport/
│   │   ├── stdio.ts      # stdio transport
│   │   └── sse.ts        # SSE + Streamable HTTP transport
│   ├── discovery.ts      # Tool discovery
│   └── access.ts         # Tools access control
├── hitl/
│   ├── manager.ts        # HITL request manager
│   └── drivers/
│       ├── interface.ts   # HitlDriver interface
│       └── telegram.ts    # Telegram driver
├── audit/
│   └── db.ts             # SQLite audit log
└── utils/
    ├── logger.ts          # Pino logger
    └── prefix.ts          # Tool name prefixing
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/my-feature`)
3. Run tests (`npm test`) and lint (`npm run lint`)
4. Commit your changes
5. Push to the branch
6. Open a Pull Request

## License

[MIT](LICENSE)
