# CLI Reference

All commands accept `--config <path>` (default: `config/config.json`).

## `serve`

Start the MCP proxy server.

```bash
mcp-hitl serve --config config.json
```

Runs on stdio transport — designed to be launched by MCP clients (Claude Desktop, Cursor, etc.) as a child process. The server proxies all configured upstream MCPs, enforces access control, and handles HITL approval flows.

## `validate`

Validate a config file without starting the server.

```bash
mcp-hitl validate config.json
```

Checks JSON syntax, schema conformance, cross-references (HITL destinations exist, MCP names are valid), and environment variable substitution. Exit code 0 on success, 1 on error.

## `discover`

List all tools available from upstream MCPs.

```bash
mcp-hitl discover --config config.json
```

Connects to each configured MCP, fetches its tool list, and displays them with their status (allowed, blocked, HITL). Useful for initial setup and verifying what tools are available.

## `diff`

Show tool access status across all MCPs.

```bash
mcp-hitl diff --config config.json
```

Displays a summary of all tools with their current status: passthrough, HITL-required, blocked, or not discovered. Helps you verify your access control and HITL configuration.

## `audit list`

Query the audit log.

```bash
mcp-hitl audit list [options]
```

| Option | Description |
|--------|-------------|
| `--last <n>` | Show last N entries |
| `--tool <name>` | Filter by tool name |
| `--mcp <name>` | Filter by MCP name |
| `--since <duration>` | Entries since duration ago (e.g. `1h`, `7d`) |
| `--decision <type>` | Filter by decision: `approved`, `rejected`, `timeout`, `passthrough`, `blocked` |

Example:

```bash
# Last 10 rejected calls
mcp-hitl audit list --last 10 --decision rejected

# All Slack calls in the last hour
mcp-hitl audit list --mcp slack --since 1h
```

## `audit export`

Export the audit log.

```bash
mcp-hitl audit export [options]
```

| Option | Description |
|--------|-------------|
| `--format <fmt>` | `csv` or `json` (default: `json`) |
| `--output <file>` | Output file (default: stdout) |
| `--since <duration>` | Export entries since duration ago |

Example:

```bash
mcp-hitl audit export --format csv --output audit.csv --since 30d
```

### Audit log schema

Each entry records:

| Field | Description |
|-------|-------------|
| `timestamp` | ISO 8601 timestamp |
| `agent` | Agent name (from `_agent` param or "unknown") |
| `mcp` | Upstream MCP name |
| `tool` | Tool name (without namespace prefix) |
| `params` | JSON-encoded call parameters |
| `decision` | `approved`, `rejected`, `timeout`, `passthrough`, `blocked` |
| `decided_by` | Telegram username or `"system"` |
| `latency_ms` | Request-to-response time in milliseconds |

Retention is configurable (default 90 days). Old entries are automatically cleaned up.
