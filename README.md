# mcp-hitl-wrapper

[![CI](https://github.com/underwear/mcp-hitl-wrapper/actions/workflows/ci.yml/badge.svg)](https://github.com/underwear/mcp-hitl-wrapper/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-hitl-wrapper)](https://www.npmjs.com/package/mcp-hitl-wrapper)
[![Docker](https://img.shields.io/badge/ghcr.io-mcp--hitl--wrapper-blue)](https://github.com/underwear/mcp-hitl-wrapper/pkgs/container/mcp-hitl-wrapper)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Human-in-the-loop approval for AI agent tool calls.**

AI agents with MCP access can post messages, create tickets, delete resources — all autonomously. This proxy sits between your agent and upstream MCP servers, intercepting dangerous tool calls and requiring your explicit approval via Telegram before execution.

```
┌─────────────┐     ┌───────────────────┐     ┌─────────────────┐
│   Agent     │────>│ mcp-hitl-wrapper  │────>│  MCP: Slack     │
│ (Claude,    │     │                   │────>│  MCP: GitHub    │
│  Cursor)    │<────│  proxy + approve  │────>│  MCP: Jira      │
└─────────────┘     └────────┬──────────┘     └─────────────────┘
                             │
                    ┌────────v──────────┐
                    │   Telegram Bot    │
                    │   [✅] [❌]      │
                    └───────────────────┘
```

Agent calls a tool → wrapper checks access rules → if HITL required, you get a Telegram message with Approve/Reject buttons → result forwarded to agent or error on reject/timeout. Everything is logged.

## Quick start

### Claude Desktop / Cursor

Add to your MCP client config (`claude_desktop_config.json` or Cursor settings):

```json
{
  "mcpServers": {
    "safe": {
      "command": "npx",
      "args": ["-y", "mcp-hitl-wrapper", "serve", "--config", "./config.json"],
      "env": {
        "TG_BOT_TOKEN": "your-bot-token",
        "TG_CHAT_ID": "your-chat-id",
        "SLACK_BOT_TOKEN": "xoxb-..."
      }
    }
  }
}
```

This launches the wrapper and passes environment variables to it. The wrapper reads its own `config.json` where `${ENV_VAR}` references are substituted from these values. All variables used in `config.json` must be listed here.

Create `config.json` — see [config example](#config-at-a-glance) below.

### Docker

```bash
docker pull ghcr.io/underwear/mcp-hitl-wrapper:latest
docker run -v ./config.json:/app/config/config.json:ro \
  -e TG_BOT_TOKEN=... -e TG_CHAT_ID=... \
  ghcr.io/underwear/mcp-hitl-wrapper
```

### npm

```bash
npm install -g mcp-hitl-wrapper
mcp-hitl serve --config config.json
```

## Config at a glance

```json
{
  "destinations": {
    "tg": {
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
      "tools": { "block": ["users_deletePhoto"] }
    }
  },

  "hitl": {
    "defaultDestination": "tg",
    "defaultTimeout": "3m",
    "tools": {
      "slack": {
        "chat_postMessage": {},
        "chat_delete": { "timeout": "1m" }
      }
    }
  }
}
```

`${ENV_VAR}` values are substituted from environment at load time. Full reference: [docs/configuration.md](docs/configuration.md)

## Features

- **Universal proxy** — wrap any MCP server: stdio, SSE, Streamable HTTP
- **Telegram approval** — approve/reject with one tap, auto-reject on timeout (requires a [dedicated bot](docs/configuration.md#destinations))
- **Access control** — allow-all, whitelist, or blocklist per upstream MCP
- **Tool namespacing** — automatic `{mcp}__{tool}` prefix prevents collisions
- **Audit trail** — SQLite log of every call with decision, latency, user
- **Discovery** — detect new tools from upstream MCPs, auto-block in whitelist mode
- **CLI toolkit** — validate, discover, diff, audit query/export
- **Docker ready** — multi-stage image on ghcr.io, compose included

## What approval looks like

When a HITL-configured tool is called:

```
🔔 HITL Approval Request

Agent: claude-code
MCP: slack → chat_postMessage

Parameters:
  {"channel": "#general", "text": "Hello team!"}

⏱ Auto-reject in 3:00

[✅ Approve] [❌ Reject]
```

Approve → tool executes, result goes back to agent.
Reject or timeout → agent gets an error, nothing happens.

## CLI

```bash
mcp-hitl serve --config config.json      # start proxy
mcp-hitl validate config.json            # validate config
mcp-hitl discover --config config.json   # list upstream tools
mcp-hitl diff --config config.json       # tool access status
mcp-hitl audit list --last 20            # query audit log
mcp-hitl audit export --format csv       # export audit data
```

## Documentation

- [Configuration](docs/configuration.md) — full config reference, transports, access control, HITL rules
- [CLI Reference](docs/cli.md) — all commands and options
- [Docker](docs/docker.md) — ghcr.io, local build, docker-compose

## Development

```bash
npm install && npm run build
npm test              # vitest
npm run lint          # eslint
npm run typecheck     # tsc
```

## License

[MIT](LICENSE)
