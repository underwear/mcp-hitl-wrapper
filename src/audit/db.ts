import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getLogger } from '../utils/logger.js';

const log = getLogger('audit');

export interface AuditRecord {
  id?: number;
  timestamp: string;
  agent: string | null;
  mcp: string;
  tool: string;
  params: string;
  reason: string | null;
  content: string | null;
  decision: 'approved' | 'rejected' | 'timeout' | 'passthrough' | 'blocked' | 'error';
  decided_by: string;
  latency_ms: number;
}

export class AuditDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
    log.info({ dbPath }, 'Audit database initialized');
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        agent TEXT,
        mcp TEXT NOT NULL,
        tool TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        reason TEXT,
        content TEXT,
        decision TEXT NOT NULL,
        decided_by TEXT NOT NULL DEFAULT 'system',
        latency_ms INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_mcp_tool ON audit_log(mcp, tool);
      CREATE INDEX IF NOT EXISTS idx_audit_decision ON audit_log(decision);
    `);
  }

  insert(record: Omit<AuditRecord, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO audit_log (timestamp, agent, mcp, tool, params, reason, content, decision, decided_by, latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      record.timestamp,
      record.agent,
      record.mcp,
      record.tool,
      record.params,
      record.reason,
      record.content,
      record.decision,
      record.decided_by,
      record.latency_ms,
    );
    return result.lastInsertRowid as number;
  }

  query(opts: {
    last?: number;
    tool?: string;
    mcp?: string;
    since?: string;
    decision?: string;
  }): AuditRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.tool) {
      conditions.push('tool = ?');
      params.push(opts.tool);
    }
    if (opts.mcp) {
      conditions.push('mcp = ?');
      params.push(opts.mcp);
    }
    if (opts.since) {
      conditions.push('timestamp >= ?');
      params.push(opts.since);
    }
    if (opts.decision) {
      conditions.push('decision = ?');
      params.push(opts.decision);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.last ? 'LIMIT ?' : '';
    if (opts.last) params.push(opts.last);

    const sql = `SELECT * FROM audit_log ${where} ORDER BY id DESC ${limit}`;
    return this.db.prepare(sql).all(...params) as AuditRecord[];
  }

  cleanup(retentionDays: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const stmt = this.db.prepare('DELETE FROM audit_log WHERE timestamp < ?');
    const result = stmt.run(cutoff.toISOString());
    const deleted = result.changes;
    if (deleted > 0) {
      log.info({ deleted, retentionDays }, 'Audit log cleanup completed');
    }
    return deleted;
  }

  exportAll(opts?: { mcp?: string; tool?: string; since?: string }): AuditRecord[] {
    return this.query({ ...opts, last: undefined });
  }

  close(): void {
    this.db.close();
    log.info('Audit database closed');
  }
}
