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
3. Проверяет:
   - Tool разрешён? (tools config)
   - Tool требует HITL? (hitl config)
4. Если HITL → отправляем запрос в Telegram, ждём approve/reject
5. При approve или passthrough → вызываем upstream, возвращаем результат
6. При reject/timeout/blocked → возвращаем ошибку агенту
7. Всё логируем в audit log

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
      "driver": "telegram",
      "botToken": "${TG_BOT_TOKEN}",
      "chatId": "${TG_CHAT_ID}"
    },
    "security": {
      "driver": "telegram",
      "botToken": "${TG_SEC_BOT_TOKEN}",
      "chatId": "${TG_SEC_CHAT_ID}"
    }
  },

  "mcps": {
    "slack": {
      "transport": "stdio",
      "command": "npx",
      "args": ["@modelcontextprotocol/server-slack"],
      "env": {
        "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}",
        "SLACK_TEAM_ID": "${SLACK_TEAM_ID}"
      },
      "tools": "*"
    },
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      },
      "tools": {
        "block": ["delete_repo", "delete_branch"]
      }
    },
    "jira-cloud": {
      "transport": "sse",
      "url": "https://mcp.atlassian.com/jira",
      "headers": {
        "Authorization": "Bearer ${JIRA_TOKEN}"
      },
      "tools": {
        "allow": ["search", "get_issue", "create_issue", "update_issue"]
      },
      "discovery": {
        "enabled": true,
        "pollInterval": "3h"
      }
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
        "create_issue": {}
      },
      "jira-cloud": {
        "create_issue": {},
        "update_issue": {}
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

## Transport Types

### stdio (default)

Локальный MCP сервер — спавним процесс, общаемся через stdin/stdout.

```json
{
  "slack": {
    "transport": "stdio",
    "command": "npx",
    "args": ["@modelcontextprotocol/server-slack"],
    "env": {
      "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}"
    }
  }
}
```

### sse (Server-Sent Events)

Удалённый MCP сервер — подключаемся по HTTP.

```json
{
  "jira-cloud": {
    "transport": "sse",
    "url": "https://mcp.atlassian.com/jira",
    "headers": {
      "Authorization": "Bearer ${JIRA_TOKEN}"
    }
  }
}
```

**Defaults:**
- Если `transport` не указан и есть `command` → `stdio`
- Если есть `url` → `sse`

## Tools Access Control

Каждый MCP имеет свой `tools` конфиг, определяющий какие tools доступны.

### Режим 1: Всё разрешено (`tools: "*"`)

```json
{
  "slack": {
    "tools": "*"
  }
}
```

- Все tools от этого MCP проксируются
- HITL применяется только к tools из `hitl.tools.{mcp}`
- Остальные — passthrough

### Режим 2: Whitelist (`tools: { allow: [...] }`)

```json
{
  "jira-cloud": {
    "tools": {
      "allow": ["search", "get_issue", "create_issue"]
    }
  }
}
```

- Только перечисленные tools доступны
- Новые tools автоматически **blocked**
- Безопасно для SSE — защита от появления новых опасных tools

### Режим 3: Blocklist (`tools: { block: [...] }`)

```json
{
  "github": {
    "tools": {
      "block": ["delete_repo", "delete_branch"]
    }
  }
}
```

- Все tools разрешены, кроме перечисленных
- Перечисленные → blocked

### Default

Если `tools` не указан → эквивалентно `tools: "*"`.

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

## Destination Drivers

Destinations абстрагированы через драйверы — можно использовать разные каналы для доставки HITL запросов.

### Контракт драйвера

```typescript
interface HitlDriver {
  // Отправить запрос человеку, вернуть ID сообщения
  sendRequest(request: HitlRequest): Promise<string>;
  
  // Обновить сообщение (таймер, результат)
  updateMessage(messageId: string, update: MessageUpdate): Promise<void>;
  
  // Подписаться на ответы (approve/reject)
  onResponse(callback: (messageId: string, response: HitlResponse) => void): void;
  
  // Cleanup
  close(): Promise<void>;
}
```

### Реализованные драйверы

**telegram** (default) — полная реализация
```json
{
  "driver": "telegram",
  "botToken": "${TG_BOT_TOKEN}",
  "chatId": "${TG_CHAT_ID}"
}
```

### Задел на будущее (TODO)

**slack** — Block Kit interactive buttons
```json
{
  "driver": "slack",
  "botToken": "${SLACK_BOT_TOKEN}",
  "channel": "#approvals"
}
```

**discord** — interaction components
```json
{
  "driver": "discord",
  "botToken": "${DISCORD_BOT_TOKEN}",
  "channelId": "${DISCORD_CHANNEL_ID}"
}
```

### Default driver

Если `driver` не указан → `"telegram"`.

## Discovery

Discovery используется для отслеживания изменений в доступных tools у upstream MCP.

### Когда нужен discovery

- **stdio** — обычно не нужен, ты сам контролируешь версию пакета
- **sse** — рекомендуется, удалённый сервер может добавлять новые tools

### Конфигурация per-MCP

```json
{
  "jira-cloud": {
    "transport": "sse",
    "url": "...",
    "tools": {
      "allow": ["search", "get_issue"]
    },
    "discovery": {
      "enabled": true,
      "pollInterval": "3h"
    }
  }
}
```

### Notifications

При обнаружении новых tools — логируем (и опционально notify в TG):

```json
{
  "discovery": {
    "notifications": {
      "newTools": "log"
    }
  }
}
```

Значения: `"log"` | `"telegram"` | `"both"` | `"none"`

**Пример лога:**
```
[INFO] New tools discovered in "jira-cloud": delete_issue, bulk_update
```

**Важно:** в режиме whitelist (`tools: { allow: [...] }`) новые tools автоматически blocked. Discovery просто информирует админа.

## CLI Commands

```bash
# Запуск сервера
mcp-hitl serve [--config config.json]

# Дискавери — показать все tools из upstream MCPs
mcp-hitl discover [--config config.json]

# Diff — что нового vs текущий конфиг (для whitelist режима)
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
| decision | TEXT | approved / rejected / timeout / passthrough / blocked |
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
- Tools access control logic (allow/block)

### Integration tests

- Mock upstream MCP
- Full flow: request → HITL → approve → response
- Timeout flow
- Passthrough flow (non-HITL tools)
- Blocked tools flow

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
│   │   ├── transport/
│   │   │   ├── stdio.ts    # stdio transport
│   │   │   ├── sse.ts      # SSE transport
│   │   ├── discovery.ts    # Tool discovery
│   │   ├── proxy.ts        # Request proxying
│   │   ├── access.ts       # Tools access control (allow/block)
│   ├── hitl/
│   │   ├── manager.ts      # HITL request manager
│   │   ├── timeout.ts      # Timeout handling
│   │   ├── drivers/
│   │   │   ├── interface.ts  # HitlDriver interface
│   │   │   ├── telegram.ts   # Telegram driver (implemented)
│   │   │   ├── slack.ts      # Slack driver (TODO)
│   │   │   ├── discord.ts    # Discord driver (TODO)
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
3. [ ] Transport support (stdio + sse)
4. [ ] Tools access control (allow/block)
5. [ ] Telegram HITL integration
6. [ ] CLI tools (serve, discover, diff, validate, audit)
7. [ ] Config validation with zod
8. [ ] Audit log (SQLite)
9. [ ] Discovery with notifications
10. [ ] Dockerfile
11. [ ] docker-compose.yml example
12. [ ] GitHub Actions (CI + Release)
13. [ ] Unit tests
14. [ ] Integration tests
15. [ ] README.md
16. [ ] Example config

## Summary: Tool Resolution Flow

```
Agent calls: slack__chat_postMessage

1. Parse prefix → MCP: "slack", Tool: "chat_postMessage"

2. Check access (mcps.slack.tools):
   - tools: "*" → allowed
   - tools: { allow: [...] } → check if in list
   - tools: { block: [...] } → check if NOT in list
   
   If blocked → return error, log "blocked"

3. Check HITL (hitl.tools.slack):
   - Tool in list → send to Telegram, wait for approval
   - Tool not in list → passthrough

4. Execute on upstream MCP

5. Log to audit DB

6. Return result to agent
```

## Notes

- Без аутентификации — предполагается internal network / sidecar
- Без persistence для pending requests — только audit log
- Tool prefixing разделитель: `__` (double underscore)
- Default timeout: 3 minutes, configurable per-tool
- Только две кнопки в TG: Approve / Reject
- Notifications по умолчанию в log, TG опционально
- Whitelist mode (`tools: { allow: [...] }`) автоматически блокирует новые tools

## Questions for Implementation

Если что-то неясно — спрашивай. Но в целом:
1. Начни с базового proxy (stdio transport)
2. Добавь tools access control
3. Добавь HITL
4. Добавь SSE transport
5. Добавь discovery
6. Добавь audit
7. Добавь CLI
8. Добавь Docker + CI
9. Тесты в процессе

Good luck! 🚀
