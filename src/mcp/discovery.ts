import type { Config } from '../config/schema.js';
import { checkToolAccess } from './access.js';
import type { UpstreamManager } from './upstream.js';
import { parseDuration } from '../utils/prefix.js';
import { getLogger } from '../utils/logger.js';

const log = getLogger('discovery');

export interface DiscoveryResult {
  mcpName: string;
  newTools: string[];
  removedTools: string[];
}

export class DiscoveryService {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private knownTools = new Map<string, Set<string>>();

  constructor(
    private upstreamManager: UpstreamManager,
    private config: Config,
    private onNewTools?: (result: DiscoveryResult) => void,
  ) {}

  start(): void {
    for (const [mcpName, mcpConfig] of Object.entries(this.config.mcps)) {
      if (!mcpConfig.discovery.enabled) continue;

      const upstream = this.upstreamManager.getUpstream(mcpName);
      if (!upstream) continue;

      this.knownTools.set(mcpName, new Set(upstream.tools.map((t) => t.name)));

      const interval = parseDuration(mcpConfig.discovery.pollInterval);
      log.info({ mcpName, interval }, `Starting discovery polling for ${mcpName}`);

      const timer = setInterval(() => this.poll(mcpName), interval);
      this.timers.set(mcpName, timer);
    }
  }

  private async poll(mcpName: string): Promise<void> {
    try {
      const tools = await this.upstreamManager.refreshTools(mcpName);
      const currentNames = new Set(tools.map((t) => t.name));
      const known = this.knownTools.get(mcpName) ?? new Set();

      const newTools = [...currentNames].filter((t) => !known.has(t));
      const removedTools = [...known].filter((t) => !currentNames.has(t));

      if (newTools.length > 0 || removedTools.length > 0) {
        const mcpConfig = this.config.mcps[mcpName];
        const blockedNew = newTools.filter(
          (t) => checkToolAccess(mcpConfig.tools, t) === 'blocked',
        );
        const allowedNew = newTools.filter(
          (t) => checkToolAccess(mcpConfig.tools, t) === 'allowed',
        );

        log.info(
          { mcpName, newTools, removedTools, blockedNew, allowedNew },
          `Discovery: tools changed in ${mcpName}`,
        );

        this.knownTools.set(mcpName, currentNames);
        this.onNewTools?.({ mcpName, newTools, removedTools });
      }
    } catch (err) {
      log.error({ mcpName, err }, `Discovery poll failed for ${mcpName}`);
    }
  }

  async discoverAll(): Promise<Map<string, string[]>> {
    const results = new Map<string, string[]>();
    for (const upstream of this.upstreamManager.getAllUpstreams()) {
      try {
        const tools = await this.upstreamManager.refreshTools(upstream.name);
        results.set(upstream.name, tools.map((t) => t.name));
      } catch (err) {
        log.error({ name: upstream.name, err }, `Failed to discover tools for ${upstream.name}`);
        results.set(upstream.name, []);
      }
    }
    return results;
  }

  async diff(): Promise<Map<string, { allowed: string[]; blocked: string[]; hitl: string[] }>> {
    const results = new Map<string, { allowed: string[]; blocked: string[]; hitl: string[] }>();
    const hitlTools = this.config.hitl.tools;

    for (const [mcpName, mcpConfig] of Object.entries(this.config.mcps)) {
      const upstream = this.upstreamManager.getUpstream(mcpName);
      if (!upstream) continue;

      const allowed: string[] = [];
      const blocked: string[] = [];
      const hitl: string[] = [];

      for (const tool of upstream.tools) {
        const access = checkToolAccess(mcpConfig.tools, tool.name);
        if (access === 'blocked') {
          blocked.push(tool.name);
        } else {
          allowed.push(tool.name);
          if (hitlTools[mcpName]?.[tool.name]) {
            hitl.push(tool.name);
          }
        }
      }

      results.set(mcpName, { allowed, blocked, hitl });
    }
    return results;
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}
