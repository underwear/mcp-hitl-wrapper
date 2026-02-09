import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HitlDriver, HitlRequest, HitlResponse, MessageUpdate } from '../../src/hitl/drivers/interface.js';

// Mock driver for testing HITL flow
class MockHitlDriver implements HitlDriver {
  private callback?: (messageId: string, response: HitlResponse) => void;
  public sentRequests: HitlRequest[] = [];
  public updates: { messageId: string; update: MessageUpdate }[] = [];
  private autoResponse?: HitlResponse;
  private autoDelay: number = 0;

  setAutoResponse(response: HitlResponse, delayMs = 0) {
    this.autoResponse = response;
    this.autoDelay = delayMs;
  }

  async start(): Promise<void> {}

  async sendRequest(request: HitlRequest): Promise<string> {
    this.sentRequests.push(request);
    const messageId = `msg-${this.sentRequests.length}`;

    if (this.autoResponse) {
      const response = this.autoResponse;
      setTimeout(() => {
        this.callback?.(request.id, response);
      }, this.autoDelay);
    }

    return messageId;
  }

  async updateMessage(messageId: string, update: MessageUpdate): Promise<void> {
    this.updates.push({ messageId, update });
  }

  onResponse(callback: (messageId: string, response: HitlResponse) => void): void {
    this.callback = callback;
  }

  simulateResponse(requestId: string, response: HitlResponse): void {
    this.callback?.(requestId, response);
  }

  async close(): Promise<void> {}
}

describe('MockHitlDriver', () => {
  let driver: MockHitlDriver;

  beforeEach(() => {
    driver = new MockHitlDriver();
  });

  it('should track sent requests', async () => {
    await driver.start();
    const request: HitlRequest = {
      id: 'test-1',
      mcpName: 'slack',
      toolName: 'chat_postMessage',
      params: { channel: '#general', text: 'hello' },
      timeout: 60000,
    };

    const messageId = await driver.sendRequest(request);
    expect(messageId).toBe('msg-1');
    expect(driver.sentRequests).toHaveLength(1);
    expect(driver.sentRequests[0].id).toBe('test-1');
  });

  it('should handle auto-approve response', async () => {
    driver.setAutoResponse({ decision: 'approved', decidedBy: 'tester' }, 10);

    const responsePromise = new Promise<HitlResponse>((resolve) => {
      driver.onResponse((_msgId, response) => {
        resolve(response);
      });
    });

    await driver.sendRequest({
      id: 'test-2',
      mcpName: 'slack',
      toolName: 'test',
      params: {},
      timeout: 60000,
    });

    const response = await responsePromise;
    expect(response.decision).toBe('approved');
    expect(response.decidedBy).toBe('tester');
  });

  it('should handle manual response simulation', async () => {
    const responsePromise = new Promise<HitlResponse>((resolve) => {
      driver.onResponse((_msgId, response) => {
        resolve(response);
      });
    });

    driver.simulateResponse('test-3', { decision: 'rejected', decidedBy: 'admin' });

    const response = await responsePromise;
    expect(response.decision).toBe('rejected');
  });

  it('should track message updates', async () => {
    await driver.updateMessage('msg-1', {
      decision: 'approved',
      decidedBy: 'tester',
      elapsed: 5000,
    });

    expect(driver.updates).toHaveLength(1);
    expect(driver.updates[0].messageId).toBe('msg-1');
    expect(driver.updates[0].update.decision).toBe('approved');
  });
});

describe('HITL timeout behavior', () => {
  it('should timeout after configured duration', async () => {
    vi.useFakeTimers();

    let resolved = false;
    const promise = new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        resolved = true;
        resolve('timeout');
      }, 3000);
      // Ensure timer ref doesn't keep node alive in real code
      if (timer.unref) timer.unref();
    });

    expect(resolved).toBe(false);
    vi.advanceTimersByTime(3000);
    const result = await promise;
    expect(result).toBe('timeout');
    expect(resolved).toBe(true);

    vi.useRealTimers();
  });
});
