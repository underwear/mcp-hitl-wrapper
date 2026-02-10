import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StdioMcpConfig } from '../../config/schema.js';
import { getLogger } from '../../utils/logger.js';

const log = getLogger('transport:stdio');

export async function createStdioClient(name: string, config: StdioMcpConfig): Promise<Client> {
  // Filter out undefined values from process.env before merging
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) baseEnv[k] = v;
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...baseEnv, ...config.env },
  });

  const client = new Client({
    name: `mcp-hitl-wrapper/${name}`,
    version: '1.0.0',
  });

  log.info({ name, command: config.command, args: config.args }, `Connecting to stdio MCP: ${name}`);
  await client.connect(transport);
  log.info({ name }, `Connected to stdio MCP: ${name}`);

  return client;
}
