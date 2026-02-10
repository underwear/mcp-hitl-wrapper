import { randomUUID } from 'node:crypto';
import type { Config, DestinationConfig, HitlToolConfig } from '../config/schema.js';
import type { HitlDriver, HitlRequest, HitlResponse } from './drivers/interface.js';
import { TelegramDriver } from './drivers/telegram.js';
import { parseDuration } from '../utils/prefix.js';
import { getLogger } from '../utils/logger.js';

const log = getLogger('hitl:manager');

interface PendingRequest {
  request: HitlRequest;
  messageId: string;
  driverName: string;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  resolve: (response: HitlResponse) => void;
}

export class HitlManager {
  private drivers = new Map<string, HitlDriver>();
  private pending = new Map<string, PendingRequest>();

  constructor(private config: Config) {}

  async start(): Promise<void> {
    for (const [name, destConfig] of Object.entries(this.config.destinations)) {
      const driver = this.createDriver(destConfig);
      driver.onResponse((requestId, response) => this.handleResponse(requestId, response));
      await driver.start();
      this.drivers.set(name, driver);
      log.info({ name, driver: destConfig.driver }, `HITL destination started: ${name}`);
    }
  }

  private createDriver(config: DestinationConfig): HitlDriver {
    switch (config.driver) {
      case 'telegram':
        return new TelegramDriver(config);
      default:
        throw new Error(`Unknown HITL driver: ${(config as { driver: string }).driver}`);
    }
  }

  getHitlConfig(mcpName: string, toolName: string): HitlToolConfig | null {
    return this.config.hitl.tools[mcpName]?.[toolName] ?? null;
  }

  requiresApproval(mcpName: string, toolName: string): boolean {
    return this.getHitlConfig(mcpName, toolName) !== null;
  }

  async requestApproval(opts: {
    mcpName: string;
    toolName: string;
    params: Record<string, unknown>;
    agent?: string;
    reason?: string;
    content?: string;
  }): Promise<HitlResponse> {
    const hitlConfig = this.getHitlConfig(opts.mcpName, opts.toolName);
    const destinationName = hitlConfig?.destination ?? this.config.hitl.defaultDestination;
    const timeoutStr = hitlConfig?.timeout ?? this.config.hitl.defaultTimeout;
    const timeout = parseDuration(timeoutStr, 1000);

    const driver = this.drivers.get(destinationName);
    if (!driver) {
      throw new Error(`HITL destination not found: ${destinationName}`);
    }

    const request: HitlRequest = {
      id: randomUUID(),
      agent: opts.agent,
      mcpName: opts.mcpName,
      toolName: opts.toolName,
      params: opts.params,
      reason: opts.reason,
      content: opts.content,
      timeout,
    };

    log.info(
      { requestId: request.id, mcpName: opts.mcpName, toolName: opts.toolName, timeout },
      'HITL approval requested',
    );

    const messageId = await driver.sendRequest(request);

    return new Promise<HitlResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.handleTimeout(request.id);
      }, timeout);

      this.pending.set(request.id, {
        request,
        messageId,
        driverName: destinationName,
        timer,
        startedAt: Date.now(),
        resolve,
      });
    });
  }

  private handleResponse(requestId: string, response: HitlResponse): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      log.warn({ requestId }, 'Response received for unknown request');
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(requestId);

    const elapsed = Date.now() - pending.startedAt;
    log.info(
      { requestId, decision: response.decision, decidedBy: response.decidedBy, elapsed },
      'HITL decision received',
    );

    const driver = this.drivers.get(pending.driverName);
    driver?.updateMessage(pending.messageId, {
      decision: response.decision,
      decidedBy: response.decidedBy,
      elapsed,
    }).catch((err) => log.warn({ err }, 'Failed to update HITL message'));

    pending.resolve(response);
  }

  private handleTimeout(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;

    this.pending.delete(requestId);
    const elapsed = Date.now() - pending.startedAt;

    log.info({ requestId, elapsed }, 'HITL request timed out');

    const driver = this.drivers.get(pending.driverName);
    driver?.updateMessage(pending.messageId, {
      decision: 'timeout',
      decidedBy: 'system',
      elapsed,
    }).catch((err) => log.warn({ err }, 'Failed to update timeout message'));

    pending.resolve({ decision: 'timeout', decidedBy: 'system' });
  }

  async rejectAllPending(): Promise<void> {
    // Snapshot and clear to avoid mutation during iteration
    const snapshot = [...this.pending.values()];
    this.pending.clear();

    for (const pending of snapshot) {
      clearTimeout(pending.timer);
      const elapsed = Date.now() - pending.startedAt;

      const driver = this.drivers.get(pending.driverName);
      driver?.updateMessage(pending.messageId, {
        decision: 'rejected',
        decidedBy: 'system (shutdown)',
        elapsed,
      }).catch(() => {});

      pending.resolve({ decision: 'rejected', decidedBy: 'system (shutdown)' });
    }
  }

  async close(): Promise<void> {
    await this.rejectAllPending();
    for (const driver of this.drivers.values()) {
      await driver.close();
    }
    this.drivers.clear();
  }
}
