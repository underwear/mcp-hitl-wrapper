# Docker

## Pull from ghcr.io

Pre-built images are published on every push to master:

```bash
docker pull ghcr.io/underwear/mcp-hitl-wrapper:latest
```

Tagged releases are also available:

```bash
docker pull ghcr.io/underwear/mcp-hitl-wrapper:1.0.0
```

## Run

```bash
docker run \
  -v ./config.json:/app/config/config.json:ro \
  -v hitl-data:/app/data \
  -e TG_BOT_TOKEN=your-bot-token \
  -e TG_CHAT_ID=your-chat-id \
  ghcr.io/underwear/mcp-hitl-wrapper
```

The container expects:
- Config file mounted at `/app/config/config.json`
- Environment variables for `${VAR}` substitution in config
- `/app/data` volume for the SQLite audit database (persistent)

## docker-compose

```yaml
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
      - hitl-data:/app/data
    restart: unless-stopped

volumes:
  hitl-data:
```

Use a `.env` file next to `docker-compose.yml` for secrets:

```
TG_BOT_TOKEN=8458...
TG_CHAT_ID=12345
SLACK_BOT_TOKEN=xoxb-...
```

## Build locally

```bash
docker build -t mcp-hitl-wrapper .
```

Multi-stage build: compiles TypeScript in a builder stage, copies only `dist/` and production `node_modules/` to a slim Alpine image. Uses [tini](https://github.com/krallin/tini) for proper signal handling.

## Volumes

| Path | Purpose |
|------|---------|
| `/app/config` | Config files (mount read-only) |
| `/app/data` | SQLite audit database (persist this) |
