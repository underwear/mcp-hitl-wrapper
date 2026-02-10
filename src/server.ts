import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http';
import type { Config } from './config/schema.js';
import { UpstreamManager } from './mcp/upstream.js';
import { checkToolAccess } from './mcp/access.js';
import { HitlManager } from './hitl/manager.js';
import { AuditDb } from './audit/db.js';
import { DiscoveryService } from './mcp/discovery.js';
import { unprefixToolName } from './utils/prefix.js';
import { getLogger, configureLogger } from './utils/logger.js';

const log = getLogger('server');

type AuditDecision = 'approved' | 'rejected' | 'timeout' | 'passthrough' | 'blocked' | 'error';

export class HitlWrapperServer {
  private server: Server | null = null;
  private upstreamManager: UpstreamManager;
  private hitlManager: HitlManager | null = null;
  private auditDb: AuditDb | null = null;
  private discovery: DiscoveryService | null = null;
  private auditCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private httpServer: HttpServer | null = null;
  private httpTransports: Map<string, InstanceType<typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport>> | null = null;

  constructor(private config: Config) {
    configureLogger({
      level: config.logging.level,
      format: config.logging.format,
    });

    this.upstreamManager = new UpstreamManager();
  }

  private async init(): Promise<void> {
    // Connect to upstream MCPs
    await this.upstreamManager.connect(this.config);

    // Start HITL if destinations configured (BUG 14: check existence, not botToken)
    const hasDestinations = Object.keys(this.config.destinations).length > 0;
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
      this.auditCleanupTimer = setInterval(() => {
        this.auditDb?.cleanup(this.config.audit.retentionDays);
      }, 24 * 60 * 60 * 1000);
    }

    // Start discovery
    this.discovery = new DiscoveryService(this.upstreamManager, this.config);
    this.discovery.start();
  }

  private createMcpServer(): Server {
    const server = new Server(
      { name: this.config.server.name, version: this.config.server.version },
      { capabilities: { tools: {} } },
    );
    this.registerHandlers(server);
    return server;
  }

  async start(): Promise<void> {
    log.info('Starting mcp-hitl-wrapper server in stdio mode');

    await this.init();

    this.server = this.createMcpServer();

    // Start on stdio
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    log.info('mcp-hitl-wrapper server started on stdio');
  }

  async startHttp(port: number): Promise<void> {
    log.info({ port }, 'Starting mcp-hitl-wrapper server in HTTP mode');

    await this.init();

    const { createMcpExpressApp } = await import('@modelcontextprotocol/sdk/server/express.js');
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { isInitializeRequest } = await import('@modelcontextprotocol/sdk/types.js');

    const app = createMcpExpressApp({ host: '0.0.0.0' });
    const transports = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();
    this.httpTransports = transports;

    app.post('/mcp', async (req: IncomingMessage & { body?: unknown; headers: Record<string, string | string[] | undefined> }, res: ServerResponse) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res, (req as unknown as { body: unknown }).body);
        return;
      }

      if (!sessionId && isInitializeRequest((req as unknown as { body: unknown }).body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            transports.set(sid, transport);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) transports.delete(sid);
        };
        const server = this.createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, (req as unknown as { body: unknown }).body);
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      }));
    });

    app.get('/mcp', async (req: IncomingMessage & { headers: Record<string, string | string[] | undefined> }, res: ServerResponse) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400).end('Invalid or missing session ID');
        return;
      }
      await transports.get(sessionId)!.handleRequest(req, res);
    });

    app.delete('/mcp', async (req: IncomingMessage & { headers: Record<string, string | string[] | undefined> }, res: ServerResponse) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400).end('Invalid or missing session ID');
        return;
      }
      await transports.get(sessionId)!.handleRequest(req, res);
    });

    this.httpServer = app.listen(port, () => {
      log.info({ port }, 'mcp-hitl-wrapper HTTP server listening');
    });
  }

  private registerHandlers(server: Server): void {
    // List tools: return all exposed tools with their original schemas
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.upstreamManager.getExposedTools();
      return { tools };
    });

    // Call tool: proxy to upstream with HITL and access control
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return this.handleToolCall(name, (args ?? {}) as Record<string, unknown>);
    });
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

    // Track who approved for audit (BUG 9: use actual decidedBy)
    let approvedBy: string | undefined;

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

        approvedBy = response.decidedBy;
        log.info({ mcpName, toolName, decidedBy: approvedBy }, 'HITL approved');
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
      const decision = approvedBy ? 'approved' : 'passthrough';

      this.logAudit({
        mcpName, toolName, params: cleanArgs, decision,
        decidedBy: approvedBy ?? 'system',
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
      // BUG 16: Log 'error' not 'passthrough' for upstream failures
      const latency = Date.now() - startTime;
      this.logAudit({
        mcpName, toolName, params: cleanArgs, decision: 'error',
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
    decision: AuditDecision;
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
        decision: opts.decision,
        decided_by: opts.decidedBy,
        latency_ms: opts.latency,
      });
    } catch (err) {
      log.error({ err }, 'Failed to write audit log');
    }
  }

  async stop(): Promise<void> {
    log.info('Shutting down mcp-hitl-wrapper server');

    if (this.auditCleanupTimer) {
      clearInterval(this.auditCleanupTimer);
      this.auditCleanupTimer = null;
    }

    this.discovery?.stop();

    if (this.hitlManager) {
      await this.hitlManager.close();
    }

    await this.upstreamManager.close();

    if (this.auditDb) {
      this.auditDb.close();
    }

    // Close HTTP transports if running in HTTP mode
    if (this.httpTransports) {
      for (const transport of this.httpTransports.values()) {
        await transport.close();
      }
      this.httpTransports.clear();
      this.httpTransports = null;
    }

    // Close HTTP server if running
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    // Close stdio server if running
    if (this.server) {
      await this.server.close();
      this.server = null;
    }

    log.info('Server shutdown complete');
  }
}
