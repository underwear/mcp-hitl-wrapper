# TASK.md — mcp-hitl-wrapper

## Overview

**mcp-hitl-wrapper** — универсальный MCP (Model Context Protocol) прокси с Human-in-the-Loop (HITL) approval flow через Telegram.

Это фасад, который проксирует любое количество upstream MCP серверов, добавляя слой контроля: некоторые tools требуют одобрения человека в Telegram перед выполнением.

## Goals

1. **Универсальность** — не привязан к конкретным MCP, любой upstream подключается через конфиг
2. **HITL approval** — опасные операции требуют подтверждения в Telegram
3. **Observability** — полный audit log всех операций
4. **Простота деплоя** — Docker контейнер с конфигурацией через JSON + env

## Architecture

```
┌─────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│   Agent     │────▶│  mcp-hitl-wrapper   │────▶│  MCP: Slack     │
│ (Claude,    │     │                     │────▶│  MCP: GitHub    │
│  Cursor)    │◀────│  - Tool proxying    │────▶│  MCP: Jira      │
└─────────────┘     │  - HITL via TG      │────▶│  MCP: ...       │
                    │  - Audit log        │     └─────────────────┘
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Telegram Bot      │
                    │   (HITL approval)   │
                    └─────────────────────┘
```

**Flow:**
1. Agent вызывает tool (например `slack__chat_postMessage`)
2. Wrapper парсит префикс → определяет upstream MCP
3. Проверяет: tool требует HITL?
   - **Нет** → passthrough, вызываем upstream, возвращаем результат
   - **Да** → отправляем запрос в Telegram, ждём approve/reject
4. При approve → вызываем upstream, возвращаем результат
5. При reject или timeout → возвращаем ошибку агенту
6. Всё логируем в audit log

## Tech Stack

- **Runtime:** Node.js 22+ LTS
- **Language:** TypeScript 5.x (strict mode)
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Telegram Bot:** `grammy`
- **Config:** JSON file + env variable substitution
- **CLI:** `commander`
- **Logging:** `pino` (structured JSON)
- **Validation:** `zod` (config schema)
- **Audit DB:** `better-sqlite3`
- **Build:** `tsup` или `esbuild`

## Configuration

### Config file: `config.json`

```json
{
  "server": {
    "name": "mcp-hitl-wrapper",
    "version": "1.0.0"
  },

  "destinations": {
    "default": {
      "botToken": "${TG_BOT_TOKEN}",
      "chatId": "${TG_CHAT_ID}"
    },
    "security": {
      "botToken": "${TG_SEC_BOT_TOKEN}",
      "chatId": "${TG_SEC_CHAT_ID}"
    }
  },

  "mcps": {
    "slack": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-slack"],
      "env": {
        "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}",
        "SLACK_TEAM_ID": "${SLACK_TEAM_ID}"
      }
    },
    "github": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  },

  "discovery": {
    "mode": "auto",
    "pollInterval": "3h",
    "notifications": {
      "newTools": "log",
      "mcpErrors": "log"
    }
  },

  "hitl": {
    "defaultDestination": "default",
    "defaultTimeout": "3m",
    "tools": {
      "slack": {
        "chat_postMessage": {
          "timeout": "5m"
        },
        "chat_delete": {
          "destination": "security",
          "timeout": "1m"
        }
      },
      "github": {
        "create_issue": {},
        "delete_repo": {
          "destination": "security",
          "timeout": "1m"
        }
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

Config поддерживает `${VAR_NAME}` синтаксис — значения подставляются из environment при загрузке.

Обязательные env vars зависят от конфига, но типично:
- `TG_BOT_TOKEN` — Telegram bot token
- `TG_CHAT_ID` — Telegram chat ID для HITL
- Токены для upstream MCPs (SLACK_BOT_TOKEN, GITHUB_TOKEN, etc.)

## Tool Namespacing

Проблема: разные MCP могут иметь tools с одинаковыми именами.

Решение: wrapper добавляет префикс `{mcp}__{tool}`:

```
Upstream "slack": chat_postMessage, channels_list
Upstream "github": create_issue, list_repos

Exposed to agent:
  slack__chat_postMessage
  slack__channels_list
  github__create_issue
  github__list_repos
```

Разделитель: `__` (double underscore)

При вызове wrapper:
1. Парсит префикс
2. Роутит на нужный upstream MCP
3. Вызывает tool без префикса

## HITL Flow

### Telegram сообщение

```
🔔 HITL Approval Request

Agent: claude-code-main
MCP: slack
Tool: chat_postMessage

Reason: User asked to notify team about deploy
Content: "🚀 Deploy v2.3.1 complete"

Parameters:
  channel: #deployments
  text: 🚀 Deploy v2.3.1 complete

⏱ Auto-reject in 3:00

[✅ Approve] [❌ Reject]
```

### Заголовки от агента (опционально)

Агент может передать context через заголовки:
- `X-Agent-Name` — имя агента (отображается в сообщении)
- `X-Reason` — почему агент делает этот вызов
- `X-Content` — краткое содержимое (preview)

Если заголовков нет — показываем только tool + params.

### Timeout behavior

- По умолчанию: 3 минуты
- Настраивается per-tool в конфиге
- По истечении: auto-reject
- Агент получает ошибку, может retry если нужно

### Кнопки

Только две: `[✅ Approve]` `[❌ Reject]`

После нажатия сообщение редактируется:
```
✅ Approved by @igor_f at 21:25:03

Agent: claude-code-main
MCP: slack
Tool: chat_postMessage
...
```

## Discovery Mode

### Auto mode (default)

При старте и периодически (по `pollInterval`):
1. Подключаемся к каждому upstream MCP
2. Вызываем `tools/list`
3. Кэшируем список tools
4. Если появились новые — логируем (опционально notify в TG)

Tools не в `hitl.tools` → passthrough без approval.

### Whitelist mode

```json
{
  "discovery": {
    "mode": "whitelist"
  },
  "whitelist": {
    "slack": ["chat_postMessage", "channels_list", "reactions_add"],
    "github": ["create_issue", "list_repos"]
  }
}
```

Только tools из whitelist проксируются. Остальные — ошибка "tool not allowed".

## CLI Commands

```bash
# Запуск сервера
mcp-hitl serve [--config config.json]

# Дискавери — показать все tools из upstream MCPs
mcp-hitl discover [--config config.json]

# Diff — что нового vs текущий whitelist
mcp-hitl diff [--config config.json]

# Валидация конфига
mcp-hitl validate <config.json>

# Audit log
mcp-hitl audit [--last N] [--tool <name>] [--since <duration>]
mcp-hitl audit export [--format csv|json] [--output file]
```

## Audit Log

SQLite database с записями:

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Auto-increment PK |
| timestamp | TEXT | ISO 8601 |
| agent | TEXT | X-Agent-Name header |
| mcp | TEXT | Upstream MCP name |
| tool | TEXT | Tool name (without prefix) |
| params | TEXT | JSON params |
| reason | TEXT | X-Reason header |
| content | TEXT | X-Content header |
| decision | TEXT | approved / rejected / timeout / passthrough |
| decided_by | TEXT | TG username or "system" |
| latency_ms | INTEGER | Time from request to response |

CLI команды для просмотра и экспорта.

Retention: configurable, default 90 days. Old records auto-deleted.

## Error Handling

### Upstream MCP failures

- Если upstream MCP не отвечает или крашится — возвращаем ошибку агенту
- Логируем ошибку
- Опционально notify (если `mcpErrors: "telegram"` или `"both"`)

### Graceful shutdown

- Handle SIGTERM, SIGINT
- Отменяем pending HITL requests (auto-reject)
- Закрываем connections к upstream MCPs
- Закрываем audit DB

### Restart behavior

- Pending HITL requests не персистятся
- При рестарте они теряются (считаются rejected)
- Агент получит ошибку и может retry

## Docker

### Dockerfile

Multi-stage build:
1. Build stage: compile TypeScript
2. Runtime stage: node:22-alpine + compiled JS

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# For spawning MCP servers
RUN npm install -g npx

VOLUME ["/app/data", "/app/config"]

EXPOSE 3000

CMD ["node", "dist/cli.js", "serve", "--config", "/app/config/config.json"]
```

### docker-compose.yml (example)

```yaml
version: '3.8'
services:
  mcp-hitl:
    image: ghcr.io/underwear/mcp-hitl-wrapper:latest
    environment:
      - TG_BOT_TOKEN=${TG_BOT_TOKEN}
      - TG_CHAT_ID=${TG_CHAT_ID}
      - SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN}
      - GITHUB_TOKEN=${GITHUB_TOKEN}
    volumes:
      - ./config.json:/app/config/config.json:ro
      - ./data:/app/data
    restart: unless-stopped
```

## GitHub Actions

### CI workflow (`.github/workflows/ci.yml`)

On push/PR:
1. Lint (eslint)
2. Type check (tsc --noEmit)
3. Unit tests
4. Build

### Release workflow (`.github/workflows/release.yml`)

On tag push (v*):
1. Build Docker image
2. Push to ghcr.io/underwear/mcp-hitl-wrapper
3. Tag as `latest` + version tag

## Testing

### Unit tests

- Config parsing & validation
- Tool name prefixing/unprefixing
- HITL timeout logic
- Audit log queries

### Integration tests

- Mock upstream MCP
- Full flow: request → HITL → approve → response
- Timeout flow
- Passthrough flow (non-HITL tools)

Framework: `vitest`

## Project Structure

```
mcp-hitl-wrapper/
├── src/
│   ├── cli.ts              # CLI entry point
│   ├── server.ts           # MCP server (wrapper)
│   ├── config/
│   │   ├── schema.ts       # Zod schema
│   │   ├── loader.ts       # Config loading + env substitution
│   ├── mcp/
│   │   ├── upstream.ts     # Upstream MCP manager
│   │   ├── discovery.ts    # Tool discovery
│   │   ├── proxy.ts        # Request proxying
│   ├── hitl/
│   │   ├── manager.ts      # HITL request manager
│   │   ├── telegram.ts     # Telegram bot integration
│   │   ├── timeout.ts      # Timeout handling
│   ├── audit/
│   │   ├── db.ts           # SQLite operations
│   │   ├── queries.ts      # Query helpers
│   ├── utils/
│   │   ├── logger.ts       # Pino logger setup
│   │   ├── prefix.ts       # Tool name prefixing
├── tests/
│   ├── unit/
│   ├── integration/
├── config/
│   ├── config.example.json
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── release.yml
└── README.md
```

## README.md

Должен содержать:
1. Что это и зачем
2. Quick start (Docker)
3. Configuration reference
4. CLI reference
5. Examples
6. Contributing

## Deliverables

1. [x] Repository created
2. [ ] Working MCP proxy server
3. [ ] Telegram HITL integration
4. [ ] CLI tools (serve, discover, diff, validate, audit)
5. [ ] Config validation with zod
6. [ ] Audit log (SQLite)
7. [ ] Auto-discovery with polling
8. [ ] Whitelist mode
9. [ ] Dockerfile
10. [ ] docker-compose.yml example
11. [ ] GitHub Actions (CI + Release)
12. [ ] Unit tests
13. [ ] Integration tests
14. [ ] README.md
15. [ ] Example config

## Notes

- Без аутентификации — предполагается internal network / sidecar
- Без persistence для pending requests — только audit log
- Tool prefixing разделитель: `__` (double underscore)
- Default timeout: 3 minutes, configurable per-tool
- Только две кнопки в TG: Approve / Reject
- Notifications по умолчанию в log, TG опционально

## Questions for Implementation

Если что-то неясно — спрашивай. Но в целом:
- Начни с базового proxy без HITL
- Добавь HITL
- Добавь audit
- Добавь CLI
- Добавь Docker + CI
- Тесты в процессе

Good luck! 🚀
