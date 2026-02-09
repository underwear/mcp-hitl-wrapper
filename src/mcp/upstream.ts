import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Config, McpConfig } from '../config/schema.js';
import { createStdioClient } from './transport/stdio.js';
import { createSseClient, createStreamableHttpClient } from './transport/sse.js';
import { checkToolAccess } from './access.js';
import { prefixToolName } from '../utils/prefix.js';
import { getLogger } from '../utils/logger.js';

const log = getLogger('upstream');

export interface UpstreamMcp {
  name: string;
  config: McpConfig;
  client: Client;
  tools: Tool[];
}

export class UpstreamManager {
  private upstreams = new Map<string, UpstreamMcp>();

  async connect(config: Config): Promise<void> {
    const entries = Object.entries(config.mcps);
    log.info({ count: entries.length }, 'Connecting to upstream MCPs');

    for (const [name, mcpConfig] of entries) {
      try {
        const client = await this.createClient(name, mcpConfig);
        const toolsResult = await client.listTools();
        const tools = toolsResult.tools ?? [];

        log.info({ name, toolCount: tools.length }, `Discovered ${tools.length} tools from ${name}`);

        this.upstreams.set(name, { name, config: mcpConfig, client, tools });
      } catch (err) {
        log.error({ name, err }, `Failed to connect to upstream MCP: ${name}`);
        throw err;
      }
    }
  }

  private async createClient(name: string, config: McpConfig): Promise<Client> {
    switch (config.transport) {
      case 'stdio':
        return createStdioClient(name, config);
      case 'sse':
        return createSseClient(name, config);
      case 'streamable-http':
        return createStreamableHttpClient(name, config);
      default:
        throw new Error(`Unknown transport for MCP "${name}"`);
    }
  }

  getUpstream(name: string): UpstreamMcp | undefined {
    return this.upstreams.get(name);
  }

  getAllUpstreams(): UpstreamMcp[] {
    return Array.from(this.upstreams.values());
  }

  getExposedTools(): Tool[] {
    const exposed: Tool[] = [];
    for (const upstream of this.upstreams.values()) {
      for (const tool of upstream.tools) {
        if (checkToolAccess(upstream.config.tools, tool.name) === 'allowed') {
          exposed.push({
            ...tool,
            name: prefixToolName(upstream.name, tool.name),
            description: tool.description
              ? `[${upstream.name}] ${tool.description}`
              : `[${upstream.name}] ${tool.name}`,
          });
        }
      }
    }
    return exposed;
  }

  async callTool(mcpName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const upstream = this.upstreams.get(mcpName);
    if (!upstream) throw new Error(`Unknown upstream MCP: ${mcpName}`);

    log.debug({ mcpName, toolName, args }, 'Calling upstream tool');
    const result = await upstream.client.callTool({ name: toolName, arguments: args });
    return result;
  }

  async refreshTools(mcpName: string): Promise<Tool[]> {
    const upstream = this.upstreams.get(mcpName);
    if (!upstream) throw new Error(`Unknown upstream MCP: ${mcpName}`);

    const result = await upstream.client.listTools();
    const tools = result.tools ?? [];
    upstream.tools = tools;
    return tools;
  }

  async close(): Promise<void> {
    for (const upstream of this.upstreams.values()) {
      try {
        await upstream.client.close();
        log.info({ name: upstream.name }, `Disconnected from ${upstream.name}`);
      } catch (err) {
        log.warn({ name: upstream.name, err }, `Error disconnecting from ${upstream.name}`);
      }
    }
    this.upstreams.clear();
  }
}
