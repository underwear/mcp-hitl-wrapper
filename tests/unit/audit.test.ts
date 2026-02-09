import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';
import { AuditDb } from '../../src/audit/db.js';

describe('AuditDb', () => {
  let db: AuditDb;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `audit-test-${Date.now()}.db`);
    db = new AuditDb(dbPath);
  });

  afterEach(() => {
    db.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    try { unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
    try { unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
  });

  it('should insert and query records', () => {
    db.insert({
      timestamp: '2025-01-01T00:00:00.000Z',
      agent: 'test-agent',
      mcp: 'slack',
      tool: 'chat_postMessage',
      params: '{"channel":"#general"}',
      reason: 'test reason',
      content: 'Hello world',
      decision: 'approved',
      decided_by: 'igor',
      latency_ms: 1500,
    });

    const records = db.query({ last: 10 });
    expect(records).toHaveLength(1);
    expect(records[0].mcp).toBe('slack');
    expect(records[0].tool).toBe('chat_postMessage');
    expect(records[0].decision).toBe('approved');
    expect(records[0].decided_by).toBe('igor');
    expect(records[0].latency_ms).toBe(1500);
  });

  it('should filter by tool', () => {
    db.insert({
      timestamp: '2025-01-01T00:00:00.000Z',
      agent: null, mcp: 'slack', tool: 'chat_postMessage',
      params: '{}', reason: null, content: null,
      decision: 'approved', decided_by: 'igor', latency_ms: 100,
    });
    db.insert({
      timestamp: '2025-01-01T00:00:00.000Z',
      agent: null, mcp: 'slack', tool: 'chat_delete',
      params: '{}', reason: null, content: null,
      decision: 'rejected', decided_by: 'igor', latency_ms: 200,
    });

    const records = db.query({ tool: 'chat_delete' });
    expect(records).toHaveLength(1);
    expect(records[0].tool).toBe('chat_delete');
  });

  it('should filter by mcp', () => {
    db.insert({
      timestamp: '2025-01-01T00:00:00.000Z',
      agent: null, mcp: 'slack', tool: 'test',
      params: '{}', reason: null, content: null,
      decision: 'passthrough', decided_by: 'system', latency_ms: 50,
    });
    db.insert({
      timestamp: '2025-01-01T00:00:00.000Z',
      agent: null, mcp: 'github', tool: 'test',
      params: '{}', reason: null, content: null,
      decision: 'passthrough', decided_by: 'system', latency_ms: 50,
    });

    const records = db.query({ mcp: 'github' });
    expect(records).toHaveLength(1);
    expect(records[0].mcp).toBe('github');
  });

  it('should filter by since', () => {
    db.insert({
      timestamp: '2025-01-01T00:00:00.000Z',
      agent: null, mcp: 'test', tool: 'old',
      params: '{}', reason: null, content: null,
      decision: 'passthrough', decided_by: 'system', latency_ms: 0,
    });
    db.insert({
      timestamp: '2025-06-01T00:00:00.000Z',
      agent: null, mcp: 'test', tool: 'new',
      params: '{}', reason: null, content: null,
      decision: 'passthrough', decided_by: 'system', latency_ms: 0,
    });

    const records = db.query({ since: '2025-03-01T00:00:00.000Z' });
    expect(records).toHaveLength(1);
    expect(records[0].tool).toBe('new');
  });

  it('should respect last limit', () => {
    for (let i = 0; i < 10; i++) {
      db.insert({
        timestamp: new Date(2025, 0, i + 1).toISOString(),
        agent: null, mcp: 'test', tool: `tool_${i}`,
        params: '{}', reason: null, content: null,
        decision: 'passthrough', decided_by: 'system', latency_ms: 0,
      });
    }

    const records = db.query({ last: 3 });
    expect(records).toHaveLength(3);
  });

  it('should cleanup old records', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);

    db.insert({
      timestamp: oldDate.toISOString(),
      agent: null, mcp: 'test', tool: 'old',
      params: '{}', reason: null, content: null,
      decision: 'passthrough', decided_by: 'system', latency_ms: 0,
    });
    db.insert({
      timestamp: new Date().toISOString(),
      agent: null, mcp: 'test', tool: 'new',
      params: '{}', reason: null, content: null,
      decision: 'passthrough', decided_by: 'system', latency_ms: 0,
    });

    const deleted = db.cleanup(90);
    expect(deleted).toBe(1);

    const records = db.query({});
    expect(records).toHaveLength(1);
    expect(records[0].tool).toBe('new');
  });

  it('should export all records', () => {
    for (let i = 0; i < 5; i++) {
      db.insert({
        timestamp: new Date().toISOString(),
        agent: null, mcp: 'test', tool: `tool_${i}`,
        params: '{}', reason: null, content: null,
        decision: 'passthrough', decided_by: 'system', latency_ms: 0,
      });
    }

    const all = db.exportAll();
    expect(all).toHaveLength(5);
  });
});
