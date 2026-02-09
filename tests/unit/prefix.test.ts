import { describe, it, expect } from 'vitest';
import { prefixToolName, unprefixToolName, parseDuration } from '../../src/utils/prefix.js';

describe('prefixToolName', () => {
  it('should prefix tool name with mcp name', () => {
    expect(prefixToolName('slack', 'chat_postMessage')).toBe('slack__chat_postMessage');
  });

  it('should handle empty tool name', () => {
    expect(prefixToolName('slack', '')).toBe('slack__');
  });

  it('should handle mcp name with special chars', () => {
    expect(prefixToolName('jira-cloud', 'search')).toBe('jira-cloud__search');
  });
});

describe('unprefixToolName', () => {
  it('should split prefixed name into mcp and tool', () => {
    const result = unprefixToolName('slack__chat_postMessage');
    expect(result).toEqual({ mcpName: 'slack', toolName: 'chat_postMessage' });
  });

  it('should handle mcp name with hyphens', () => {
    const result = unprefixToolName('jira-cloud__search');
    expect(result).toEqual({ mcpName: 'jira-cloud', toolName: 'search' });
  });

  it('should return null for names without separator', () => {
    expect(unprefixToolName('chat_postMessage')).toBeNull();
  });

  it('should handle tool names containing underscores', () => {
    const result = unprefixToolName('github__create_pull_request');
    expect(result).toEqual({ mcpName: 'github', toolName: 'create_pull_request' });
  });

  it('should handle double underscore in tool name', () => {
    const result = unprefixToolName('mcp__tool__with__underscores');
    expect(result).toEqual({ mcpName: 'mcp', toolName: 'tool__with__underscores' });
  });
});

describe('parseDuration', () => {
  it('should parse milliseconds', () => {
    expect(parseDuration('500ms')).toBe(500);
  });

  it('should parse seconds', () => {
    expect(parseDuration('30s')).toBe(30000);
  });

  it('should parse minutes', () => {
    expect(parseDuration('3m')).toBe(180000);
  });

  it('should parse hours', () => {
    expect(parseDuration('1h')).toBe(3600000);
  });

  it('should throw on invalid duration', () => {
    expect(() => parseDuration('abc')).toThrow('Invalid duration');
    expect(() => parseDuration('3')).toThrow('Invalid duration');
    expect(() => parseDuration('3d')).toThrow('Invalid duration');
  });
});
