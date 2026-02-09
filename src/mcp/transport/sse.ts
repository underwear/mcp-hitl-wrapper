import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { SseMcpConfig, StreamableHttpMcpConfig } from '../../config/schema.js';
import { getLogger } from '../../utils/logger.js';

const log = getLogger('transport:sse');

export async function createSseClient(name: string, config: SseMcpConfig): Promise<Client> {
  const url = new URL(config.url);
  const transport = new SSEClientTransport(url, {
    requestInit: {
      headers: config.headers,
    },
  });

  const client = new Client({
    name: `mcp-hitl-wrapper/${name}`,
    version: '1.0.0',
  });

  log.info({ name, url: config.url }, `Connecting to SSE MCP: ${name}`);
  await client.connect(transport);
  log.info({ name }, `Connected to SSE MCP: ${name}`);

  return client;
}

export async function createStreamableHttpClient(name: string, config: StreamableHttpMcpConfig): Promise<Client> {
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const url = new URL(config.url);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: config.headers,
    },
  });

  const client = new Client({
    name: `mcp-hitl-wrapper/${name}`,
    version: '1.0.0',
  });

  log.info({ name, url: config.url }, `Connecting to Streamable HTTP MCP: ${name}`);
  await client.connect(transport);
  log.info({ name }, `Connected to Streamable HTTP MCP: ${name}`);

  return client;
}
