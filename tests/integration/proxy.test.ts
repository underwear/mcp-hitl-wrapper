import { describe, it, expect } from 'vitest';
import { checkToolAccess } from '../../src/mcp/access.js';
import { prefixToolName, unprefixToolName } from '../../src/utils/prefix.js';
import type { ToolsConfig } from '../../src/config/schema.js';

describe('Tool Resolution Flow (integration)', () => {
  // Simulates the full tool resolution flow described in TASK.md

  const mcpConfigs: Record<string, { tools: ToolsConfig }> = {
    slack: { tools: '*' },
    github: { tools: { block: ['delete_repo', 'delete_branch'] } },
    'jira-cloud': { tools: { allow: ['search', 'get_issue', 'create_issue'] } },
  };

  const hitlTools: Record<string, Record<string, object>> = {
    slack: { chat_postMessage: {}, chat_delete: {} },
    github: { create_issue: {} },
    'jira-cloud': { create_issue: {} },
  };

  function resolveToolCall(prefixedName: string): {
    mcpName: string;
    toolName: string;
    access: 'allowed' | 'blocked';
    requiresHitl: boolean;
  } | null {
    const parsed = unprefixToolName(prefixedName);
    if (!parsed) return null;

    const { mcpName, toolName } = parsed;
    const mcpConfig = mcpConfigs[mcpName];
    if (!mcpConfig) return null;

    const access = checkToolAccess(mcpConfig.tools, toolName);
    const requiresHitl = !!hitlTools[mcpName]?.[toolName];

    return { mcpName, toolName, access, requiresHitl };
  }

  // Slack: wildcard mode
  describe('slack (wildcard tools)', () => {
    it('should allow chat_postMessage with HITL', () => {
      const result = resolveToolCall('slack__chat_postMessage');
      expect(result).toEqual({
        mcpName: 'slack',
        toolName: 'chat_postMessage',
        access: 'allowed',
        requiresHitl: true,
      });
    });

    it('should allow channels_list as passthrough', () => {
      const result = resolveToolCall('slack__channels_list');
      expect(result).toEqual({
        mcpName: 'slack',
        toolName: 'channels_list',
        access: 'allowed',
        requiresHitl: false,
      });
    });
  });

  // GitHub: block mode
  describe('github (block mode)', () => {
    it('should block delete_repo', () => {
      const result = resolveToolCall('github__delete_repo');
      expect(result?.access).toBe('blocked');
    });

    it('should block delete_branch', () => {
      const result = resolveToolCall('github__delete_branch');
      expect(result?.access).toBe('blocked');
    });

    it('should allow create_issue with HITL', () => {
      const result = resolveToolCall('github__create_issue');
      expect(result).toEqual({
        mcpName: 'github',
        toolName: 'create_issue',
        access: 'allowed',
        requiresHitl: true,
      });
    });

    it('should allow list_repos as passthrough', () => {
      const result = resolveToolCall('github__list_repos');
      expect(result).toEqual({
        mcpName: 'github',
        toolName: 'list_repos',
        access: 'allowed',
        requiresHitl: false,
      });
    });
  });

  // Jira: allow mode
  describe('jira-cloud (allow mode)', () => {
    it('should allow search as passthrough', () => {
      const result = resolveToolCall('jira-cloud__search');
      expect(result).toEqual({
        mcpName: 'jira-cloud',
        toolName: 'search',
        access: 'allowed',
        requiresHitl: false,
      });
    });

    it('should allow create_issue with HITL', () => {
      const result = resolveToolCall('jira-cloud__create_issue');
      expect(result?.access).toBe('allowed');
      expect(result?.requiresHitl).toBe(true);
    });

    it('should block unknown tools (whitelist mode)', () => {
      const result = resolveToolCall('jira-cloud__delete_issue');
      expect(result?.access).toBe('blocked');
    });

    it('should block bulk_update (not in allow list)', () => {
      const result = resolveToolCall('jira-cloud__bulk_update');
      expect(result?.access).toBe('blocked');
    });
  });

  // Edge cases
  describe('edge cases', () => {
    it('should return null for unprefixed tool name', () => {
      const result = resolveToolCall('chat_postMessage');
      expect(result).toBeNull();
    });

    it('should return null for unknown MCP', () => {
      const result = resolveToolCall('unknown__tool');
      expect(result).toBeNull();
    });
  });

  // Prefixing round-trip
  describe('prefix round-trip', () => {
    it('should prefix and unprefix correctly', () => {
      const prefixed = prefixToolName('slack', 'chat_postMessage');
      const result = unprefixToolName(prefixed);
      expect(result).toEqual({ mcpName: 'slack', toolName: 'chat_postMessage' });
    });

    it('should handle hyphenated MCP names', () => {
      const prefixed = prefixToolName('jira-cloud', 'create_issue');
      expect(prefixed).toBe('jira-cloud__create_issue');
      const result = unprefixToolName(prefixed);
      expect(result).toEqual({ mcpName: 'jira-cloud', toolName: 'create_issue' });
    });
  });
});
