import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigSchema } from '../../src/config/schema.js';
import { substituteEnvVars, loadConfig } from '../../src/config/loader.js';

describe('ConfigSchema', () => {
  it('should parse minimal valid config', () => {
    const config = ConfigSchema.parse({
      mcps: {
        test: {
          command: 'echo',
          args: ['hello'],
        },
      },
    });

    expect(config.server.name).toBe('mcp-hitl-wrapper');
    expect(config.mcps.test.transport).toBe('stdio');
    expect(config.mcps.test.tools).toBe('*');
  });

  it('should parse full config', () => {
    const config = ConfigSchema.parse({
      server: { name: 'my-wrapper', version: '2.0.0' },
      destinations: {
        default: { driver: 'telegram', botToken: 'tok', chatId: '123' },
      },
      mcps: {
        slack: {
          transport: 'stdio',
          command: 'npx',
          args: ['@modelcontextprotocol/server-slack'],
          tools: '*',
        },
        jira: {
          transport: 'sse',
          url: 'https://mcp.example.com/jira',
          tools: { allow: ['search'] },
        },
      },
      hitl: {
        defaultDestination: 'default',
        defaultTimeout: '5m',
        tools: {
          slack: {
            chat_postMessage: { timeout: '2m' },
          },
        },
      },
      audit: { enabled: true, dbPath: './audit.db', retentionDays: 30 },
      logging: { level: 'debug', format: 'pretty' },
    });

    expect(config.server.name).toBe('my-wrapper');
    expect(config.mcps.slack.transport).toBe('stdio');
    expect(config.mcps.jira.transport).toBe('sse');
    expect(config.hitl.defaultTimeout).toBe('5m');
    expect(config.audit.retentionDays).toBe(30);
  });

  it('should reject invalid transport', () => {
    expect(() =>
      ConfigSchema.parse({
        mcps: {
          test: { transport: 'invalid', command: 'echo' },
        },
      }),
    ).toThrow();
  });

  it('should reject invalid duration format', () => {
    expect(() =>
      ConfigSchema.parse({
        mcps: { test: { command: 'echo' } },
        hitl: { defaultTimeout: 'invalid' },
      }),
    ).toThrow();
  });

  it('should default tools to wildcard', () => {
    const config = ConfigSchema.parse({
      mcps: { test: { command: 'echo' } },
    });
    expect(config.mcps.test.tools).toBe('*');
  });

  it('should parse block list tools config', () => {
    const config = ConfigSchema.parse({
      mcps: {
        test: {
          command: 'echo',
          tools: { block: ['dangerous_tool'] },
        },
      },
    });
    expect(config.mcps.test.tools).toEqual({ block: ['dangerous_tool'] });
  });

  it('should parse allow list tools config', () => {
    const config = ConfigSchema.parse({
      mcps: {
        test: {
          command: 'echo',
          tools: { allow: ['safe_tool'] },
        },
      },
    });
    expect(config.mcps.test.tools).toEqual({ allow: ['safe_tool'] });
  });

  it('should reject MCP names containing double underscore', () => {
    expect(() =>
      ConfigSchema.parse({
        mcps: {
          'my__bad': { command: 'echo' },
        },
      }),
    ).toThrow('double underscore');
  });

  it('should auto-detect SSE transport when url is present without transport', () => {
    const config = ConfigSchema.parse({
      mcps: {
        remote: {
          url: 'https://mcp.example.com/api',
        },
      },
    });
    expect(config.mcps.remote.transport).toBe('sse');
  });

  it('should auto-detect stdio transport when command is present without transport', () => {
    const config = ConfigSchema.parse({
      mcps: {
        local: { command: 'echo' },
      },
    });
    expect(config.mcps.local.transport).toBe('stdio');
  });

  it('should reject invalid HITL destination references', () => {
    expect(() =>
      ConfigSchema.parse({
        destinations: {
          default: { driver: 'telegram', botToken: 'tok', chatId: '123' },
        },
        mcps: { test: { command: 'echo' } },
        hitl: {
          defaultDestination: 'nonexistent',
          tools: {},
        },
      }),
    ).toThrow('not found in destinations');
  });
});

describe('substituteEnvVars', () => {
  beforeEach(() => {
    process.env.TEST_VAR = 'hello';
    process.env.TEST_NUM = '42';
  });

  afterEach(() => {
    delete process.env.TEST_VAR;
    delete process.env.TEST_NUM;
  });

  it('should substitute env vars in strings', () => {
    expect(substituteEnvVars('${TEST_VAR}')).toBe('hello');
    expect(substituteEnvVars('prefix_${TEST_VAR}_suffix')).toBe('prefix_hello_suffix');
  });

  it('should substitute in nested objects', () => {
    const result = substituteEnvVars({
      a: '${TEST_VAR}',
      b: { c: '${TEST_NUM}' },
    });
    expect(result).toEqual({ a: 'hello', b: { c: '42' } });
  });

  it('should substitute in arrays', () => {
    const result = substituteEnvVars(['${TEST_VAR}', '${TEST_NUM}']);
    expect(result).toEqual(['hello', '42']);
  });

  it('should leave non-existent vars as-is', () => {
    expect(substituteEnvVars('${DOES_NOT_EXIST}')).toBe('${DOES_NOT_EXIST}');
  });

  it('should handle non-string types', () => {
    expect(substituteEnvVars(42)).toBe(42);
    expect(substituteEnvVars(true)).toBe(true);
    expect(substituteEnvVars(null)).toBe(null);
  });
});

describe('loadConfig', () => {
  let tmpFile: string;

  beforeEach(() => {
    const dir = join(tmpdir(), 'mcp-hitl-test-' + Date.now());
    mkdirSync(dir, { recursive: true });
    tmpFile = join(dir, 'config.json');
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  it('should load and parse a config file', () => {
    writeFileSync(tmpFile, JSON.stringify({
      mcps: {
        test: { command: 'echo', args: ['hello'] },
      },
    }));

    const config = loadConfig(tmpFile);
    expect(config.mcps.test.transport).toBe('stdio');
  });

  it('should substitute env vars during loading', () => {
    process.env.TEST_CMD = 'my-command';
    writeFileSync(tmpFile, JSON.stringify({
      mcps: {
        test: { command: '${TEST_CMD}' },
      },
    }));

    const config = loadConfig(tmpFile);
    expect((config.mcps.test as { command: string }).command).toBe('my-command');
    delete process.env.TEST_CMD;
  });
});
