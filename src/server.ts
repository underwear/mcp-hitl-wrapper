import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Config } from './config/schema.js';
import { UpstreamManager } from './mcp/upstream.js';
import { checkToolAccess } from './mcp/access.js';
import { HitlManager } from './hitl/manager.js';
import { AuditDb } from './audit/db.js';
import { DiscoveryService } from './mcp/discovery.js';
import { unprefixToolName } from './utils/prefix.js';
import { getLogger, configureLogger } from './utils/logger.js';

const log = getLogger('server');

type AuditDecision = 'approved' | 'rejected' | 'timeout' | 'passthrough' | 'blocked';

export class HitlWrapperServer {
  private mcpServer: McpServer;
  private upstreamManager: UpstreamManager;
  private hitlManager: HitlManager | null = null;
  private auditDb: AuditDb | null = null;
  private discovery: DiscoveryService | null = null;

  constructor(private config: Config) {
    configureLogger({
      level: config.logging.level,
      format: config.logging.format,
    });

    this.mcpServer = new McpServer({
      name: config.server.name,
      version: config.server.version,
    });

    this.upstreamManager = new UpstreamManager();
  }

  async start(): Promise<void> {
    log.info('Starting mcp-hitl-wrapper server');

    // Connect to upstream MCPs
    await this.upstreamManager.connect(this.config);

    // Start HITL if destinations configured
    const hasDestinations = Object.keys(this.config.destinations).length > 0 &&
      Object.values(this.config.destinations).some(d => d.botToken);
    const hasHitlTools = Object.keys(this.config.hitl.tools).length > 0;

    if (hasDestinations && hasHitlTools) {
      this.hitlManager = new HitlManager(this.config);
      await this.hitlManager.start();
      log.info('HITL manager started');
    } else {
      log.info('HITL disabled (no destinations or no HITL tools configured)');
    }

    // Start audit
    if (this.config.audit.enabled) {
      this.auditDb = new AuditDb(this.config.audit.dbPath);
      // Schedule daily cleanup
      setInterval(() => {
        this.auditDb?.cleanup(this.config.audit.retentionDays);
      }, 24 * 60 * 60 * 1000);
    }

    // Start discovery
    this.discovery = new DiscoveryService(this.upstreamManager, this.config);
    this.discovery.start();

    // Register proxied tools
    this.registerTools();

    // Start MCP server on stdio
    const transport = new StdioServerTransport();
    await this.mcpServer.connect(transport);

    log.info('mcp-hitl-wrapper server started on stdio');
  }

  private registerTools(): void {
    const exposedTools = this.upstreamManager.getExposedTools();
    log.info({ toolCount: exposedTools.length }, `Registering ${exposedTools.length} proxied tools`);

    for (const tool of exposedTools) {
      this.mcpServer.tool(
        tool.name,
        tool.description ?? '',
        async (args: Record<string, unknown>) => {
          return this.handleToolCall(tool.name, args);
        },
      );
    }
  }

  private async handleToolCall(
    prefixedName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const startTime = Date.now();
    const parsed = unprefixToolName(prefixedName);

    if (!parsed) {
      return {
        content: [{ type: 'text', text: `Invalid tool name: ${prefixedName}` }],
        isError: true,
      };
    }

    const { mcpName, toolName } = parsed;
    const upstream = this.upstreamManager.getUpstream(mcpName);

    if (!upstream) {
      return {
        content: [{ type: 'text', text: `Unknown MCP: ${mcpName}` }],
        isError: true,
      };
    }

    // Check access control
    const access = checkToolAccess(upstream.config.tools, toolName);
    if (access === 'blocked') {
      const latency = Date.now() - startTime;
      this.logAudit({ mcpName, toolName, params: args, decision: 'blocked', decidedBy: 'system', latency });
      return {
        content: [{ type: 'text', text: `Tool "${toolName}" is blocked by access control policy` }],
        isError: true,
      };
    }

    // Extract HITL metadata from args if present
    const agent = (args['_agent'] as string) ?? undefined;
    const reason = (args['_reason'] as string) ?? undefined;
    const content = (args['_content'] as string) ?? undefined;

    // Clean internal args before forwarding
    const cleanArgs = { ...args };
    delete cleanArgs['_agent'];
    delete cleanArgs['_reason'];
    delete cleanArgs['_content'];

    // Check if HITL required
    if (this.hitlManager?.requiresApproval(mcpName, toolName)) {
      log.info({ mcpName, toolName }, 'Tool requires HITL approval');

      try {
        const response = await this.hitlManager.requestApproval({
          mcpName,
          toolName,
          params: cleanArgs,
          agent,
          reason,
          content,
        });

        if (response.decision !== 'approved') {
          const latency = Date.now() - startTime;
          const decision = response.decision === 'timeout' ? 'timeout' : 'rejected';
          this.logAudit({
            mcpName, toolName, params: cleanArgs, decision,
            decidedBy: response.decidedBy, latency, agent, reason, content,
          });

          const msg = response.decision === 'timeout'
            ? `Tool call "${toolName}" timed out waiting for approval`
            : `Tool call "${toolName}" was rejected by ${response.decidedBy}`;

          return { content: [{ type: 'text', text: msg }], isError: true };
        }

        log.info({ mcpName, toolName, decidedBy: response.decidedBy }, 'HITL approved');
      } catch (err) {
        const latency = Date.now() - startTime;
        this.logAudit({
          mcpName, toolName, params: cleanArgs, decision: 'rejected',
          decidedBy: 'system (error)', latency, agent, reason, content,
        });

        log.error({ mcpName, toolName, err }, 'HITL error');
        return {
          content: [{ type: 'text', text: `HITL error: ${err instanceof Error ? err.message : 'Unknown error'}` }],
          isError: true,
        };
      }
    }

    // Execute on upstream
    try {
      const result = await this.upstreamManager.callTool(mcpName, toolName, cleanArgs);
      const latency = Date.now() - startTime;
      const decision = this.hitlManager?.requiresApproval(mcpName, toolName) ? 'approved' : 'passthrough';

      this.logAudit({
        mcpName, toolName, params: cleanArgs, decision,
        decidedBy: decision === 'passthrough' ? 'system' : 'human',
        latency, agent, reason, content,
      });

      // Forward the result as-is if it has content
      if (result && typeof result === 'object' && 'content' in result) {
        return result as { content: Array<{ type: 'text'; text: string }> };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (err) {
      const latency = Date.now() - startTime;
      this.logAudit({
        mcpName, toolName, params: cleanArgs, decision: 'passthrough',
        decidedBy: 'system', latency, agent, reason, content,
      });

      log.error({ mcpName, toolName, err }, 'Upstream tool call failed');
      return {
        content: [{
          type: 'text',
          text: `Error calling ${mcpName}.${toolName}: ${err instanceof Error ? err.message : 'Unknown error'}`,
        }],
        isError: true,
      };
    }
  }

  private logAudit(opts: {
    mcpName: string;
    toolName: string;
    params: Record<string, unknown>;
    decision: string;
    decidedBy: string;
    latency: number;
    agent?: string;
    reason?: string;
    content?: string;
  }): void {
    if (!this.auditDb) return;

    try {
      this.auditDb.insert({
        timestamp: new Date().toISOString(),
        agent: opts.agent ?? null,
        mcp: opts.mcpName,
        tool: opts.toolName,
        params: JSON.stringify(opts.params),
        reason: opts.reason ?? null,
        content: opts.content ?? null,
        decision: opts.decision as AuditDecision,
        decided_by: opts.decidedBy,
        latency_ms: opts.latency,
      });
    } catch (err) {
      log.error({ err }, 'Failed to write audit log');
    }
  }

  async stop(): Promise<void> {
    log.info('Shutting down mcp-hitl-wrapper server');

    this.discovery?.stop();

    if (this.hitlManager) {
      await this.hitlManager.close();
    }

    await this.upstreamManager.close();

    if (this.auditDb) {
      this.auditDb.close();
    }

    await this.mcpServer.close();
    log.info('Server shutdown complete');
  }
}
